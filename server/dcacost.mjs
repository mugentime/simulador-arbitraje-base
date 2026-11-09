// Costo del DCA en Beefy CLM: precio promedio de entrada y desglose del PnL (precio vs comisiones) por vault.
// Fuente: las corridas guardadas por Strategy (s.runs, con los hashes de cada tx) + los recibos on-chain de esas txs
// (Transfer de X y del estable desde/hacia la wallet), así que no depende de logs ni de oráculos.
//   · compras de X (swap estable→X) y ventas (X→estable) → costo promedio del X en la wallet
//   · "deposit CLM" → X y estable que entraron al vault; el X entra con su costo promedio
//   · invertido = estable depositado + costo del X depositado (+ saldo previo al DCA, PRIOR)
//   · hodl = estable depositado + X depositado × precio de hoy (+ previo) → efecto precio = hodl − invertido = X × (P − P̄)
//   · valor = participaciones × (balances del CLM) al precio del pool; recompensas = earned() del reward pool (comisiones)
//   · PnL = valor + recompensas − invertido = efecto precio + comisiones + rango/IL (valor − hodl)
// Línea horaria "dca costo" en los logs del worker que hace el DCA (Base: cbBTC-USDC; BSC: el vault que toque).
import { ethers } from "ethers";
import { priceFromSqrtX96 } from "./beefywallet.mjs";
import { CHAINS } from "../src/chains.js";
import { bestPath, vaultValue, tokenValue } from "./beefyclm.mjs";

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const I = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)",
  "function balances() view returns (uint256, uint256)", "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function getPricePerFullShare() view returns (uint256)", "function earned(address) view returns (address[], uint256[])",
]);
// posiciones anteriores al DCA que no están en las corridas (USD al momento de empezar; sin desglose X/estable → sin efecto precio)
export const PRIOR = { "uniswap-cow-base-usdc-cbbtc-rp": { usd: 4.75, at: "2026-11-05T21:12:00Z" } };

const lc = (a) => String(a ?? "").toLowerCase();
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

/** Flujo neto (crudo) de la wallet `me` para cada token de `tokens` en los logs de un recibo (puro, probado). */
export function walletFlows(logs, me, tokens) {
  const out = Object.fromEntries(tokens.map((t) => [lc(t), 0n]));
  for (const l of logs ?? []) {
    const t = lc(l.address);
    if (!(t in out) || l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
    const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), v = BigInt(l.data);
    if (from === lc(me)) out[t] -= v;
    if (to === lc(me)) out[t] += v;
  }
  return out;
}

/** Tipo de movimiento a partir del paso y de los flujos (unidades humanas) de X y del estable (puro, probado). */
export function classify(step, dx, ds) {
  const st = String(step ?? "");
  if (/^approve|^stake|^deposit vault/.test(st)) return null;
  if (/withdraw CLM/.test(st)) return dx > 0 || ds > 0 ? "retiro" : null;
  if (/deposit CLM/.test(st)) return dx < 0 || ds < 0 ? "deposito" : null;
  if (dx > 0 && ds < 0) return "compra";
  if (dx < 0 && ds > 0) return "venta";
  if (dx > 0 && ds >= 0) return "ingresoX"; // recompensa cobrada en X (costo 0)
  return null;
}

/**
 * Contabilidad por costo promedio (puro, probado). `moves` en orden: {type, x, s, reward?} con x, s ≥ 0 (unidades humanas).
 * reward: depósito pagado con recompensas (composición): entra al vault sin costo y no cuenta como invertido.
 */
export function ledger(moves) {
  const L = { q: 0, qCost: 0, xIn: 0, xCost: 0, sIn: 0, depS: 0, extIn: 0, rewardX: 0, rewardS: 0, buys: { x: 0, s: 0 }, sells: { x: 0, s: 0 }, wd: { x: 0, s: 0 } };
  for (const m of moves) {
    if (m.type === "compra") { L.q += m.x; L.qCost += m.s; L.buys.x += m.x; L.buys.s += m.s; }
    else if (m.type === "ingresoX") { L.q += m.x; }
    else if (m.type === "venta") { if (m.x > L.q && m.x > 0) L.extIn += (m.x - L.q) / m.x * m.s; // X que ya estaba en la wallet (capital externo)
      const c = L.q > 0 ? L.qCost * Math.min(1, m.x / L.q) : 0; L.qCost -= c; L.q = Math.max(0, L.q - m.x); L.sells.x += m.x; L.sells.s += m.s; }
    else if (m.type === "deposito") {
      const fromInv = Math.min(m.x, L.q), c = L.q > 0 ? L.qCost * (fromInv / L.q) : 0;
      L.q -= fromInv; L.qCost -= c;
      if (m.reward) { L.rewardX += m.x; L.rewardS += m.s; continue; }
      // X que no venía de una compra registrada (p. ej. ya estaba en la wallet): se valora al precio de ese depósito si se conoce
      const extra = m.x - fromInv;
      if (extra > 0 && m.price > 0) L.extIn += extra * m.price; // X depositado que no salió de una compra registrada
      L.xIn += m.x; L.xCost += c + (extra > 0 && m.price > 0 ? extra * m.price : 0); L.sIn += m.s; L.depS += m.s;
    } else if (m.type === "retiro") {
      // sale del vault con su parte del costo: el X vuelve a la wallet (una venta posterior lo descuenta a ese costo)
      const fx = L.xIn > 0 ? Math.min(1, m.x / L.xIn) : 0, cx = L.xCost * fx;
      L.q += m.x; L.qCost += cx; L.xIn = Math.max(0, L.xIn - m.x); L.xCost -= cx; L.sIn = Math.max(0, L.sIn - m.s);
      L.wd.x += m.x; L.wd.s += m.s;
    }
  }
  if (Math.abs(L.q) < 1e-15) L.q = 0;
  return L;
}

