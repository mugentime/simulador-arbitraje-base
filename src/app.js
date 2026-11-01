import * as core from "./core.js";

const ethers = window.ethers;
const RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];
const $ = (id) => document.getElementById(id);
const fmtUsd = (v, d = 2) =>
  !isFinite(v) ? "—" : (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("es-MX", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtNum = (v, d = 2) => (!isFinite(v) ? "—" : v.toLocaleString("es-MX", { minimumFractionDigits: d, maximumFractionDigits: d }));
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const scan = (a) => `https://basescan.org/address/${a}`;

const state = {
  provider: null, rpc: null, pools: [], cycles: [], lenders: [], lastBlock: 0, history: [],
  blocksSeen: 0, blocksWithOpp: 0, log: [], busy: false, lastBlockTs: 0, chainId: null,
};

// ------------------------------------------------------------------ pipeline UI

const STAGES = ["ingesta", "estado", "deteccion", "tamano", "simulacion", "filtro", "ejecucion", "registro"];
function stage(name, text, mode = "done") {
  const el = $("st-" + name);
  if (!el) return;
  el.dataset.mode = mode;
  if (text !== undefined) el.querySelector(".st-val").textContent = text;
}
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));

// ------------------------------------------------------------------ conexión

async function connect(preferred) {
  const list = preferred ? [preferred, ...RPCS.filter((r) => r !== preferred)] : RPCS;
  for (const url of list) {
    try {
      setStatus(`Conectando a ${url}…`, "wait");
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
      const net = await withTimeout(p.send("eth_chainId", []), 6000);
      if (BigInt(net) !== core.CHAIN_ID) throw new Error("no es Base (chainId " + BigInt(net) + ")");
      state.provider = p; state.rpc = url; state.chainId = BigInt(net);
      $("rpc").value = url;
      try { localStorage.setItem("rpc", url); } catch {}
      return true;
    } catch (e) {
      console.warn("RPC falló", url, e);
    }
  }
  setStatus("No se pudo conectar a ningún RPC público de Base. Prueba con tu propio RPC.", "bad");
  return false;
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

function setStatus(text, kind = "ok") {
  $("status").textContent = text;
  $("status").dataset.kind = kind;
}

// ------------------------------------------------------------------ arranque

async function bootstrap() {
  stage("ingesta", "descubriendo pools…", "run");
  const found = await core.discoverPools(ethers, state.provider);
  stage("estado", `${found.size} pools encontrados`, "run");
  state.pools = await core.loadPools(ethers, state.provider, found);
  state.cycles = core.enumerateCycles(state.pools);
  state.lenders = await core.readLenders(ethers, state.provider);
  renderLenders();
  fillScenarioPools();
  setStatus(`Conectado a Base vía ${new URL(state.rpc).host} · ${state.pools.length} pools · ${state.cycles.length} ciclos`, "ok");
}

// ------------------------------------------------------------------ bucle por bloque

async function onBlock() {
  if (state.busy) return;
  state.busy = true;
  try {
    const n = await withTimeout(state.provider.getBlockNumber(), 8000);
    if (n <= state.lastBlock) return;
    for (const s of STAGES) stage(s, undefined, "idle");

    stage("ingesta", `bloque ${n.toLocaleString("es-MX")}`, "run"); await tick();
    const [gas] = await Promise.all([core.readGas(ethers, state.provider), core.refreshPools(ethers, state.provider, state.pools, n)]);
    stage("ingesta", `bloque ${n.toLocaleString("es-MX")}`);
    state.lastBlockTs = gas.timestamp;

    const live = state.pools.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n).length;
    stage("estado", `${live}/${state.pools.length} pools con liquidez`, "run"); await tick();
    const ethUsd = core.referenceEthUsd(state.pools);
    stage("estado", `${live}/${state.pools.length} pools con liquidez`);

    if (state.blocksSeen % 15 === 0) state.lenders = await core.readLenders(ethers, state.provider);

    stage("deteccion", `${state.cycles.length} ciclos`, "run"); await tick();
    const results = core.evaluateAll({ pools: state.pools, cycles: state.cycles, lenders: state.lenders, gas, ethUsd });
    const positiveSpread = results.filter((r) => r.amountIn > 0n).length;
    stage("deteccion", `${positiveSpread} con spread > comisiones`);
    const sized = results.find((r) => r.amountIn > 0n);
    stage("tamano", sized ? `óptimo: ${fmtUsd(sized.amountInUsd, 0)}` : "sin tamaño rentable");
    stage("simulacion", `${results.length} rutas simuladas`);
    const winners = results.filter((r) => r.profitable);
    stage("filtro", `${winners.length} pasan EV > 0`, winners.length ? "hit" : "done");
    stage("ejecucion", winners.length ? `enviaría ${winners[0].lender}` : "nada que enviar", winners.length ? "hit" : "done");

    state.blocksSeen++;
    if (winners.length) {
      state.blocksWithOpp++;
      state.log.unshift({ n, r: winners[0], ts: gas.timestamp });
      state.log = state.log.slice(0, 50);
    }
    const best = results[0];
    state.history.push({ n, net: best ? best.netUsd : NaN, gross: best ? best.grossUsd : 0, gas: best ? best.gasUsd : NaN });
    if (state.history.length > 120) state.history.shift();
    stage("registro", `${state.blocksWithOpp}/${state.blocksSeen} bloques con oportunidad`);
    state.lastBlock = n;

    state.ctx = { gas, ethUsd, results };
    renderKpis(n, gas, ethUsd, results);
    renderSim();
    renderPools(ethUsd);
    renderResults(results);
    renderLog();
    renderChart();
    if (state.blocksSeen % 15 === 1) renderLenders();
  } catch (e) {
    console.error(e);
    setStatus("Error leyendo la cadena: " + (e.shortMessage || e.message) + " · reintentando…", "bad");
  } finally {
    state.busy = false;
  }
}

