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
  const L = { q: 0, qCost: 0, xIn: 0, xCost: 0, sIn: 0, rewardX: 0, rewardS: 0, buys: { x: 0, s: 0 }, sells: { x: 0, s: 0 }, wd: { x: 0, s: 0 } };
  for (const m of moves) {
    if (m.type === "compra") { L.q += m.x; L.qCost += m.s; L.buys.x += m.x; L.buys.s += m.s; }
    else if (m.type === "ingresoX") { L.q += m.x; }
    else if (m.type === "venta") { const c = L.q > 0 ? L.qCost * Math.min(1, m.x / L.q) : 0; L.qCost -= c; L.q = Math.max(0, L.q - m.x); L.sells.x += m.x; L.sells.s += m.s; }
    else if (m.type === "deposito") {
      const fromInv = Math.min(m.x, L.q), c = L.q > 0 ? L.qCost * (fromInv / L.q) : 0;
      L.q -= fromInv; L.qCost -= c;
      if (m.reward) { L.rewardX += m.x; L.rewardS += m.s; continue; }
      // X que no venía de una compra registrada (p. ej. ya estaba en la wallet): se valora al precio de ese depósito si se conoce
      const extra = m.x - fromInv;
      L.xIn += m.x; L.xCost += c + (extra > 0 && m.price > 0 ? extra * m.price : 0); L.sIn += m.s;
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

const f2 = (n) => (n === null || !Number.isFinite(n) ? "—" : (n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(2));
const sg = (n) => (n === null || !Number.isFinite(n) ? "—" : (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toFixed(2));
const pc = (n) => (n === null || !Number.isFinite(n) ? "—" : (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(1) + " %");
const px = (n) => (n === null || !Number.isFinite(n) ? "—" : "$" + (n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toPrecision(5)));

/** Calcula el costo de cada vault del DCA y devuelve las líneas para el log. `s` = Strategy (provider, me, net, s.runs, store). */
export async function dcaCostReport(s, { ethUsd = null } = {}) {
  if (s.net?.wrapNative) return []; // cadenas donde el "estable" es WETH (Robinhood): los montos no serían USD
  const runs = Object.entries(s.s?.runs ?? {}).map(([k, r]) => ({ k, ...r })).filter((r) => r.vaultId && r.clm && Array.isArray(r.txs) && r.txs.length)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const byVault = {};
  for (const r of runs) (byVault[r.vaultId] ??= []).push(r);
  const cache = (await s.store.get("dcaCostRc")) ?? {};
  const p = s.provider, me = lc(s.me), S = s.net.stable, D = s.net.stableDec;
  const call = async (to, fn, args = []) => I.decodeFunctionResult(fn, await p.call({ to, data: I.encodeFunctionData(fn, args) }));
  const out = [];
  for (const [id, rs] of Object.entries(byVault)) {
    try {
      const m = rs[rs.length - 1], X = m.x;
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
            const rc = await p.getTransactionReceipt(t.hash).catch(() => null);
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
        if (/#\d+$/.test(r.k) && r.status === "hecho") deps.push({ at: r.startedAt, usd: Number(BigInt(r.usdcIn ?? "0")) / 10 ** D, price: runPrice ?? runBuyPx });
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
      out.push(`dca costo ${id}: ${deps.length} depósitos DCA ($${dca.usd.toFixed(2)})${rs.length > deps.length ? ` + ${rs.length - deps.length} barridos/otros` : ""}` +
        ` · invertido ${f2(b.invested)} = ${f2(L.sIn)} ${s.net.stableSym} + ${L.xIn.toPrecision(6)} ${symX} a precio medio ${px(b.avgX)}${prior ? ` + previo ${f2(prior)}` : ""}` +
        ` · precio ${symX} hoy ${px(price)} (vs medio ${b.avgX ? pc((price / b.avgX - 1) * 100) : "—, sin X"}) · precio medio DCA ${px(dca.price)}${dca.missing ? ` (${dca.missing} sin precio)` : ""}${dca.price ? ` → hoy ${pc((price / dca.price - 1) * 100)}` : ""}` +
        ` · ${closed ? "posición cerrada" : `valor ${f2(valueUsd)} (${sNow.toFixed(2)} ${s.net.stableSym} + ${xNow.toPrecision(5)} ${symX}, ${valueUsd > 0 ? Math.round(xNow * price / valueUsd * 100) : 0} % en ${symX})`} + recompensas ${f2(rewardsUsd)}${rw.length ? ` [${rw.join(", ")}]` : ""}` +
        ` · PnL ${sg(b.pnl)} (${pc(b.pnlPct)}) = precio ${sg(b.priceEffect)} + comisiones ${sg(b.fees)} + rango/IL ${sg(b.rangeIl)} · hodl ${f2(b.hodl)}` +
        `${L.q > 0 ? ` · ${symX} en wallet ${L.q.toPrecision(5)} (${f2(L.q * price)})` : ""}${L.rewardX || L.rewardS ? ` · reinvertido de recompensas ${L.rewardS.toFixed(3)} ${s.net.stableSym} + ${L.rewardX.toPrecision(4)} ${symX}` : ""}` +
        `${L.wd.x || L.wd.s ? ` · retirado ${L.wd.s.toFixed(2)} ${s.net.stableSym} + ${L.wd.x.toPrecision(5)} ${symX}` : ""}${missing ? ` · ${missing} recibos no disponibles` : ""}`);
    } catch (e) { out.push(`dca costo ${id}: error ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`); }
  }
  await s.store.set("dcaCostRc", cache).catch(() => {});
  return out;
}