/** Precio medio "DCA puro" (como si cada depósito hubiera comprado X a su precio): Σ$ / Σ($/P) (puro, probado). */
export function dcaAvgPrice(deps) {
  const ok = deps.filter((d) => d.usd > 0 && d.price > 0);
  const usd = ok.reduce((a, d) => a + d.usd, 0), units = ok.reduce((a, d) => a + d.usd / d.price, 0);
  return { usd, units, price: units > 0 ? usd / units : null, n: ok.length, missing: deps.length - ok.length };
}

/** Desglose del PnL (puro, probado). */
export function breakdown({ L, prior = 0, price, valueUsd, rewardsUsd = 0 }) {
  const invested = L.sIn + L.xCost + prior;
  const hodl = L.sIn + L.xIn * price + prior;
  const total = valueUsd + rewardsUsd;
  return { invested, hodl, avgX: L.xIn > 0 ? L.xCost / L.xIn : null, pnl: total - invested, pnlPct: invested > 0 ? (total - invested) / invested * 100 : null,
    priceEffect: hodl - invested, fees: rewardsUsd, rangeIl: valueUsd - hodl, total };
}

/** Suma comisiones estimadas: valor × ((1+APY)^(h/8760) − 1) por las horas desde la última lectura (máx. 2 h por lectura) (puro, probado). */
export function accrueFees(f, { now, valueUsd, apy }) {
  const h = Math.min(2, Math.max(0, (now - (f.at ?? now)) / 3600_000));
  const add = Number.isFinite(apy) && apy > -1 && valueUsd > 0 ? valueUsd * (Math.pow(1 + apy, h / 8760) - 1) : 0;
  return { ...f, at: now, usd: +(f.usd + add).toFixed(6) };
}

/** Comisiones estimadas desde la serie horaria guardada ({at, positions:[{id, valueUsd, apyPct}]}) (puro, probado). */
export function backfillFees(hist, id) {
  let f = null;
  for (const e of hist ?? []) {
    const ps = (e.positions ?? []).find((x) => x.id === id), at = Date.parse(e.at);
    if (!ps || !Number.isFinite(at) || !(ps.valueUsd > 0)) continue;
    f = f ? accrueFees(f, { now: at, valueUsd: ps.valueUsd, apy: Number(ps.apyPct) / 100 }) : { since: new Date(at).toISOString(), at, usd: 0 };
  }
  return f;
}

/**
 * PnL de la estrategia completa con los depósitos diarios (puro, probado). vaults: [{newMoney, L, valueUsd, rewardsUsd, feesUsd, price, deps:[{at, usd}]}],
 * prior: [{at, usd}]. Aportado = dinero nuevo (depósitos DCA + previo). Valor = posiciones + recompensas + lo que quedó en la wallet
 * de esos aportes (estable sin depositar y X comprado sin depositar). Rendimiento anualizado sobre capital-día (cada depósito pesa
 * por los días que lleva invertido), comparable con un APY.
 */
export function strategyPnl(vaults, prior, nowMs) {
  let aportado = 0, valor = 0, posiciones = 0, recompensas = 0, sobranteS = 0, sobranteX = 0, comisiones = 0, rendimiento = 0, capDias = 0, n = 0, first = null;
  const flows = [...prior.map((p) => ({ at: p.at, usd: p.usd }))];
  for (const v of vaults) {
    const L = v.L;
    const left = v.newMoney - L.buys.s + L.sells.s - L.depS + L.wd.s; // estable de los aportes que sigue en la wallet
    sobranteS += left; sobranteX += L.q * v.price; // se suma entre vaults: lo que sale de uno y entra a otro se compensa
    posiciones += v.valueUsd; recompensas += v.rewardsUsd; comisiones += v.feesUsd; rendimiento += v.rendUsd ?? v.feesUsd;
    for (const d of v.deps) { flows.push(d); n++; }
    if (L.extIn > 0.005 && v.deps[0]) flows.push({ at: v.deps[0].at, usd: L.extIn, extra: true });
  }
  // estable depositado de más (p. ej. USDC que ya estaba en la wallet) también es capital aportado: se suma al primer aporte
  if (sobranteS < 0 && flows.length) { const f0 = flows.reduce((a, f) => (Date.parse(f.at) || f.at) < (Date.parse(a.at) || a.at) ? f : a); flows.push({ at: f0.at, usd: -sobranteS, extra: true }); }
  for (const f of flows) { aportado += f.usd; const at = typeof f.at === "number" ? f.at : Date.parse(f.at); if (Number.isFinite(at)) { capDias += f.usd * Math.max(0, nowMs - at) / 86400_000; first = first === null ? at : Math.min(first, at); } }
  sobranteS = Math.max(0, sobranteS);
  valor = posiciones + recompensas + sobranteS + sobranteX;
  const pnl = valor - aportado;
  const extra = flows.filter((f) => f.extra).reduce((a, f) => a + f.usd, 0);
  return { aportado, extra, valor, posiciones, recompensas, sobranteS, sobranteX, pnl, pnlPct: aportado > 0 ? pnl / aportado * 100 : null, comisiones, precio: pnl - comisiones,
    rendimiento, rendDiarioPct: capDias > 0 ? rendimiento / capDias * 100 : null, rendAnualPct: capDias > 0 ? rendimiento / capDias * 365 * 100 : null,
    volatilidad: pnl - rendimiento, volPct: aportado > 0 ? (pnl - rendimiento) / aportado * 100 : null,
    capDias, diarioPct: capDias > 0 ? pnl / capDias * 100 : null, anualPct: capDias > 0 ? pnl / capDias * 365 * 100 : null, dias: first !== null ? (nowMs - first) / 86400_000 : 0, n, desde: first };
}

