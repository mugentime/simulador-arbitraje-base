// Matemática exacta de liquidez concentrada (Uniswap v3 / v4 y forks): swap con cruce de ticks.
// Réplica en BigInt de TickMath, SqrtPriceMath y SwapMath de Uniswap v3-core. Sin dependencias.
//
// Un pool v3 se describe con: sqrtPriceX96, tick, liquidity (L activa), feePips, tickSpacing y una tabla
// de ticks inicializados cercanos [{tick, liquidityNet}] ordenada. El swap avanza de tick en tick: dentro
// de cada tramo la curva es x·y=k con reservas virtuales (L/√P, L·√P); al cruzar un tick cambia L.

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MAX_U256 = (1n << 256n) - 1n;

/** √P·2^96 en el tick dado (TickMath.getSqrtRatioAtTick). */
const sqrtCache = new Map();
export function getSqrtRatioAtTick(tick) {
  const c = sqrtCache.get(tick);
  if (c !== undefined) return c;
  const v = _getSqrtRatioAtTick(tick);
  if (sqrtCache.size > 200000) sqrtCache.clear();
  sqrtCache.set(tick, v);
  return v;
}
function _getSqrtRatioAtTick(tick) {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error("tick fuera de rango");
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const M = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n], [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of M) if ((absTick & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = MAX_U256 / ratio;
  // de Q128.128 a Q64.96, redondeando hacia arriba
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}

/** Tick del precio dado (búsqueda binaria sobre getSqrtRatioAtTick; exacto). */
export function getTickAtSqrtRatio(sqrtP) {
  if (sqrtP < MIN_SQRT_RATIO || sqrtP >= MAX_SQRT_RATIO) throw new Error("√P fuera de rango");
  let lo = MIN_TICK, hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtP) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const mulDiv = (a, b, d) => (a * b) / d;
const mulDivUp = (a, b, d) => { const n = a * b; return n / d + (n % d === 0n ? 0n : 1n); };
const divUp = (a, d) => a / d + (a % d === 0n ? 0n : 1n);

/** SqrtPriceMath.getAmount0Delta: cantidad de token0 entre dos precios para liquidez L. */
export function getAmount0Delta(sqrtA, sqrtB, L, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const num1 = L << 96n, num2 = sqrtB - sqrtA;
  if (sqrtA <= 0n) throw new Error("√P = 0");
  return roundUp ? divUp(mulDivUp(num1, num2, sqrtB), sqrtA) : mulDiv(num1, num2, sqrtB) / sqrtA;
}

/** SqrtPriceMath.getAmount1Delta: cantidad de token1 entre dos precios para liquidez L. */
export function getAmount1Delta(sqrtA, sqrtB, L, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivUp(L, sqrtB - sqrtA, Q96) : mulDiv(L, sqrtB - sqrtA, Q96);
}

/** SqrtPriceMath.getNextSqrtPriceFromInput: precio tras meter `amountIn` (exact input). */
export function getNextSqrtPriceFromInput(sqrtP, L, amountIn, zeroForOne) {
  if (sqrtP <= 0n || L <= 0n) throw new Error("estado inválido");
  if (amountIn === 0n) return sqrtP;
  if (zeroForOne) {
    const num1 = L << 96n;
    const denom = num1 + amountIn * sqrtP;
    return mulDivUp(num1, sqrtP, denom);
  }
  return sqrtP + (amountIn << 96n) / L;
}

/** SwapMath.computeSwapStep para exact input. Devuelve {sqrtNext, amountIn, amountOut, feeAmount}. */
export function computeSwapStep(sqrtCurrent, sqrtTarget, L, amountRemaining, feePips) {
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  const lessFee = mulDiv(amountRemaining, 1000000n - feePips, 1000000n);
  let amountIn = zeroForOne ? getAmount0Delta(sqrtTarget, sqrtCurrent, L, true) : getAmount1Delta(sqrtCurrent, sqrtTarget, L, true);
  let sqrtNext;
  if (lessFee >= amountIn) sqrtNext = sqrtTarget;
  else sqrtNext = getNextSqrtPriceFromInput(sqrtCurrent, L, lessFee, zeroForOne);
  const max = sqrtTarget === sqrtNext;
  if (!max) amountIn = zeroForOne ? getAmount0Delta(sqrtNext, sqrtCurrent, L, true) : getAmount1Delta(sqrtCurrent, sqrtNext, L, true);
  const amountOut = zeroForOne ? getAmount1Delta(sqrtNext, sqrtCurrent, L, false) : getAmount0Delta(sqrtCurrent, sqrtNext, L, false);
  const feeAmount = !max ? amountRemaining - amountIn : mulDivUp(amountIn, feePips, 1000000n - feePips);
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

/**
 * Swap exact-input con cruce de ticks.
 * state: { sqrtPriceX96, tick, liquidity, feePips, tickSpacing, ticks: [{tick, liquidityNet}] ordenados asc }
 * Devuelve { amountOut, amountInUsed, sqrtPriceAfter, tickAfter, crossed, truncated }.
 * `truncated` = se acabó la tabla de ticks conocida antes de consumir todo el monto (la salida es un piso).
 */
export function swapExactIn(state, zeroForOne, amountIn, sqrtLimit = null) {
  let sqrtP = state.sqrtPriceX96, L = state.liquidity, tick = state.tick;
  const spacing = state.tickSpacing || 1;
  let remaining = amountIn, amountOut = 0n, crossed = 0, truncated = false;
  const ticks = state.ticks ?? [];
  const limit = sqrtLimit ?? (zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n);
  // índice del siguiente tick inicializado en la dirección del swap
  let idx = zeroForOne ? lastIndexLE(ticks, tick) : firstIndexGT(ticks, tick);
  let guard = 0;
  while (remaining > 0n && sqrtP !== limit && guard++ < 2048) {
    // Como el pool: el siguiente "tick" es el inicializado más cercano o, si no hay en la palabra del bitmap,
    // el borde de la palabra (sin cruce). Replicar ese paso intermedio mantiene el redondeo idéntico al del contrato.
    const compressed = Math.floor(tick / spacing);
    let boundary;
    if (zeroForOne) boundary = ((compressed >> 8) * 256) * spacing;
    else { const c1 = compressed + 1; boundary = (((c1 >> 8) + 1) * 256 - 1) * spacing; }
    let initTick = null;
    if (zeroForOne && idx >= 0) initTick = ticks[idx].tick; else if (!zeroForOne && idx < ticks.length) initTick = ticks[idx].tick;
    let nextTick, initialized;
    if (initTick !== null && (zeroForOne ? initTick >= boundary : initTick <= boundary)) { nextTick = initTick; initialized = true; }
    else { nextTick = boundary; initialized = false; if (initTick === null && ticks.length) truncated = true; }
    if (nextTick < MIN_TICK) nextTick = MIN_TICK; if (nextTick > MAX_TICK) nextTick = MAX_TICK;
    const sqrtNextTick = getSqrtRatioAtTick(nextTick);
    const sqrtTarget = zeroForOne ? (sqrtNextTick < limit ? limit : sqrtNextTick) : (sqrtNextTick > limit ? limit : sqrtNextTick);
    if (L === 0n) {
      sqrtP = sqrtTarget; // sin liquidez en el tramo: el precio salta sin intercambiar
    } else {
      const step = computeSwapStep(sqrtP, sqrtTarget, L, remaining, state.feePips);
      sqrtP = step.sqrtNext;
      remaining -= step.amountIn + step.feeAmount;
      amountOut += step.amountOut;
    }
    if (sqrtP === sqrtNextTick) {
      if (initialized) {
        const net = ticks[idx].liquidityNet;
        L += zeroForOne ? -net : net;
        if (L < 0n) L = 0n;
        crossed++;
        idx += zeroForOne ? -1 : 1;
      }
      tick = zeroForOne ? nextTick - 1 : nextTick;
      if (nextTick === MIN_TICK || nextTick === MAX_TICK) { truncated = truncated || remaining > 0n; break; }
      if (!initialized && initTick === null && ticks.length && L === 0n) { truncated = truncated || remaining > 0n; break; }
    } else if (sqrtP !== limit) {
      tick = getTickAtSqrtRatio(sqrtP);
      break; // monto consumido dentro del tramo
    } else break;
  }
  if (remaining > 0n && guard >= 2048) truncated = true;
  return { amountOut, amountInUsed: amountIn - remaining, sqrtPriceAfter: sqrtP, tickAfter: tick, liquidityAfter: L, crossed, truncated };
}

function lastIndexLE(ticks, t) { let lo = 0, hi = ticks.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ticks[m].tick <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
function firstIndexGT(ticks, t) { let lo = 0, hi = ticks.length - 1, r = ticks.length; while (lo <= hi) { const m = (lo + hi) >> 1; if (ticks[m].tick > t) { r = m; hi = m - 1; } else lo = m + 1; } return r; }

/** Posiciones de bits a ticks: palabra `wordPos` del tickBitmap (256 bits), devuelve ticks inicializados. */
export function ticksFromBitmapWord(wordPos, bits, tickSpacing) {
  const out = [];
  if (bits === 0n) return out;
  for (let i = 0; i < 256; i++) if ((bits >> BigInt(i)) & 1n) out.push((wordPos * 256 + i) * tickSpacing);
  return out;
}

/** Palabra del bitmap que contiene el tick (compressed = floor(tick / spacing)). */
export function wordPosOf(tick, tickSpacing) {
  return Math.floor(tick / tickSpacing) >> 8; // floor redondea hacia −∞ como en Solidity; >> aritmético
}