// ------------------------------------------------------------------ render

function renderKpis(n, gas, ethUsd, results) {
  const gwei = (w) => Number(w) / 1e9;
  const twoHop = results.find((r) => r.hops === 2);
  $("k-block").textContent = n.toLocaleString("es-MX");
  $("k-age").textContent = `hace ${Math.max(0, Math.round(Date.now() / 1000 - gas.timestamp))} s`;
  $("k-eth").textContent = fmtUsd(ethUsd);
  $("k-gas").textContent = `${fmtNum(gwei(gas.baseFee), 4)} gwei`;
  $("k-gas-sub").textContent = `prioridad ${fmtNum(gwei(gas.priority), 4)} gwei · L1 ${fmtUsd((Number(gas.l1Fee) / 1e18) * ethUsd, 4)}`;
  $("k-cost").textContent = twoHop ? fmtUsd(twoHop.gasUsd, 4) : "—";
  const best = results[0];
  $("k-best").textContent = best ? fmtUsd(best.netUsd, 4) : "—";
  $("k-best").dataset.sign = best && best.netUsd > 0 ? "pos" : "neg";
  $("k-best-sub").textContent = best ? `${best.start} · ${best.hops} saltos · spread ${fmtNum(best.marginalBps, 2)} bps vs comisiones ${fmtNum(best.feesBps, 2)} bps` : "";
  $("k-rate").textContent = `${state.blocksWithOpp} / ${state.blocksSeen}`;
}

function pairName(p) {
  const order = ["WETH", "cbBTC", "USDC"];
  const [a, b] = [p.token0.sym, p.token1.sym].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return `${a}/${b}`;
}

function displayPrice(p) {
  const order = ["WETH", "cbBTC", "USDC"];
  const base = [p.token0.sym, p.token1.sym].sort((x, y) => order.indexOf(x) - order.indexOf(y))[0];
  return core.poolPrice(p, base);
}