const f2 = (n) => (n === null || !Number.isFinite(n) ? "—" : (n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(2));
const sg = (n) => (n === null || !Number.isFinite(n) ? "—" : (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toFixed(2));
const pc = (n) => (n === null || !Number.isFinite(n) ? "—" : (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(1) + " %");
const px = (n) => (n === null || !Number.isFinite(n) ? "—" : "$" + (n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toPrecision(5)));

/** Vault de un par sin el estable (p. ej. ZEC-BTCB): invertido = estable gastado en los swaps − estable recibido al salir;
 *  valor = participaciones × balances del CLM, con cada token valuado por su mejor ruta Uniswap v3 al estable. */
async function pairReport(s, id, rs, { cache, alt, fees, apy, now, agg, call }) {
  const m = rs[rs.length - 1], S = s.net.stable, D = s.net.stableDec, me = lc(s.me);
  let spent = 0, received = 0, missing = 0;
  for (const r of rs) for (const t of r.txs) {
    if (/^approve|^stake|^deposit vault/.test(t.step)) continue;
    let fl = cache[t.hash];
    if (!fl) {
      let rc = await s.provider.getTransactionReceipt(t.hash).catch(() => null);
      for (const url of rc ? [] : (CHAINS[s.net.beefy]?.rpcs ?? [])) { rc = await (alt[url] ??= new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 })).getTransactionReceipt(t.hash).catch(() => null); if (rc) break; }
      if (!rc) { missing++; continue; }
      const w = walletFlows(rc.logs, me, [m.t0, m.t1, S]);
      fl = cache[t.hash] = { x: String(w[lc(m.t0)]), x1: String(w[lc(m.t1)]), s: String(w[lc(S)]) };
    }
    const ds = Number(BigInt(fl.s)) / 10 ** D;
    if (ds < 0) spent -= ds; else received += ds;
  }
  const dec = async (t) => Number((await call(t, "decimals"))[0]), sym = async (t) => (await call(t, "symbol"))[0];
  const [d0, d1, s0, s1] = await Promise.all([dec(m.t0), dec(m.t1), sym(m.t0), sym(m.t1)]);
  const px = async (t, d) => Number((await bestPath(s, t, S, 10n ** BigInt(Math.max(0, d - 4)))).out) / 10 ** D * 1e4; // precio con 1e-4 unidades
  const [p0, p1] = await Promise.all([px(m.t0, d0), px(m.t1, d1)]);
  let shares = (await call(m.vault, "balanceOf", [s.me]))[0];
  if (!m.gov) { const pp = (await call(m.vault, "getPricePerFullShare"))[0]; shares = shares * pp / 10n ** 18n; }
  shares += (await call(m.clm, "balanceOf", [s.me]))[0];
  const [[a0, a1], [ts]] = await Promise.all([call(m.clm, "balances"), call(m.clm, "totalSupply")]);
  const frac = ts > 0n ? Number(shares) / Number(ts) : 0;
  const q0 = Number(a0) / 10 ** d0 * frac, q1 = Number(a1) / 10 ** d1 * frac;
  const valueUsd = q0 * p0 + q1 * p1, invested = spent - received, closed = shares === 0n;
  const apyNow = Number(apy?.[id]?.totalApy ?? NaN);
  fees[id] = accrueFees(fees[id] ?? { since: new Date(now).toISOString(), at: now, usd: 0 }, { now, valueUsd, apy: apyNow });
  const pnl = valueUsd - invested, pnlPct = invested > 0 ? pnl / invested * 100 : null;
  const deps = rs.filter((r) => /#\d+$/.test(r.k) && r.status === "hecho").map((r) => ({ at: r.startedAt, usd: Number(BigInt(r.usdcIn ?? "0")) / 10 ** D || Number(r.usd) || 0 }));
  const L = { q: 0, xIn: 0, xCost: 0, sIn: 0, depS: 0, extIn: 0, buys: { x: 0, s: spent }, sells: { x: 0, s: received }, wd: { x: 0, s: 0 } };
  agg.push({ id, newMoney: deps.reduce((a, x) => a + x.usd, 0), L, valueUsd: closed ? 0 : valueUsd, rewardsUsd: 0, feesUsd: fees[id].usd, price: 0, deps });
  const cd = capitalDays(deps, invested, now);
  const sp = splitYield({ feesEst: fees[id].usd, pnl });
  agg[agg.length - 1].rendUsd = sp.rend;
  (s.lastCost ??= {})[id] = { at: now, invested, value: valueUsd, rewards: 0, pnl, pnlPct, closed, missing, fees: fees[id].usd, feesSince: fees[id].since, priceRange: pnl - fees[id].usd,
    gov: !!m.gov, rend: sp.rend, rendSrc: sp.rendSrc, rendDailyPct: null, vol: sp.vol, volPct: invested > 0 ? sp.vol / invested * 100 : null, precioEf: null, il: null,
    apy: Number.isFinite(apyNow) ? apyNow * 100 : null, n: deps.length, first: cd.first, days: cd.days, capDays: cd.capDays, dailyPct: cd.capDays > 0 ? pnl / cd.capDays * 100 : null, sym: `${s0}/${s1}` };
  return `dca costo ${id}: par sin ${s.net.stableSym} · invertido ${f2(invested)} (${s.net.stableSym} gastado ${f2(spent)}${received ? ` − recibido ${f2(received)}` : ""}) · ${closed ? "posición cerrada" : `valor ${f2(valueUsd)} (${q0.toPrecision(5)} ${s0} a ${px2(p0)} + ${q1.toPrecision(5)} ${s1} a ${px2(p1)})`}` +
    ` · PnL ${sg(pnl)} (${pc(pnlPct)}) = comisiones est. ${sg(fees[id].usd)} (APY ${Number.isFinite(apyNow) ? (apyNow * 100).toFixed(1) + " %" : "?"}) + precio/rango ${sg(pnl - fees[id].usd)}${missing ? ` · ${missing} recibos no disponibles` : ""}`;
}
/**
 * Separa el resultado en dos indicadores (criterio de Jose 2026-11-08): RENDIMIENTO = comisiones + recompensas (la ganancia de la
 * estrategia) y VOLATILIDAD = precio + pérdida impermanente (esperada en un DCA, no realizada). En reward pools (gov) las comisiones
 * del CLM se pagan como recompensas → rendimiento medido = por cobrar + ya cobradas; en vaults normales se componen en la
 * participación → rendimiento estimado = valor × APY publicado, hora a hora. Volatilidad = resultado total − rendimiento.
 */
export function splitYield({ feesEst = 0, pnl, priceEffect = null }) {
  // Verificado en vivo (2026-11-09): los reward pools de cbBTC y ZEC no acumulan recompensas (por cobrar $0 tras 3 días): las
  // comisiones del CLM se componen en la propia posición. Por eso el rendimiento es valor × APY total publicado (comisiones del
  // CLM + recompensas del pool), hora a hora; las recompensas por cobrar ya están dentro del valor y no se suman aparte.
  const rend = feesEst, vol = pnl - rend;
  return { rend, rendSrc: "estimado", vol, precio: priceEffect, il: priceEffect === null ? null : vol - priceEffect };
}
/** Capital-día de un vault: cada aporte pesa por los días que lleva invertido; se escala a lo invertido (barridos/previos). */
export function capitalDays(flows, invested, nowMs) {
  const tot = flows.reduce((a, f) => a + (f.usd || 0), 0);
  let cd = 0, first = null;
  for (const f of flows) { const at = typeof f.at === "number" ? f.at : Date.parse(f.at); if (!Number.isFinite(at) || !(f.usd > 0)) continue; cd += f.usd * Math.max(0, nowMs - at) / 86400_000; first = first === null ? at : Math.min(first, at); }
  if (tot > 0 && invested > 0) cd *= invested / tot;
  return { capDays: cd, first, days: first !== null ? (nowMs - first) / 86400_000 : 0 };
}
const px2 = (n) => (Number.isFinite(n) ? "$" + (n >= 100 ? n.toFixed(2) : n.toPrecision(5)) : "—");

/** Calcula el costo de cada vault del DCA y devuelve las líneas para el log. `s` = Strategy (provider, me, net, s.runs, store). */
export async function dcaCostReport(s, { ethUsd = null } = {}) {
  if (s.net?.wrapNative) return wrapStrategyReport(s, { ethUsd }); // Robinhood: el "estable" es WETH → cuentas en USD con el precio del ETH
  const runs = Object.entries(s.s?.runs ?? {}).map(([k, r]) => ({ k, ...r })).filter((r) => r.vaultId && r.clm && Array.isArray(r.txs) && r.txs.length)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const byVault = {};
  for (const r of runs) (byVault[r.vaultId] ??= []).push(r);
  const cache = (await s.store.get("dcaCostRc")) ?? {};
  const p = s.provider, me = lc(s.me), S = s.net.stable, D = s.net.stableDec;
  const call = async (to, fn, args = []) => I.decodeFunctionResult(fn, await p.call({ to, data: I.encodeFunctionData(fn, args) }));
  const out = [], alt = {};
  const apy = await fetch("https://api.beefy.finance/apy/breakdown", { signal: AbortSignal.timeout(20_000) }).then((r) => r.json()).catch(() => ({}));
  const fees = (await s.store.get("dcaCostFees")) ?? {};
  const hist = (await s.store.get("beefyWalletHist").catch(() => null)) ?? []; // serie horaria de "beefy wallet" (solo el worker de Base)
  const now = Date.now();
  const agg = [], priors = [];
  for (const [id, rs] of Object.entries(byVault)) {
    try {
      const m = rs[rs.length - 1], X = m.x;
      if (m.noStable) { out.push(await pairReport(s, id, rs, { cache, alt, fees, apy, now, agg, call })); continue; }
      const dX = Number((await call(X, "decimals"))[0]), symX = (await call(X, "symbol"))[0];
      // precio de hoy desde el pool del CLM
      const [sq] = await call(m.pool, "slot0");
      const p1in0 = priceFromSqrtX96(sq, m.usdcIs0 ? D : dX, m.usdcIs0 ? dX : D);
      const price = m.usdcIs0 ? 1 / p1in0 : p1in0;
      // movimientos desde los recibos (en caché por hash)
      const moves = [], deps = [];
      let missing = 0;
      for (const r of rs) {
        const reward = /compound/.test(r.k) || r.compound === true;
        const runPrice = r.ratio?.rate > 0 ? 10 ** (dX - D) / r.ratio.rate : null;
        let runBuyPx = null;
        for (const t of r.txs) {
          let fl = cache[t.hash];
          if (!fl) {
            let rc = await p.getTransactionReceipt(t.hash).catch(() => null);
            // algunos RPC no guardan el índice de txs viejas: se prueba con los demás de la cadena
            for (const url of rc ? [] : (CHAINS[s.net.beefy]?.rpcs ?? [])) {
              rc = await (alt[url] ??= new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 })).getTransactionReceipt(t.hash).catch(() => null);
              if (rc) break;
            }
            if (!rc) { missing++; continue; }
            const w = walletFlows(rc.logs, me, [X, S]);
            fl = cache[t.hash] = { x: String(w[lc(X)]), s: String(w[lc(S)]) };
          }
          const dx = Number(BigInt(fl.x)) / 10 ** dX, ds = Number(BigInt(fl.s)) / 10 ** D;
          const type = classify(t.step, dx, ds);
          if (!type) continue;
          if (type === "compra") runBuyPx = -ds / dx;
          moves.push({ type, x: Math.abs(dx), s: Math.abs(ds), reward, price: runPrice ?? runBuyPx });
        }
        // depósitos DCA "#n": dólares nuevos y precio de X en ese momento (para el precio medio DCA puro)
        if (/#\d+$/.test(r.k) && r.status === "hecho") deps.push({ at: r.startedAt, usd: Number(BigInt(r.usdcIn ?? "0")) / 10 ** D || Number(r.usd) || 0, price: runPrice ?? runBuyPx });
      }
      const L = ledger(moves);
      // posición actual: acciones del vault (reward pool 1:1 con el CLM; vault normal con ppfs) + CLM suelto en la wallet
      const vShares = (await call(m.vault, "balanceOf", [s.me]))[0];
      let clmShares = vShares;
      if (!m.gov) { const pp = (await call(m.vault, "getPricePerFullShare"))[0]; clmShares = vShares * pp / 10n ** 18n; }
      clmShares += (await call(m.clm, "balanceOf", [s.me]))[0];
      const [[a0, a1], [ts]] = await Promise.all([call(m.clm, "balances"), call(m.clm, "totalSupply")]);
      const frac = ts > 0n ? Number(clmShares) / Number(ts) : 0;
      const xNow = Number(m.usdcIs0 ? a1 : a0) / 10 ** dX * frac, sNow = Number(m.usdcIs0 ? a0 : a1) / 10 ** D * frac;
      const valueUsd = sNow + xNow * price;
      // recompensas pendientes (comisiones del CLM que el reward pool reparte)
      let rewardsUsd = 0; const rw = [];
      if (m.gov) {
        try {
          const [toks, amts] = await call(m.vault, "earned", [s.me]);
          for (let i = 0; i < toks.length; i++) {
            if (amts[i] === 0n) continue;
            const t = lc(toks[i]), dec = t === lc(S) ? D : t === lc(X) ? dX : Number((await call(toks[i], "decimals"))[0]);
            const a = Number(amts[i]) / 10 ** dec;
            const u = t === lc(S) ? 1 : t === lc(X) ? price : t === lc(s.net.wnative) ? ethUsd : null;
            if (u) rewardsUsd += a * u;
            rw.push(`${a.toPrecision(4)} ${t === lc(S) ? s.net.stableSym : t === lc(X) ? symX : (await call(toks[i], "symbol"))[0]}${u ? ` ($${(a * u).toFixed(3)})` : ""}`);
          }
        } catch {}
      }
      const prior = PRIOR[id]?.usd ?? 0;
      const b = breakdown({ L, prior, price, valueUsd, rewardsUsd });
      const dca = dcaAvgPrice(deps);
      const closed = clmShares === 0n;
      // comisiones estimadas: valor × APY publicado de Beefy, integrado hora a hora desde que corre este reporte
      const apyNow = Number(apy?.[id]?.totalApy ?? NaN);
      const fz = (fees[id] ??= backfillFees(hist, id) ?? { since: new Date(now).toISOString(), at: now, usd: 0 });
      fees[id] = accrueFees(fz, { now, valueUsd, apy: apyNow });
      const priceRange = b.pnl - fees[id].usd;
      agg.push({ id, newMoney: deps.reduce((a, x) => a + x.usd, 0), L, valueUsd: closed ? 0 : valueUsd, rewardsUsd, feesUsd: fees[id].usd, price, deps: deps.map((x) => ({ at: x.at, usd: x.usd })) });
      if (PRIOR[id]) priors.push(PRIOR[id]);
      const cd = capitalDays([...(prior ? [{ at: PRIOR[id].at, usd: prior }] : []), ...deps], b.invested, now);
      const sp = splitYield({ feesEst: fees[id].usd, pnl: b.pnl, priceEffect: b.priceEffect });
      agg[agg.length - 1].rendUsd = sp.rend;
      (s.lastCost ??= {})[id] = { at: now, invested: b.invested, value: valueUsd, rewards: rewardsUsd, pnl: b.pnl, pnlPct: b.pnlPct, closed, missing, gov: !!m.gov,
        rend: sp.rend, rendSrc: sp.rendSrc, rendDailyPct: cd.capDays > 0 ? sp.rend / cd.capDays * 100 : null, vol: sp.vol, volPct: b.invested > 0 ? sp.vol / b.invested * 100 : null, precioEf: sp.precio, il: sp.il, hodl: b.hodl,
        fees: fees[id].usd, feesSince: fees[id].since, priceRange, apy: Number.isFinite(apyNow) ? apyNow * 100 : null, price, avgEntry: dca.price, priceVsEntryPct: dca.price ? (price / dca.price - 1) * 100 : null,
        xPct: valueUsd > 0 ? xNow * price / valueUsd * 100 : null, sym: symX, n: deps.length, first: cd.first, days: cd.days, capDays: cd.capDays, dailyPct: cd.capDays > 0 ? b.pnl / cd.capDays * 100 : null, leftX: L.q * price };
      const xPct = valueUsd > 0 ? xNow * price / valueUsd * 100 : 0;
      out.push(`dca costo ${id}: ${deps.length} depósitos DCA ($${dca.usd.toFixed(2)})${rs.length > deps.length ? ` + ${rs.length - deps.length} barridos/otros` : ""}` +
        ` · invertido ${f2(b.invested)}${prior ? ` (incl. previo ${f2(prior)})` : ""} · precio medio de entrada DCA ${px(dca.price)}${dca.missing ? ` (${dca.missing} sin precio)` : ""} · ${symX} hoy ${px(price)}${dca.price ? ` (${pc((price / dca.price - 1) * 100)} vs entrada)` : ""}` +
        ` · ${closed ? "posición cerrada" : `valor ${f2(valueUsd)} (${sNow.toFixed(2)} ${s.net.stableSym} + ${xNow.toPrecision(5)} ${symX} = ${Math.round(xPct)} % en ${symX})`}${rewardsUsd || rw.length ? ` + recompensas ${f2(rewardsUsd)}${rw.length ? ` [${rw.join(", ")}]` : ""}` : ""}` +
        ` · RENDIMIENTO ${sg(sp.rend)} (comisiones + recompensas estimadas con APY ${Number.isFinite(apyNow) ? (apyNow * 100).toFixed(1) + " %" : "?"} desde ${fees[id].since.slice(0, 16)}Z${rewardsUsd ? `; por cobrar ${f2(rewardsUsd)} ya en el valor` : ""}) · VOLATILIDAD ${sg(sp.vol)} (precio ${sg(sp.precio)} + pérdida impermanente/rango ${sg(sp.il)}) · total ${sg(b.pnl)} (${pc(b.pnlPct)})` +
        ` · lo depositado entró como ${f2(L.sIn)} ${s.net.stableSym} + ${L.xIn.toPrecision(5)} ${symX}${b.avgX ? ` (a $${b.avgX.toFixed(2)})` : ""} → hodl ${f2(b.hodl)}` +
        `${L.q > 0 ? ` · ${symX} en wallet ${L.q.toPrecision(5)} (${f2(L.q * price)})` : ""}${L.rewardX || L.rewardS ? ` · reinvertido de recompensas ${L.rewardS.toFixed(3)} ${s.net.stableSym} + ${L.rewardX.toPrecision(4)} ${symX}` : ""}` +
        `${L.wd.x || L.wd.s ? ` · retirado ${L.wd.s.toFixed(2)} ${s.net.stableSym} + ${L.wd.x.toPrecision(5)} ${symX}` : ""}${missing ? ` · ${missing} recibos no disponibles (invertido incompleto)` : ""}`);
    } catch (e) { out.push(`dca costo ${id}: error ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`); }
  }
  if (agg.length) {
    const t = strategyPnl(agg, priors, now);
    s.lastStrategy = { at: now, ...t };
    const hist = (await s.store.get("dcaStrategyHist").catch(() => null)) ?? [];
    hist.push({ at: new Date(now).toISOString(), aportado: +t.aportado.toFixed(4), valor: +t.valor.toFixed(4), pnl: +t.pnl.toFixed(4), comisiones: +t.comisiones.toFixed(4) });
    while (hist.length > 24 * 90) hist.shift();
    await s.store.set("dcaStrategyHist", hist).catch(() => {});
    out.push(`dca estrategia ${s.net.beefy}: aportado ${f2(t.aportado)} (${t.n} depósitos diarios${priors.length ? " + previo" : ""}${t.extra >= 0.005 ? ` + ${f2(t.extra)} que ya estaba en la wallet` : ""}${t.desde ? ` desde ${new Date(t.desde).toISOString().slice(0, 10)}` : ""})` +
      ` · valor ${f2(t.valor)} = posiciones ${f2(t.posiciones)}${t.recompensas ? ` + recompensas ${f2(t.recompensas)}` : ""}${t.sobranteS + t.sobranteX >= 0.005 ? ` + sobrante en wallet ${f2(t.sobranteS + t.sobranteX)}` : ""}` +
      ` · RENDIMIENTO ${sg(t.rendimiento)} (comisiones + recompensas; ${pc(t.rendDiarioPct)} por día) · VOLATILIDAD ${sg(t.volatilidad)} (precio + pérdida impermanente; esperada en DCA) · total ${sg(t.pnl)} (${pc(t.pnlPct)})` +
      ` · capital-día ${t.capDias.toFixed(1)} → ${pc(t.diarioPct)} por día${t.dias >= 7 ? ` (anualizado ${pc(t.anualPct)})` : " (anualizado desde 7 días)"} · vaults: ${agg.map((a) => `${a.id} ${f2(a.valueUsd)}`).join(", ")}`);
  }
  await s.store.set("dcaCostRc", cache).catch(() => {});
  await s.store.set("dcaCostFees", fees).catch(() => {});
  return out;
}

/**
 * Estrategias en cadenas cuyo "estable" es WETH (Robinhood). Por estrategia (DCA principal y cada DCA_EXTRA):
 * aportado = dólares de cada depósito diario; valor = posiciones abiertas + capital apartado (por reinvertir y ganancia
 * retenida) + tokens sueltos de sus vaults en la wallet; ganancia real = valor − aportado; comisiones estimadas = valor × APY
 * hora a hora; rendimiento por día sobre capital-día.
 */
export async function wrapStrategyReport(s0, { ethUsd = null } = {}) {
  // copia liviana: vaultValue cambia run/vaultId y no debe pisar un depósito en curso de la estrategia
  const s = Object.assign(Object.create(Object.getPrototypeOf(s0)), s0, { save: async () => {}, diag: async () => {} });
  if (!(ethUsd > 0)) return [`dca estrategia ${s.net.beefy}: sin precio del ETH`];
  const D = s.net.stableDec, toUsd = (raw) => Number(raw) / 10 ** D * ethUsd, now = Date.now();
  const apy = await fetch("https://api.beefy.finance/apy/breakdown", { signal: AbortSignal.timeout(20_000) }).then((r) => r.json()).catch(() => ({}));
  const fees = (await s.store.get("wrapFees")) ?? {};
  const out = [], seenTok = new Set(), res = {};
  const recs = Object.entries(s.s?.dca ?? {}).filter(([, d]) => d && (d.totalUsd > 0 || d.redeploy)).sort(([, a], [, b]) => (b.extra ? 1 : 0) - (a.extra ? 1 : 0)); // primero los extra: se quedan con sus tokens
  for (const [label, d] of recs) {
    try {
      const ids = d.extra ? [d.vaultId].filter(Boolean) : [...new Set([...Object.keys(d.holdings ?? {}), ...Object.keys(d.failed ?? {}), ...(d.target ? [d.target] : [])])];
      const open = d.extra ? ids : ids.filter((id) => !(d.holdings?.[id]?.closed));
      let enVault = 0, sueltos = 0, rend = 0, porCobrar = 0; const vaults = []; let medido = 0, estimado = 0;
      const toks = new Set();
      for (const id of ids) {
        let v = null;
        try { v = await vaultValue(s, id); }
        catch (e) {
          // vault fuera de la API (retirado): se cuentan igual sus tokens sueltos con los que se guardaron al depositar
          for (const t of d.holdings?.[id]?.tokens ?? []) if (t && t.toLowerCase() !== s.net.stable.toLowerCase()) toks.add(t.toLowerCase());
          if (open.includes(id)) vaults.push({ id, error: (e.message || String(e)).slice(0, 80) });
          continue;
        }
        for (const t of v.tokens) if (t && t.toLowerCase() !== s.net.stable.toLowerCase()) toks.add(t.toLowerCase());
        const usd = toUsd(v.value), pend = toUsd(v.pending ?? 0n);
        if (usd > 0.005 || open.includes(id)) {
          const a = Number(apy?.[id]?.totalApy ?? NaN);
          fees[id] = accrueFees(fees[id] ?? { since: new Date(now).toISOString(), at: now, usd: 0 }, { now, valueUsd: usd, apy: Number.isFinite(a) && a < 200 ? a : NaN }); // APY > 20,000 % = irreal, no cuenta
          vaults.push({ id, usd: +usd.toFixed(4), apyPct: Number.isFinite(a) ? a * 100 : null, gov: v.gov, pending: +pend.toFixed(4) });
        }
        // rendimiento: reward pool → recompensas medidas (por cobrar + cobradas); vault normal → comisiones estimadas
        rend += fees[id]?.usd ?? 0; estimado += fees[id]?.usd ?? 0; medido += pend; // medido = por cobrar (ya dentro del valor; informativo)
        enVault += usd; porCobrar += pend;
      }
      for (const t of toks) {
        if (seenTok.has(t)) continue; seenTok.add(t);
        const b = BigInt((await s.provider.call({ to: t, data: I.encodeFunctionData("balanceOf", [s.me]) }).then((x) => I.decodeFunctionResult("balanceOf", x)[0]).catch(() => 0n)));
        sueltos += toUsd(await tokenValue(s, t, b));
      }
      const reservado = toUsd(BigInt(d.redeploy ?? "0") + BigInt(d.retained ?? "0"));
      // capital que pasó de una estrategia a otra en la misma wallet (STRATEGY_TRANSFERS="origen>destino:usd,…")
      const tr = transfers().filter((t) => t.from === label || t.to === label);
      const ajuste = tr.reduce((a, t) => a + (t.to === label ? t.usd : -t.usd), 0);
      const aportado = Number(d.totalUsd ?? 0) + ajuste;
      const valor = enVault + porCobrar + sueltos + reservado, pnl = valor - aportado;
      const comisiones = ids.reduce((a, id) => a + (fees[id]?.usd ?? 0), 0);
      const cd = capitalDays((d.deposits ?? []).map((x) => ({ at: x.at, usd: x.usd })), aportado, now);
      const vol = pnl - rend;
      res[label] = { at: now, extra: !!d.extra, aportado, valor, enVault, porCobrar, sueltos, reservado, pnl, pnlPct: aportado > 0 ? pnl / aportado * 100 : null, comisiones, precio: pnl - comisiones,
        rendimiento: rend, rendMedido: medido, rendEstimado: estimado, rendDiarioPct: cd.capDays >= aportado * 0.25 && cd.capDays > 0 ? rend / cd.capDays * 100 : null, volatilidad: vol, volPct: aportado > 0 ? vol / aportado * 100 : null,
        capDias: cd.capDays, diarioPct: cd.capDays >= aportado * 0.25 && cd.capDays > 0 ? pnl / cd.capDays * 100 : null, dias: cd.days, n: d.n ?? 0, vaults };
      res[label].ajuste = ajuste;
      out.push(`dca estrategia ${s.net.beefy} ${label}: aportado ${f2(aportado)} (${d.n ?? 0} depósitos${ajuste ? `, ${ajuste > 0 ? "+" : "−"}${f2(Math.abs(ajuste))} ${ajuste > 0 ? "recibidos de" : "pasados a"} otra estrategia` : ""}) · valor ${f2(valor)} = en vaults ${f2(enVault)}${porCobrar >= 0.005 ? ` + por cobrar ${f2(porCobrar)}` : ""} + tokens sueltos ${f2(sueltos)} + apartado ${f2(reservado)} · RENDIMIENTO ${sg(rend)} (comisiones + recompensas estimadas con el APY de Beefy${medido >= 0.005 ? `; por cobrar ${f2(medido)}` : ""}) · VOLATILIDAD ${sg(vol)} (precio + pérdida impermanente) · total ${sg(pnl)} (${pc(res[label].pnlPct)})` +
        `${res[label].diarioPct !== null ? ` · ${pc(res[label].diarioPct)} por día` : ""} · vaults: ${vaults.map((v) => `${v.id} ${v.error ? "error " + v.error : f2(v.usd)}`).join(", ") || "—"}`);
    } catch (e) { out.push(`dca estrategia ${s.net.beefy} ${label}: error ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`); }
  }
  await s.store.set("wrapFees", fees).catch(() => {});
  const L = Object.values(res);
  if (L.length) {
    const t = L.reduce((a, x) => ({ aportado: a.aportado + x.aportado, valor: a.valor + x.valor, pnl: a.pnl + x.pnl, comisiones: a.comisiones + x.comisiones, rendimiento: a.rendimiento + x.rendimiento, capDias: a.capDias + x.capDias, posiciones: a.posiciones + x.enVault, sueltos: a.sueltos + x.sueltos, reservado: a.reservado + x.reservado }), { aportado: 0, valor: 0, pnl: 0, comisiones: 0, rendimiento: 0, capDias: 0, posiciones: 0, sueltos: 0, reservado: 0 });
    s0.lastStrategy = { at: now, ...t, pnlPct: t.aportado > 0 ? t.pnl / t.aportado * 100 : null, precio: t.pnl - t.comisiones, diarioPct: t.capDias > 0 ? t.pnl / t.capDias * 100 : null, n: L.reduce((a, x) => a + x.n, 0),
      rendDiarioPct: t.capDias > 0 ? t.rendimiento / t.capDias * 100 : null, volatilidad: t.pnl - t.rendimiento, volPct: t.aportado > 0 ? (t.pnl - t.rendimiento) / t.aportado * 100 : null };
    s0.lastStrategies = res;
    const hist = (await s.store.get("dcaStrategyHist").catch(() => null)) ?? [];
    hist.push({ at: new Date(now).toISOString(), aportado: +t.aportado.toFixed(4), valor: +t.valor.toFixed(4), pnl: +t.pnl.toFixed(4), comisiones: +t.comisiones.toFixed(4) });
    while (hist.length > 24 * 90) hist.shift();
    await s.store.set("dcaStrategyHist", hist).catch(() => {});
  }
  return out;
}

/** STRATEGY_TRANSFERS="demo>demo+AI-USDG:5.11" → [{from, to, usd}] (puro). */
export function transfers(env = process.env) {
  return String(env.STRATEGY_TRANSFERS || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const m = x.match(/^(.+?)>(.+):([\d.]+)$/); return m ? { from: m[1], to: m[2], usd: Number(m[3]) } : null; }).filter(Boolean);
}
