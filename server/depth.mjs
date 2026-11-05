// Profundidad de mercado por pool y "cash in" en vaults CLM de Beefy.
// Profundidad: USD que se pueden vender (token → base) o comprar (base → token) antes de que el impacto de precio
// (sin contar la comisión del pool) llegue a 1 %, 2 % y 5 %. Usa el modelo exacto por ticks (tabla de ticks cercanos:
// si se agota, la salida es un piso → la profundidad sale conservadora).
import * as core from "../src/core.js";

const LEVELS = [0.01, 0.02, 0.05];

function usdPerUnit(tok, ethUsd) {
  return tok.sym === "USDC" ? 1 / 10 ** tok.decimals : tok.sym === "WETH" ? ethUsd / 10 ** tok.decimals : NaN;
}
const toBig = (x) => (x >= 1 ? BigInt(Math.floor(x)) : 0n);

/** Para un pool con un lado base (WETH/USDC por rol): funciones de costo en ambos sentidos. */
function poolSides(p, ethUsd) {
  const isBase = (t) => t.sym === "USDC" || t.sym === "WETH";
  const b = isBase(p.token0) ? p.token0 : isBase(p.token1) ? p.token1 : null;
  if (!b) return null;
  const x = b === p.token0 ? p.token1 : p.token0;
  const ub = usdPerUnit(b, ethUsd);
  const [rb, rx] = core.reservesFor(p, b.address);
  if (!(ub > 0) || rb <= 0n || rx <= 0n) return null;
  const feeSell = Number(core.feeFor(p, x.address)) / 1e6, feeBuy = Number(core.feeFor(p, b.address)) / 1e6;
  // precio medio (base por unidad de x) con un monto ínfimo, sin comisión
  const eps = rx / 10_000_000n > 0n ? rx / 10_000_000n : 1n;
  const outEps = core.swapOut(p, x.address, eps);
  if (outEps <= 0n) return null;
  const mid = Number(outEps) / Number(eps) / (1 - feeSell); // unidades base por unidad x
  const usdPerX = mid * ub;
  const sell = (usd) => { const a = toBig(usd / usdPerX); if (a <= 0n) return 1; const o = Number(core.swapOut(p, x.address, a)) * ub; return 1 - o / usd; };
  const buy = (usd) => { const a = toBig(usd / ub); if (a <= 0n) return 1; const o = Number(core.swapOut(p, b.address, a)) * usdPerX; return 1 - o / usd; };
  const tvlUsd = Number(rb) * ub * 2;
  return { b, x, sell, buy, feeSell, feeBuy, usdPerX, tvlUsd };
}

function depthAt(costFn, fee, level, maxUsd) {
  let lo = 0, hi = maxUsd;
  if (costFn(hi) - fee < level) return hi; // ni con todo llega al nivel (tabla de ticks agotada o pool enorme)
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (costFn(m) - fee < level) lo = m; else hi = m; }
  return lo;
}

export function poolDepth(pools, ethUsd) {
  const rows = [];
  for (const p of pools) {
    const s = poolSides(p, ethUsd);
    if (!s) continue;
    const cap = Math.max(1e3, s.tvlUsd * 5);
    rows.push({
      pool: p.address, dex: p.dex, kind: p.kind, pair: `${s.x.sym}/${s.b.sym}`, token: s.x.address, feeBps: +(s.feeSell * 1e4).toFixed(2),
      virtualTvlUsd: Math.round(s.tvlUsd),
      sellUsd: Object.fromEntries(LEVELS.map((l) => [`${l * 100}%`, Math.round(depthAt(s.sell, s.feeSell, l, cap))])),
      buyUsd: Object.fromEntries(LEVELS.map((l) => [`${l * 100}%`, Math.round(depthAt(s.buy, s.feeBuy, l, cap))])),
      _s: s,
    });
  }
  return rows;
}

/**
 * Cash in en un vault CLM: entra con D USD (zap: compra la mitad del token volátil), cobra el APY diluido por su propio
 * depósito (recompensas fijas repartidas en TVL + D) y sale vendiendo la mitad volátil. Costos = comisión + impacto en el
 * mejor pool del par. Días para recuperar costos = (entrada + salida) / ganancia diaria. No incluye pérdida impermanente.
 */
export function cashIn(vaults, depthRows, sizes = [1_000, 5_000, 25_000]) {
  const out = [];
  for (const v of vaults) {
    const [a, b] = v.tokens.map((t) => t.toLowerCase());
    const cands = depthRows.filter((r) => { const t0 = r.token.toLowerCase(), t1 = r._s.b.address.toLowerCase(); return (t0 === a && t1 === b) || (t0 === b && t1 === a); });
    if (!cands.length) { out.push({ vault: v.name, apyPct: +(v.apy * 100).toFixed(1), tvlUsd: Math.round(v.tvlUsd), watched: false }); continue; }
    const best = cands.sort((x, y) => y.sellUsd["2%"] - x.sellUsd["2%"])[0];
    const rDaily = Math.pow(1 + v.apy, 1 / 365) - 1;
    const bySize = sizes.map((D) => {
      const half = D / 2;
      const entry = best._s.buy(half) * half, exit = best._s.sell(half) * half;
      const daily = v.tvlUsd > 0 ? (v.tvlUsd * rDaily * D) / (v.tvlUsd + D) : 0;
      const effApy = v.tvlUsd > 0 ? Math.pow(1 + (daily / D), 365) - 1 : 0;
      return { depositUsd: D, entryCostUsd: +entry.toFixed(2), exitCostUsd: +exit.toFixed(2), dailyUsd: +daily.toFixed(2), effectiveApyPct: +(effApy * 100).toFixed(1), breakevenDays: daily > 0 ? +((entry + exit) / daily).toFixed(2) : null };
    });
    out.push({ vault: v.name, apyPct: +(v.apy * 100).toFixed(1), tvlUsd: Math.round(v.tvlUsd), watched: true, pool: best.pool, dex: best.dex, feeBps: best.feeBps, sellDepthUsd: best.sellUsd, buyDepthUsd: best.buyUsd, poolsOfPair: cands.length, bySize });
  }
  return out.sort((x, y) => (y.tvlUsd ?? 0) - (x.tvlUsd ?? 0));
}

export const publicRows = (rows) => rows.map(({ _s, ...r }) => r);