function renderPools() {
  const groups = new Map();
  for (const p of state.pools) {
    const k = pairName(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const rows = [];
  for (const [pair, ps] of groups) {
    const live = ps.filter((p) => p.reserve0 > 0n);
    const prices = live.map(displayPrice).filter((x) => isFinite(x)).sort((a, b) => a - b);
    const med = prices.length ? prices[Math.floor(prices.length / 2)] : NaN;
    for (const p of ps.sort((a, b) => a.feeBps - b.feeBps)) {
      const px = p.reserve0 > 0n ? displayPrice(p) : NaN;
      const dev = isFinite(px) && isFinite(med) ? ((px - med) / med) * 10000 : NaN;
      rows.push(`<tr>
        <td>${p.dex}</td><td>${pair}</td><td>${p.kind}</td>
        <td class="num">${fmtNum(p.feeBps / 100, p.feeBps < 10 ? 3 : 2)}%</td>
        <td class="num">${isFinite(px) ? fmtNum(px, px > 100 ? 2 : 6) : "sin liquidez en rango"}</td>
        <td class="num ${Math.abs(dev) > p.feeBps ? "warn" : ""}">${isFinite(dev) ? fmtNum(dev, 2) : "—"}</td>
        <td><a href="${scan(p.address)}" target="_blank" rel="noopener">${short(p.address)}</a></td></tr>`);
    }
  }
  $("pools-body").innerHTML = rows.join("");
}

function renderLenders() {
  const f = (v, d, dec) => (v === undefined ? "—" : fmtNum(Number(v) / 10 ** d, dec));
  $("lenders-body").innerHTML = state.lenders
    .map((l) => `<tr>
      <td>${l.name}</td>
      <td class="num">${l.ok ? (l.feeBps === null ? "—" : fmtNum(Number(l.feeBps) / 100, 2) + "%") : "sin respuesta"}</td>
      <td class="num">${f(l.liquidity.WETH, 18, 2)}</td>
      <td class="num">${f(l.liquidity.USDC, 6, 0)}</td>
      <td class="num">${f(l.liquidity.cbBTC, 8, 4)}</td>
      <td><a href="${scan(l.address)}" target="_blank" rel="noopener">${short(l.address)}</a></td></tr>`)
    .join("");
}

function routeText(r) {
  let t = r.start;
  const parts = [r.start];
  for (const p of r.route) {
    const nxt = p.token0.sym === t ? p.token1.sym : p.token0.sym;
    parts.push(`<span class="hop">${p.dex} ${fmtNum(p.feeBps / 100, p.feeBps < 10 ? 3 : 2)}%</span> ${nxt}`);
    t = nxt;
  }
  return parts.join(" → ");
}

function renderResults(results) {
  $("res-body").innerHTML = results
    .slice(0, 10)
    .map((r) => `<tr class="${r.profitable ? "win" : ""}">
      <td class="route">${routeText(r)}</td>
      <td class="num">${fmtNum(r.marginalBps, 2)}</td>
      <td class="num">${fmtNum(r.feesBps, 2)}</td>
      <td class="num">${r.amountIn > 0n ? fmtUsd(r.amountInUsd, 0) : "—"}</td>
      <td class="num">${fmtUsd(r.grossUsd, 4)}</td>
      <td class="num">${fmtUsd(r.flashFeeUsd, 4)}</td>
      <td class="num">${fmtUsd(r.gasUsd, 4)}</td>
      <td class="num strong">${fmtUsd(r.netUsd, 4)}</td>
      <td>${r.lender}</td></tr>`)
    .join("");
}

function renderLog() {
  $("log").innerHTML = state.log.length
    ? state.log.map((x) => `<li><b>Bloque ${x.n.toLocaleString("es-MX")}</b> · ${routeText(x.r)} · neto <b>${fmtUsd(x.r.netUsd, 4)}</b> con ${x.r.lender}</li>`).join("")
    : `<li class="muted">Aún no aparece ningún bloque con beneficio neto positivo. Es lo esperado en pares líquidos: el spread entre pools rara vez supera la suma de comisiones y, cuando lo hace, otro bot lo cierra en el mismo bloque.</li>`;
}

// ------------------------------------------------------------------ gráfica (una serie: mejor neto por bloque)

function renderChart() {
  const svg = $("chart");
  const W = svg.clientWidth || 640, H = 180, padL = 64, padR = 12, padT = 12, padB = 24;
  const pts = state.history.filter((h) => isFinite(h.net));
  if (pts.length < 2) { svg.innerHTML = ""; return; }
  const vals = pts.map((h) => h.net);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi - lo < 1e-6) hi = lo + 1e-6;
  const X = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const path = pts.map((h, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(h.net).toFixed(1)}`).join("");
  const ticks = [lo, (lo + hi) / 2, hi];
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `
    ${ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${padL - 6}" y="${Y(t) + 4}" class="axis" text-anchor="end">${fmtUsd(t, 4)}</text>`).join("")}
    <line x1="${padL}" x2="${W - padR}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>
    <text x="${W - padR}" y="${Y(0) - 4}" class="axis" text-anchor="end">equilibrio $0</text>
    <path d="${path}" class="line"/>
    <text x="${padL}" y="${H - 6}" class="axis">bloque ${pts[0].n.toLocaleString("es-MX")}</text>
    <text x="${W - padR}" y="${H - 6}" class="axis" text-anchor="end">bloque ${pts[pts.length - 1].n.toLocaleString("es-MX")}</text>
    <line id="cross" class="cross" y1="${padT}" y2="${H - padB}" x1="-10" x2="-10"/>
    <circle id="dot" r="4" class="dot" cx="-10" cy="-10"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="hit"/>`;
  const tip = $("tip");
  svg.querySelector("#hit").onmousemove = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - padL) / (W - padL - padR)) * (pts.length - 1))));
    const h = pts[i];
    svg.querySelector("#cross").setAttribute("x1", X(i)); svg.querySelector("#cross").setAttribute("x2", X(i));
    svg.querySelector("#dot").setAttribute("cx", X(i)); svg.querySelector("#dot").setAttribute("cy", Y(h.net));
    tip.hidden = false;
    tip.style.left = Math.min(r.width - 190, (X(i) / W) * r.width + 8) + "px";
    tip.innerHTML = `<b>Bloque ${h.n.toLocaleString("es-MX")}</b><br>Neto ${fmtUsd(h.net, 4)}<br>Bruto ${fmtUsd(h.gross, 4)} · gas ${fmtUsd(h.gas, 4)}`;
  };
  svg.querySelector("#hit").onmouseleave = () => { tip.hidden = true; };
}


// ------------------------------------------------------------------ simulación de ganancias (dimensionamiento)

const sim = { routeKey: null, slider: 500, userMovedSlider: false };

function fillScenarioPools() {
  const sel = $("sim-pool");
  sel.innerHTML = `<option value="">Mercado actual (sin cambios)</option>` + state.pools
    .map((p) => `<option value="${p.address}">Venta grande en ${p.dex} ${pairName(p)} ${fmtNum(p.feeBps / 100, p.feeBps < 10 ? 3 : 2)}%</option>`)
    .join("");
}

function scenarioPools() {
  const addr = $("sim-pool").value;
  if (!addr) return null;
  const p = state.pools.find((q) => q.address === addr);
  const dir = $("sim-dir").value;
  const tok = p.token0.sym === dir ? p.token0 : p.token1;
  const amt = Number($("sim-amt").value);
  if (!(amt > 0)) return null;
  const raw = BigInt(Math.floor(amt * 10 ** Math.min(tok.decimals, 8))) * 10n ** BigInt(Math.max(0, tok.decimals - 8));
  return core.withSwap(state.pools, addr, tok.address, raw);
}

function onScenarioPoolChange() {
  const addr = $("sim-pool").value;
  const on = !!addr;
  $("sim-dir-wrap").hidden = $("sim-amt-wrap").hidden = $("sim-scn-note").hidden = !on;
  if (on) {
    const p = state.pools.find((q) => q.address === addr);
    $("sim-dir").innerHTML = [p.token0.sym, p.token1.sym].map((t) => `<option>${t}</option>`).join("");
    const dir = $("sim-dir").value;
    $("sim-amt").value = dir === "USDC" ? 150000 : dir === "WETH" ? 50 : 1;
  }
  sim.routeKey = null; sim.userMovedSlider = false;
  renderSim();
}

function simResults() {
  if (!state.ctx) return [];
  const pools = scenarioPools();
  if (!pools) return state.ctx.results;
  const cycles = core.enumerateCycles(pools);
  return core.evaluateAll({ pools, cycles, lenders: state.lenders, gas: state.ctx.gas, ethUsd: state.ctx.ethUsd });
}

function renderSim() {
  const results = simResults();
  const sel = $("sim-route");
  if (!results.length) { sel.innerHTML = ""; $("sim-chart").innerHTML = ""; $("sim-break").innerHTML = ""; return; }
  const top = results.slice(0, 15);
  if (!sim.routeKey || !top.some((r) => r.key === sim.routeKey)) { sim.routeKey = top[0].key; sim.userMovedSlider = false; }
  sel.innerHTML = top.map((r) => {
    const txt = routeText(r).replace(/<[^>]+>/g, "");
    return `<option value="${r.key}" ${r.key === sim.routeKey ? "selected" : ""}>${fmtUsd(r.netUsd, 2)} · ${txt}</option>`;
  }).join("");
  const r = top.find((x) => x.key === sim.routeKey);
  const toUsd = core.tokenToUsd(r.startTok, state.ctx.ethUsd);
  // rango de montos: alrededor del óptimo si existe; si no, todo el rango posible
  const hiX = r.amountIn > 0n ? (r.amountIn * 30n < r.cap ? r.amountIn * 30n : r.cap) : r.cap;
  const loX = r.amountIn > 0n ? r.amountIn / 3000n : r.cap / 1000000n;
  const curve = core.profitCurve(r.startTok.address, r.route, r.segs, loX, hiX, toUsd, r.gasUsd);
  if (!curve.length) return;
  // posición inicial del deslizador: el óptimo (o la mitad si no hay óptimo)
  const lo = Number(curve[0].x), hi = Number(curve[curve.length - 1].x);
  const fracOf = (x) => Math.log(Number(x) / lo) / Math.log(hi / lo);
  if (!sim.userMovedSlider) sim.slider = Math.round(1000 * (r.amountIn > 0n ? Math.min(1, Math.max(0, fracOf(r.amountIn))) : 0.5));
  $("sim-slider").value = sim.slider;
  drawSimChart(curve, r, lo, hi);
  renderBreakdown(r, lo, hi, toUsd);
  $("sim-opt").innerHTML = r.amountIn > 0n
    ? `<b>Óptimo:</b> pedir ${fmtUsd(r.amountInUsd, 0)} (${fmtTok(r.amountIn, r.startTok)}) a ${r.lender} → bruto ${fmtUsd(r.grossUsd, 4)}, flashloan ${fmtUsd(r.flashFeeUsd, 4)}, gas ${fmtUsd(r.gasUsd, 4)}, <b>neto ${fmtUsd(r.netUsd, 4)}</b>${r.netUsd > 0 ? " · el protocolo la ejecutaría." : " · no cubre el gas: no se envía."}`
    : `<b>Sin monto rentable:</b> en esta ruta cualquier préstamo pierde dinero porque el spread (${fmtNum(r.marginalBps, 2)} bps) no cubre las comisiones de los pools. El óptimo es no pedir nada.`;
}

function fmtAxis(v) {
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}k`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${a.toFixed(4)}`;
}

function fmtTok(x, tok) {
  const v = Number(x) / 10 ** tok.decimals;
  return `${fmtNum(v, v >= 100 ? 2 : v >= 1 ? 4 : 6)} ${tok.sym}`;
}

function amountAtSlider(r, lo, hi) {
  if (!sim.userMovedSlider && r.amountIn > 0n) return r.amountIn;
  return BigInt(Math.max(1, Math.floor(lo * Math.pow(hi / lo, sim.slider / 1000))));
}

function renderBreakdown(r, lo, hi, toUsd) {
  const x = amountAtSlider(r, lo, hi);
  const out = core.routeOut(x, r.startTok.address, r.route);
  const l = core.lenderFor(r.segs, x);
  const fee = l ? l.fee : 0n;
  const gross = out - x;
  const net = toUsd(gross - fee) - r.gasUsd;
  $("sim-x-label").textContent = `${fmtUsd(toUsd(x), 0)} (${fmtTok(x, r.startTok)})`;
  const row = (k, v, cls = "") => `<tr class="${cls}"><td>${k}</td><td class="num">${v}</td></tr>`;
  $("sim-break").innerHTML = [
    row("1. Pide prestado", `${fmtTok(x, r.startTok)} · ${fmtUsd(toUsd(x), 2)}`),
    row("2. Proveedor del flashloan", l ? `${l.name} (${fmtNum(Number(l.bps) / 100, 2)}%)` : "ninguno tiene tanta liquidez"),
    row("3. Recibe al final de la ruta", `${fmtTok(out, r.startTok)} · ${fmtUsd(toUsd(out), 2)}`),
    row("4. Devuelve al proveedor", `${fmtTok(x + fee, r.startTok)}`),
    row("Ganancia bruta de la ruta", fmtUsd(toUsd(gross), 4)),
    row("− Comisión del flashloan", fmtUsd(toUsd(fee), 4)),
    row("− Gas (L2 + L1)", fmtUsd(r.gasUsd, 4)),
    row("= Beneficio neto", fmtUsd(net, 4), "total"),
    row("Resultado en cadena", !l ? "revierte: no hay préstamo posible" : net > 0 ? "se ejecuta y el beneficio va al owner" : "revierte por minProfit: solo se pierde el gas si se envía"),
  ].join("");
}

function drawSimChart(curve, r, lo, hi) {
  const svg = $("sim-chart");
  const W = svg.clientWidth || 640, H = 240, padL = 58, padR = 14, padT = 16, padB = 30;
  const ys = curve.flatMap((c) => [c.netUsd, c.grossUsd]).filter(isFinite);
  const peak = Math.max(0, ...ys);
  const floor = -Math.max(peak * 1.5, r.gasUsd * 6, 1e-4); // recorta la cola: lo que importa es la zona del óptimo
  let ymin = Math.max(Math.min(0, ...ys), floor), ymax = Math.max(peak, r.gasUsd * 0.5);
  const pad = (ymax - ymin) * 0.08 || 1e-4; ymin -= pad; ymax += pad;
  const X = (x) => padL + (Math.log(Number(x) / lo) / Math.log(hi / lo)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin)) * (H - padT - padB);
  const path = (k) => curve.filter((c) => isFinite(c[k])).map((c, i) => `${i ? "L" : "M"}${X(c.x).toFixed(1)},${Y(c[k]).toFixed(1)}`).join("");
  const yt = [ymin + pad, (ymin + ymax) / 2, ymax - pad];
  const decades = [];
  for (let e = Math.ceil(Math.log10(Number(curve[0].xUsd) || 1e-9)); e <= Math.log10(Number(curve[curve.length - 1].xUsd)); e++) decades.push(10 ** e);
  const xUsdToX = (u) => { const i = curve.findIndex((c) => c.xUsd >= u); return i < 0 ? null : X(curve[i].x); };
  // cambios de proveedor (límite de liquidez)
  const switches = [];
  for (let i = 1; i < curve.length; i++) if (curve[i].lender !== curve[i - 1].lender) switches.push({ x: X(curve[i].x), name: curve[i].lender });
  const optX = r.amountIn > 0n ? X(r.amountIn) : null;
  const optY = r.amountIn > 0n ? Y(r.netUsd) : null;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs><clipPath id="sim-clip"><rect x="${padL}" y="${padT - 4}" width="${W - padL - padR}" height="${H - padT - padB + 8}"/></clipPath></defs>
    ${yt.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${padL - 6}" y="${Y(t) + 4}" class="axis" text-anchor="end">${fmtAxis(t)}</text>`).join("")}
    <line x1="${padL}" x2="${W - padR}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>
    ${decades.filter((_, i, arr) => W >= 520 || arr.length <= 4 || (arr.length - 1 - i) % 2 === 0).map((u) => { const x = xUsdToX(u); return x ? `<text x="${x}" y="${H - 10}" class="axis" text-anchor="middle">${fmtUsd(u, 0)}</text>` : ""; }).join("")}
    ${switches.map((s) => `<line x1="${s.x}" x2="${s.x}" y1="${padT}" y2="${H - padB}" class="seg"/><text x="${s.x + 4}" y="${padT + 10}" class="axis">→ ${s.name}</text>`).join("")}
    <g clip-path="url(#sim-clip)"><path d="${path("grossUsd")}" class="line2"/>
    <path d="${path("netUsd")}" class="line"/></g>
    ${optX !== null ? `<line x1="${optX}" x2="${optX}" y1="${optY}" y2="${Y(0)}" class="seg"/><circle cx="${optX}" cy="${optY}" r="5" class="opt"/><text x="${optX > W * 0.6 ? optX - 10 : optX + 10}" y="${Math.max(optY - 10, padT + 12)}" class="lbl" text-anchor="${optX > W * 0.6 ? "end" : "start"}">óptimo ${fmtAxis(r.amountInUsd)} → ${fmtAxis(r.netUsd)}</text>` : ""}
    <line id="sim-sel" class="sel" y1="${padT}" y2="${H - padB}" x1="${X(amountAtSlider(r, lo, hi))}" x2="${X(amountAtSlider(r, lo, hi))}"/>
    <circle id="sim-dot" r="4" class="dot" cx="-10" cy="-10"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="sim-hit"/>`;
  const tip = $("sim-tip");
  const hit = svg.querySelector("#sim-hit");
  hit.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    let best = curve[0];
    for (const c of curve) if (Math.abs(X(c.x) - sx) < Math.abs(X(best.x) - sx)) best = c;
    svg.querySelector("#sim-dot").setAttribute("cx", X(best.x));
    svg.querySelector("#sim-dot").setAttribute("cy", Y(best.netUsd));
    tip.hidden = false;
    tip.style.left = Math.min(rect.width - 210, (X(best.x) / W) * rect.width + 8) + "px";
    tip.innerHTML = `<b>Préstamo ${fmtUsd(best.xUsd, 0)}</b><br>Bruto ${fmtUsd(best.grossUsd, 4)}<br>Flashloan ${fmtUsd(best.feeUsd, 4)} (${best.lender})<br>Gas ${fmtUsd(best.gasUsd, 4)}<br><b>Neto ${fmtUsd(best.netUsd, 4)}</b>`;
  };
  hit.onmouseleave = () => { tip.hidden = true; svg.querySelector("#sim-dot").setAttribute("cx", -10); };
  hit.onclick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const f = (((ev.clientX - rect.left) / rect.width) * W - padL) / (W - padL - padR);
    sim.slider = Math.round(1000 * Math.min(1, Math.max(0, f)));
    sim.userMovedSlider = true;
    renderSim();
  };
}

$("sim-route").addEventListener("change", (e) => { sim.routeKey = e.target.value; sim.userMovedSlider = false; renderSim(); });
$("sim-pool").addEventListener("change", onScenarioPoolChange);
$("sim-dir").addEventListener("change", () => { sim.routeKey = null; sim.userMovedSlider = false; renderSim(); });
$("sim-amt").addEventListener("input", () => { sim.routeKey = null; sim.userMovedSlider = false; renderSim(); });
$("sim-slider").addEventListener("input", (e) => { sim.slider = Number(e.target.value); sim.userMovedSlider = true; renderSim(); });
window.addEventListener("resize", () => renderSim());

// ------------------------------------------------------------------ inicio

async function start(url) {
  state.lastBlock = 0;
  if (!(await connect(url))) return;
  try {
    await bootstrap();
  } catch (e) {
    console.error(e);
    setStatus("Falló el descubrimiento de pools: " + (e.shortMessage || e.message), "bad");
    return;
  }
  await onBlock();
}

$("rpc-form").addEventListener("submit", (e) => {
  e.preventDefault();
  start($("rpc").value.trim());
});

let saved = null;
try { saved = localStorage.getItem("rpc"); } catch {}
start(saved || undefined);
setInterval(onBlock, 1500);
setInterval(() => {
  if (state.lastBlockTs) $("k-age").textContent = `hace ${Math.max(0, Math.round(Date.now() / 1000 - state.lastBlockTs))} s`;
}, 1000);
window.addEventListener("resize", renderChart);
