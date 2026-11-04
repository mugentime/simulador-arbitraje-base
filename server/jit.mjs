// Liquidez JIT ("just in time") — modo observación.
// Para un swap pendiente que va a un pool v3, calcula cuánto habríamos ganado si, en el mismo bloque y justo antes
// del swap, ponemos liquidez concentrada (con préstamo flash) en el rango por el que va a moverse el precio,
// dejamos que la víctima pague la comisión, retiramos la liquidez y deshacemos el inventario.
//
// Modelo (aproximado, liquidez constante dentro del movimiento):
//   L = Lpool + Ljit;  zeroForOne: 1/√P1 = 1/√P0 + a(1−f)/L ; oneForZero: √P1 = √P0 + a(1−f)/L
//   cantidades de la posición en el rango [Pa,Pb]: x = Lj(1/√P − 1/√Pb), y = Lj(√P − √Pa)
//   neto (conservador) = comisión capturada (Lj/L · f·a) + cambio de inventario valorado al precio posterior (P1)
//   neto optimista = igual pero valorando el inventario al precio externo previo (P0), si se deshace en otro pool
//          − deshacer el exceso del token de entrada (comisión f) − préstamo (bps sobre lo prestado) − gas
// Se prueba una rejilla de tamaños Lj = k·Lpool y se queda el mejor, con tope de nocional.

const Q96 = 2 ** 96;
const LOG_TICK = Math.log(1.0001);

/** Precios en USD por dirección de token, a partir del universo (USDC=1, WETH=precio del nativo). */
export function buildUsdPrices(pools, tokens, ethUsd) {
  const px = new Map();
  if (tokens?.USDC) px.set(tokens.USDC.address.toLowerCase(), 1);
  if (tokens?.WETH && isFinite(ethUsd)) px.set(tokens.WETH.address.toLowerCase(), ethUsd);
  const usable = pools.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n && p.token0?.address && p.token1?.address);
  for (let pass = 0; pass < 3; pass++) {
    // pools con más profundidad (en el lado ya valorado) primero
    const cands = [];
    for (const p of usable) {
      const a0 = p.token0.address.toLowerCase(), a1 = p.token1.address.toLowerCase();
      const k0 = px.get(a0), k1 = px.get(a1);
      if ((k0 === undefined) === (k1 === undefined)) continue;
      const h0 = Number(p.reserve0) / 10 ** p.token0.decimals, h1 = Number(p.reserve1) / 10 ** p.token1.decimals;
      if (!(h0 > 0 && h1 > 0)) continue;
      const depth = k0 !== undefined ? h0 * k0 : h1 * k1;
      if (depth < 5000) continue; // pools de juguete no fijan precio
      cands.push({ a0, a1, k0, k1, h0, h1, depth });
    }
    cands.sort((x, y) => y.depth - x.depth);
    for (const c of cands) {
      if (c.k0 !== undefined && !px.has(c.a1)) px.set(c.a1, (c.h0 * c.k0) / c.h1);
      else if (c.k1 !== undefined && !px.has(c.a0)) px.set(c.a0, (c.h1 * c.k1) / c.h0);
    }
  }
  return px;
}

const tickOf = (sqrtP) => Math.floor(Math.log(sqrtP * sqrtP) / LOG_TICK);
const sqrtAt = (tick) => Math.sqrt(1.0001 ** tick);

/**
 * Evalúa JIT para un swap de entrada exacta `amountIn` (unidades crudas) de `tokenIn` en el pool v3 `p`.
 * Devuelve null si no aplica o {netUsd, feeUsd, invUsd, backUsd, borrowUsd, gasUsd, notionalUsd, share, ticks, k}.
 */
export function evaluateJit(p, tokenIn, amountIn, { prices, gasUsd = 0, borrowBps = 5, maxNotionalUsd = 200_000, grid, backFee } = {}) {
  if (!p || p.kind !== "v3" || !p.sqrtPriceX96 || !p.liquidity || !p.tickSpacing) return null;
  const a = Number(amountIn);
  const Lp = Number(p.liquidity);
  if (!(a > 0) || !(Lp > 0)) return null;
  const f = Number(p.feePips) / 1e6;
  const zf1 = tokenIn.toLowerCase() === p.token0.address.toLowerCase();
  const tIn = zf1 ? p.token0 : p.token1, tOut = zf1 ? p.token1 : p.token0;
  const pxIn = prices.get(tIn.address.toLowerCase()), pxOut = prices.get(tOut.address.toLowerCase());
  if (!(pxIn > 0) || !(pxOut > 0)) return null;
  // precio USD por unidad cruda
  const u0 = (zf1 ? pxIn : pxOut) / 10 ** p.token0.decimals, u1 = (zf1 ? pxOut : pxIn) / 10 ** p.token1.decimals;
  const s0 = Number(p.sqrtPriceX96) / Q96;
  const swapUsd = a * (zf1 ? u0 : u1);
  const ts = p.tickSpacing;
  let best = null;
  for (const k of grid ?? [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]) {
    const Lj = k * Lp, L = Lp + Lj, ae = a * (1 - f);
    const s1 = zf1 ? 1 / (1 / s0 + ae / L) : s0 + ae / L;
    if (!(s1 > 0) || !isFinite(s1)) continue;
    const t0 = tickOf(s0), t1 = tickOf(s1);
    const lo = Math.floor(Math.min(t0, t1) / ts) * ts, hi = (Math.floor(Math.max(t0, t1) / ts) + 1) * ts;
    const sa = sqrtAt(lo), sb = sqrtAt(hi);
    // posición antes y después del swap (crudo)
    const x0 = Lj * (1 / s0 - 1 / sb), y0 = Lj * (s0 - sa);
    const x1 = Lj * (1 / s1 - 1 / sb), y1 = Lj * (s1 - sa);
    if (x0 < 0 || y0 < 0) continue;
    const notionalUsd = x0 * u0 + y0 * u1;
    if (notionalUsd > maxNotionalUsd) break;
    const share = Lj / L;
    const feeUsd = share * f * a * (zf1 ? u0 : u1);
    // cambio de inventario valorado al precio externo previo (P0): la víctima nos compra caro
    const invUsd = (x1 - x0) * u0 + (y1 - y0) * u1;
    // exceso del token de entrada que hay que convertir de vuelta para devolver el préstamo
    const excessUsd = zf1 ? Math.max(0, x1 - x0) * u0 : Math.max(0, y1 - y0) * u1;
    const backUsd = excessUsd * (backFee ?? f); // deshacer en el pool más barato del par (si se conoce)
    const borrowUsd = notionalUsd * borrowBps / 1e4;
    // conservador: el inventario se deshace en el mismo pool al precio posterior al swap (P1) → pérdida impermanente
    const invP1Usd = (x1 - x0) * u1 * s1 * s1 + (y1 - y0) * u1;
    const netOptUsd = feeUsd + invUsd - backUsd - borrowUsd - gasUsd;
    const netUsd = feeUsd + invP1Usd - backUsd - borrowUsd - gasUsd;
    if (!best || netUsd > best.netUsd) best = { netUsd, netOptUsd, feeUsd, invUsd: invP1Usd, invOptUsd: invUsd, backUsd, borrowUsd, gasUsd, notionalUsd, share, k, swapUsd, ticks: (hi - lo) / ts, feePct: f * 100 };
  }
  return best;
}

export function emptyJit() {
  return { evaluated: 0, positive: 0, sumNetUsd: 0, best: null, last: [] };
}
