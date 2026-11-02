import * as core from "./core.js";
import { accountBlock, emptyStats } from "./worker.js";

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
  session: emptyStats(),
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

const MIN_LIQ = { [core.TOKENS.WETH.address.toLowerCase()]: 5n * 10n ** 16n, [core.TOKENS.USDC.address.toLowerCase()]: 150n * 10n ** 6n };

async function bootstrap() {
  const universe = $("universe").value;
  stage("ingesta", "descubriendo pools…", "run");
  let pools;
  if (universe === "longtail") {
    const hours = Math.min(12, Math.max(0.25, Number($("hours").value) || 2));
    const lookback = Math.round((hours * 3600) / 2); // Base: 2 s por bloque
    const head = await state.provider.getBlockNumber();
    const specs = await core.scanNewPools(ethers, state.provider, {
      lookback, head,
      onProgress: (pr) => setStatus(`Escaneando ${pr.factory}: bloques ${pr.from.toLocaleString("es-MX")}–${pr.to.toLocaleString("es-MX")} · ${pr.found} pools nuevos`, "wait"),
    });
    stage("ingesta", `${specs.size} pools nuevos en ${hours} h`);
    // tokens de los pools nuevos
    const evmAddrs = [...specs.entries()].filter(([, m]) => m.kind !== "v4").map(([a]) => a);
    const toks = await core.poolTokens(ethers, state.provider, evmAddrs);
    const tokenAddrs = new Set(Object.values(core.TOKENS).map((t) => t.address));
    for (const [, m] of specs) if (m.kind === "v4") { tokenAddrs.add(m.token0); tokenAddrs.add(m.token1); }
    for (const [, [t0, t1]] of toks) { tokenAddrs.add(t0); tokenAddrs.add(t1); }
    setStatus(`Leyendo ${tokenAddrs.size} tokens…`, "wait");
    const meta = await core.tokenMeta(ethers, state.provider, [...tokenAddrs], core.TOKENS);
    for (const [sym, t] of Object.entries(core.TOKENS)) meta.set(t.address.toLowerCase(), { sym, ...t });
    // pools nuevos + pools existentes de esos tokens en todos los DEX (para cerrar ciclos)
    setStatus(`Buscando pools existentes de ${meta.size} tokens en todos los DEX…`, "wait");
    const found = new Map(specs);
    const tokenList = [...meta.values()].map((t) => t.address);
    // por lotes de tokens contra los base, para no explotar el número de pares
    const baseAddrs = Object.values(core.TOKENS).map((t) => t.address);
    const others = tokenList.filter((a) => !baseAddrs.includes(a));
    for (let i = 0; i < others.length; i += 25) {
      const part = await core.existingPools(ethers, state.provider, [...baseAddrs, ...others.slice(i, i + 25)]);
      for (const [k, v] of part) if (!found.has(k)) found.set(k, v);
    }
    stage("estado", `${found.size} pools candidatos`, "run");
    const all = await core.loadPools(ethers, state.provider, found, meta);
    pools = core.filterPools(all, baseAddrs.slice(0, 2), MIN_LIQ);
    stage("estado", `${pools.length}/${all.length} pools con liquidez mínima`);
  } else {
    const found = await core.existingPools(ethers, state.provider, Object.values(core.TOKENS).map((t) => t.address));
    stage("estado", `${found.size} pools encontrados`, "run");
    pools = await core.loadPools(ethers, state.provider, found);
  }
  state.pools = pools;
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
    accountBlock(state.session, n, gas.timestamp, results);
    renderSession();
    renderKpis(n, gas, ethUsd, results);
    $("pools-count").textContent = `(${state.pools.length})`;
    if ($("pools-box").open && state.blocksSeen % 10 === 1) renderPools(ethUsd);
    if ($("routes-box").open) renderResults(results);
    renderSim();
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

const QUOTE_RANK = { USDC: 0, WETH: 1, cbBTC: 2 };
const rank = (sym) => QUOTE_RANK[sym] ?? 9;
function baseQuote(p) {
  const [a, b] = [p.token0.sym, p.token1.sym];
  return rank(a) > rank(b) || (rank(a) === rank(b) && a > b) ? [a, b] : [b, a]; // [base, quote]
}
function pairName(p) {
  const [base, quote] = baseQuote(p);
  return `${base}/${quote}`;
}
function displayPrice(p) {
  return core.poolPrice(p, baseQuote(p)[0]);
}
function baseLiquidity(p) {
  for (const sym of ["WETH", "USDC"]) {
    const t = p.token0.sym === sym ? p.token0 : p.token1.sym === sym ? p.token1 : null;
    if (t) { const r = core.reservesFor(p, t.address)[0]; return `${fmtNum(Number(r) / 10 ** t.decimals, sym === "WETH" ? 3 : 0)} ${sym}`; }
  }
  return "—";
}
function createdAgo(p) {
  if (!p.createdBlock || !state.lastBlock) return "existente";
  const mins = ((state.lastBlock - p.createdBlock) * 2) / 60;
  return mins < 90 ? `hace ${Math.round(mins)} min` : `hace ${fmtNum(mins / 60, 1)} h`;
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
        <td class="num">${baseLiquidity(p)}</td>
        <td>${createdAgo(p)}</td>
        <td>${p.kind === "v4" ? `<a href="${scan(p.manager)}" target="_blank" rel="noopener">v4 ${short(p.address)}</a>` : `<a href="${scan(p.address)}" target="_blank" rel="noopener">${short(p.address)}</a>`}</td></tr>`);
    }
  }
  $("pools-body").innerHTML = rows.slice(0, 300).join("") + (rows.length > 300 ? `<tr><td colspan="9" class="muted">… y ${rows.length - 300} pools más</td></tr>` : "");
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
    .map((r) => `<tr data-key="${r.key}" class="${r.profitable ? "win" : ""}">
      <td class="route">${routeText(r)}</td>
      <td class="num">${fmtNum(r.marginalBps, 2)}</td>
      <td class="num">${fmtNum(r.feesBps, 2)}</td>
      <td class="num">${r.amountIn > 0n ? fmtUsd(r.amountInUsd, 0) : "—"}</td>
      <td class="num">${fmtUsd(r.grossUsd, 4)}</td>
      <td class="num">${fmtUsd(r.flashFeeUsd, 4)}</td>
      <td class="num">${fmtUsd(r.gasUsd, 4)}</td>
      <td class="num strong">${fmtUsd(r.netUsd, 4)}</td>
      <td>${r.lender}${r.needsV4 ? ' <span class="hop">· requiere hop v4</span>' : ""}</td></tr>`)
    .join("");
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


// ------------------------------------------------------------------ préstamo óptimo (solo lectura)

const sim = { routeKey: null, pinned: false };

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

function fillScenarioPools() { /* ya no hay escenarios */ }

function renderSim() {
  const results = state.ctx ? state.ctx.results : [];
  if (!results.length) return;
  // por defecto: la mejor ruta del bloque; si el usuario tocó una ruta, se mantiene mientras exista
  let r = sim.pinned ? results.find((x) => x.key === sim.routeKey) : null;
  if (!r) { r = results[0]; sim.routeKey = r.key; sim.pinned = false; }
  document.querySelectorAll("#res-body tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.key === r.key));
  $("sim-route-name").innerHTML = `${sim.pinned ? "Ruta elegida" : "Mejor ruta del bloque"}: ${routeText(r)}${sim.pinned ? ' · <a href="#" id="sim-unpin">volver a la mejor</a>' : ""}`;
  const un = $("sim-unpin");
  if (un) un.onclick = (e) => { e.preventDefault(); sim.pinned = false; renderSim(); };
  const toUsd = core.tokenToUsd(r.startTok, state.ctx.ethUsd);

  if (r.amountIn === 0n) {
    $("sim-opt").innerHTML = `<b>No se pide nada.</b> En esta ruta cualquier préstamo pierde dinero: la diferencia de precio (${fmtNum(r.marginalBps, 2)} bps) no cubre las comisiones de los pools.`;
    $("sim-break").innerHTML = "";
  } else {
    const x = r.amountIn;
    const out = core.routeOut(x, r.startTok.address, r.route);
    const l = core.lenderFor(r.segs, x);
    const fee = l ? l.fee : 0n;
    $("sim-opt").innerHTML = `<b>Pide ${fmtUsd(r.amountInUsd, 0)} a ${r.lender}</b> → beneficio neto <b>${fmtUsd(r.netUsd, 4)}</b>${r.netUsd > 0 ? " · el protocolo la ejecutaría" : " · no cubre el gas: no se envía"}${r.needsV4 ? " · requiere hop v4 (aún no soportado por el contrato)" : ""}.`;
    const row = (k, v, cls = "") => `<tr class="${cls}"><td>${k}</td><td class="num">${v}</td></tr>`;
    $("sim-break").innerHTML = [
      row(`1. Pide prestado a ${l ? l.name : "—"} (comisión ${l ? fmtNum(Number(l.bps) / 100, 2) : "—"}%)`, `${fmtTok(x, r.startTok)} · ${fmtUsd(toUsd(x), 2)}`),
      row("2. Recorre la ruta y recibe", `${fmtTok(out, r.startTok)} · ${fmtUsd(toUsd(out), 2)}`),
      row("3. Devuelve el préstamo", `${fmtTok(x + fee, r.startTok)}`),
      row("Ganancia de la ruta", fmtUsd(toUsd(out - x), 4)),
      row("− Comisión del flashloan", fmtUsd(toUsd(fee), 4)),
      row("− Gas (L2 + L1)", fmtUsd(r.gasUsd, 4)),
      row("= Beneficio neto", fmtUsd(r.netUsd, 4), "total"),
    ].join("");
  }
}


$("routes-box").addEventListener("toggle", () => { if ($("routes-box").open && state.ctx) { renderResults(state.ctx.results); renderSim(); } });
$("pools-box").addEventListener("toggle", () => { if ($("pools-box").open) renderPools(); });
$("res-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr || !tr.dataset.key) return;
  sim.routeKey = tr.dataset.key; sim.pinned = true;
  renderSim();
  $("sim").scrollIntoView({ behavior: "smooth", block: "start" });
});

// ------------------------------------------------------------------ acumulado (sesión + servidor 24/7)

function renderSession() {
  const t = state.session.totals;
  $("acc-session").textContent = fmtUsd(t.netUsd, 2);
  $("acc-session-sub").textContent = `${t.episodes} oportunidades en ${state.session.blocksProcessed} bloques desde que abriste la página`;
}

async function loadServerStats() {
  if (location.protocol === "file:") {
    $("acc-status").textContent = "El acumulado 24/7 solo está disponible en la versión publicada (simulador-arbitraje-base.netlify.app).";
    return;
  }
  let d;
  try {
    const r = await fetch("/api/stats", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    d = await r.json();
  } catch (e) {
    $("acc-status").textContent = "No se pudo leer el servidor: " + e.message;
    return;
  }
  if (!d.ready) { $("acc-status").textContent = "El servidor todavía no procesa su primer bloque. Arranca solo cada 5 minutos."; return; }
  const ago = d.lastBlockTs ? Math.max(0, Math.round(d.now / 1000 - d.lastBlockTs)) : null;
  const covered = d.lastBlock && d.firstBlock ? d.blocksProcessed / (d.lastBlock - d.firstBlock + 1) : 0;
  const since = d.startedAt ? new Date(d.startedAt) : null;
  const days = since ? Math.max(1 / 24, (d.now - since.getTime()) / 86400000) : 1;
  $("acc-status").innerHTML = `${d.alive ? "● Servidor activo" : "○ Servidor en pausa (se reactiva solo en ≤5 min)"}${d.alive && d.phase ? ` (${d.phase})` : ""} · último bloque ${d.lastBlock?.toLocaleString("es-MX") ?? "—"}${ago !== null ? ` hace ${ago} s` : ""} · ${d.blocksProcessed.toLocaleString("es-MX")} bloques procesados (cobertura ${fmtNum(covered * 100, 1)}%) · ${d.universe.pools} pools, ${d.universe.cycles} ciclos · desde ${since ? since.toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }) : "—"}${d.lastError ? ` · último error: ${d.lastError}` : ""}`;
  const t = d.totals;
  $("acc-net").textContent = fmtUsd(t.netUsd, 2);
  $("acc-net-sub").textContent = `≈ ${fmtUsd(t.netUsd / days, 2)} por día · gas pagado ${fmtUsd(t.gasUsd, 2)}`;
  $("acc-eps").textContent = t.episodes.toLocaleString("es-MX");
  $("acc-eps-sub").textContent = `${d.openEpisodes} abiertas ahora${t.needsV4 ? ` · ${t.needsV4} requieren hop v4` : ""}`;
  $("acc-over1").textContent = t.over1Usd.toLocaleString("es-MX");
  $("acc-over1-sub").textContent = `suman ${fmtUsd(t.over1NetUsd, 2)}`;
  $("acc-best").textContent = d.best ? fmtUsd(d.best.netUsd, 2) : "—";
  $("acc-best-sub").textContent = d.best ? `bloque ${d.best.block.toLocaleString("es-MX")} · préstamo ${fmtUsd(d.best.amountUsd, 0)}` : "";
  $("acc-routes").innerHTML = d.topRoutes.map((r) => `<tr><td class="route">${r.label}</td><td class="num">${r.episodes}</td><td class="num strong">${fmtUsd(r.netUsd, 2)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Sin oportunidades todavía.</td></tr>`;
  $("acc-recent").innerHTML = d.recent.map((e) => `<tr><td>${e.block.toLocaleString("es-MX")}</td><td>${new Date(e.ts * 1000).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })}</td><td class="route">${e.route}${e.needsV4 ? ' <span class="hop">· requiere hop v4</span>' : ""}</td><td class="num">${fmtUsd(e.amountUsd, 0)}</td><td class="num strong">${fmtUsd(e.netUsd, 4)}</td><td>${e.lender}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Sin oportunidades todavía.</td></tr>`;
  drawAccChart(d.hourly);
}

function drawAccChart(hourly) {
  const svg = $("acc-chart");
  if (!hourly || hourly.length < 2) { svg.innerHTML = `<text x="8" y="20" class="axis">La gráfica aparece tras la segunda hora de datos.</text>`; return; }
  let acc = 0;
  const pts = hourly.map((h) => ({ h: h.h, v: (acc += h.netUsd), eps: h.episodes, net: h.netUsd }));
  const W = svg.clientWidth || 640, H = 180, padL = 58, padR = 12, padT = 12, padB = 24;
  const lo = Math.min(0, ...pts.map((p) => p.v)), hi = Math.max(1e-6, ...pts.map((p) => p.v));
  const X = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const lbl = (h) => new Date(h * 3600 * 1000).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit" });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `
    ${[lo, (lo + hi) / 2, hi].map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${padL - 6}" y="${Y(t) + 4}" class="axis" text-anchor="end">${fmtAxis(t)}</text>`).join("")}
    <path d="${pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join("")}" class="line"/>
    <text x="${padL}" y="${H - 6}" class="axis">${lbl(pts[0].h)}</text>
    <text x="${W - padR}" y="${H - 6}" class="axis" text-anchor="end">${lbl(pts[pts.length - 1].h)}</text>
    <circle id="acc-dot" r="4" class="dot" cx="-10" cy="-10"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="acc-hit"/>`;
  const tip = $("acc-tip");
  svg.querySelector("#acc-hit").onmousemove = (ev) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((((ev.clientX - r.left) / r.width) * W - padL) / (W - padL - padR)) * (pts.length - 1))));
    const p = pts[i];
    svg.querySelector("#acc-dot").setAttribute("cx", X(i)); svg.querySelector("#acc-dot").setAttribute("cy", Y(p.v));
    tip.hidden = false;
    tip.style.left = Math.min(r.width - 210, (X(i) / W) * r.width + 8) + "px";
    tip.innerHTML = `<b>${lbl(p.h)} h</b><br>Acumulado ${fmtUsd(p.v, 2)}<br>Esa hora: ${p.eps} oportunidades, ${fmtUsd(p.net, 2)}`;
  };
  svg.querySelector("#acc-hit").onmouseleave = () => { tip.hidden = true; };
}

loadServerStats();
setInterval(loadServerStats, 15000);

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

$("universe").addEventListener("change", () => {
  const lt = $("universe").value === "longtail";
  $("hours-wrap").hidden = $("universe-note").hidden = !lt;
});
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
