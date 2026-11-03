import { swapOut } from "./core.js";
// Rastreador de desajustes de precio entre pools del mismo par.
// Mide, bloque a bloque, cuánto difiere el precio entre los pools de un par y durante cuántos bloques
// el desajuste supera las comisiones (es decir, cuánto tarda el mercado en igualarlo). También detecta
// movimientos repentinos (saltos de precio en un pool) y si el resto del par los sigue o no.

export const MIN_DEPTH_USD = 2000; // pools con menos profundidad no cuentan (su "precio" no es cotizable)
export const MOVE_BPS = 50; // salto de precio de un pool entre bloques que se considera "movimiento repentino"
export const MAX_DUR_HIST = 60; // duraciones de episodios recordadas por par (para la mediana)
export const MAX_PAIRS = 400;
export const NOTIONAL_USD = 50; // tamaño de la operación con la que se mide el desajuste ejecutable (ida y vuelta)
export const MAX_DEVIATION_BPS = 2500; // un pool cuyo precio difiere >25% del de referencia no se considera cotizable

export function emptyDisloc() {
  return { v: 1, pairs: {}, open: {}, prev: {}, blocks: 0, lastBlock: null, moves: 0, episodes: 0, persistent: 0, recent: [] };
}

/** Precio bruto token1/token0 del pool (sin ajustar decimales: solo se compara dentro del mismo par). */
export function rawPrice(p) {
  if ((p.kind === "v3" || p.kind === "v4") && p.sqrtPriceX96 !== undefined) {
    const sp = Number(p.sqrtPriceX96) / 2 ** 96;
    return sp * sp;
  }
  if (p.reserve0 === 0n || p.reserve1 === 0n) return 0;
  return Number(p.reserve1) / Number(p.reserve0);
}

const units = (amt, tok) => Number(amt ?? 0n) / 10 ** tok.decimals;

/**
 * Precio en USD de cada token, tomado de su pool más profundo contra WETH o USDC.
 * Un token sin pool así no tiene precio (y sus pares no se miden): evita que pools abandonados
 * con precios absurdos cuenten como "desajustes".
 */
export function usdPrices(pools, ethUsd) {
  const px = new Map([["USDC", 1], ["WETH", ethUsd]]);
  const best = new Map(); // sym -> profundidad en USD del pool de referencia
  for (const p of pools) {
    if (!p.token0 || !p.token1 || p.reserve0 === 0n || p.reserve1 === 0n) continue;
    for (const [tok, quote, rt, rq] of [[p.token0, p.token1, p.reserve0, p.reserve1], [p.token1, p.token0, p.reserve1, p.reserve0]]) {
      const qpx = quote.sym === "USDC" ? 1 : quote.sym === "WETH" ? ethUsd : null;
      if (qpx === null || tok.sym === "USDC" || tok.sym === "WETH") continue;
      const depth = units(rq, quote) * qpx;
      if (depth < MIN_DEPTH_USD || depth <= (best.get(tok.sym) ?? 0)) continue;
      const price = (units(rq, quote) * qpx) / units(rt, tok);
      if (!(price > 0) || !Number.isFinite(price)) continue;
      best.set(tok.sym, depth); px.set(tok.sym, price);
    }
  }
  return px;
}

function depthUsd(p, px) {
  const a = px.get(p.token0.sym), b = px.get(p.token1.sym);
  if (a === undefined || b === undefined) return 0;
  return Math.min(units(p.reserve0, p.token0) * a, units(p.reserve1, p.token1) * b);
}

/** Desviación del precio del pool respecto a los precios de referencia (bps); pools "rotos" quedan fuera. */
function deviationBps(p, rawPx, px) {
  const ref = (px.get(p.token1.sym) ?? 0) / (px.get(p.token0.sym) ?? 1); // token1 por token0, en USD
  const adj = rawPx * 10 ** (p.token0.decimals - p.token1.decimals);
  const refRaw = 1 / ref; // precio token1/token0 = usd0/usd1
  return Math.abs(adj / refRaw - 1) * 1e4;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const pairKey = (p) => p.token0.address.toLowerCase() + ":" + p.token1.address.toLowerCase();
const poolLabel = (p) => `${p.dex ?? p.kind}${p.feeBps !== undefined ? ` ${p.feeBps}bps` : ""}`;

/**
 * Procesa un bloque. `attempted` = claves de ruta que Fase 1 intentó en este bloque (para saber si capturamos).
 * Devuelve los episodios cerrados en este bloque.
 */
export function trackBlock(d, { block, ts, pools, ethUsd, attempted = null }) {
  const groups = new Map();
  const prices = usdPrices(pools, ethUsd);
  for (const p of pools) {
    if (!p.token0 || !p.token1) continue;
    const px = rawPrice(p);
    if (!(px > 0) || !Number.isFinite(px)) continue;
    if (p.liquidity === 0n && (p.kind === "v3" || p.kind === "v4")) continue;
    if (depthUsd(p, prices) < MIN_DEPTH_USD) continue;
    if (deviationBps(p, px, prices) > MAX_DEVIATION_BPS) continue; // precio incoherente con el mercado: pool roto o sin cotizar
    const k = pairKey(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ p, px });
  }
  const closed = [];
  const gap = d.lastBlock !== null && block > d.lastBlock + 1;
  const seen = new Set();
  for (const [k, list] of groups) {
    // movimientos repentinos: salto de precio de un pool respecto al bloque anterior
    let moved = null;
    for (const { p, px } of list) {
      const prev = d.prev[p.address];
      if (prev && !gap) {
        const bps = Math.abs(px / prev - 1) * 1e4;
        if (bps >= MOVE_BPS) { moved = { pool: poolLabel(p), bps: Math.round(bps) }; }
      }
      d.prev[p.address] = px;
    }
    if (list.length < 2) continue;
    seen.add(k);
    // Desajuste EJECUTABLE: con $NOTIONAL_USD se vende token0 en el pool que más token1 devuelve y se recompra
    // token0 en el que más token0 devuelve por ese token1 (modelo exacto por ticks, comisiones incluidas).
    // excess > 0 => la ida y vuelta deja ganancia bruta antes de gas.
    const t0 = list[0].p.token0, t1 = list[0].p.token1;
    const px0 = prices.get(t0.sym), px1 = prices.get(t1.sym);
    const in0 = BigInt(Math.round((NOTIONAL_USD / px0) * 10 ** t0.decimals));
    let lo = null, hi = null, bestOut1 = 0n, bestRate0 = 0;
    for (const x of list) {
      const out1 = swapOut(x.p, t0.address, in0); // token1 por vender in0 token0
      if (out1 > bestOut1) { bestOut1 = out1; hi = x; }
    }
    if (!hi || bestOut1 === 0n) continue;
    for (const x of list) {
      if (x === hi) continue;
      const out0 = swapOut(x.p, t1.address, bestOut1); // token0 por recomprar con ese token1
      const rate = Number(out0) / Number(in0);
      if (rate > bestRate0) { bestRate0 = rate; lo = x; }
    }
    if (!lo) continue;
    const excess = (bestRate0 - 1) * 1e4; // bps netos de comisiones sobre el nocional
    const spreadBps = (hi.px / lo.px - 1) * 1e4;
    void px1;
    const label = `${list[0].p.token0.sym}/${list[0].p.token1.sym}`;
    const st = (d.pairs[k] ??= { label, pools: 0, blocks: 0, episodes: 0, dislocBlocks: 0, durations: [], maxDur: 0, peakExcess: 0, moves: 0, movesFollowed: 0, captured: 0, lastExcess: 0, lastSpread: 0, lastBlock: 0 });
    st.pools = list.length; st.blocks++; st.lastExcess = excess; st.lastSpread = spreadBps; st.lastBlock = block;
    if (moved) { st.moves++; d.moves++; }
    const o = d.open[k];
    if (excess > 0) {
      st.dislocBlocks++;
      if (o && !gap) {
        o.lastBlock = block; o.blocks++;
        if (excess > o.peakExcess) { o.peakExcess = excess; o.peakBlock = block; }
      } else {
        if (o) finish(d, k, o, closed);
        d.open[k] = { label, startBlock: block, lastBlock: block, blocks: 1, peakExcess: excess, peakBlock: block, low: poolLabel(lo.p), high: poolLabel(hi.p), lowAddr: lo.p.address, highAddr: hi.p.address, trigger: moved ? `salto ${moved.bps} bps en ${moved.pool}` : "deriva", captured: false, ts };
        st.episodes++; d.episodes++;
      }
      if (attempted && attempted.size) {
        const ep = d.open[k];
        if (!ep.captured && (attempted.has(lo.p.address) || attempted.has(hi.p.address))) { ep.captured = true; st.captured++; }
      }
    } else if (o) {
      finish(d, k, o, closed);
    }
    if (moved && excess <= 0 && d.prevExcess?.[k] > 0) st.movesFollowed++;
    (d.prevExcess ??= {})[k] = excess;
  }
  // pares que ya no se ven (pool sin profundidad): cerrar episodios colgados
  for (const k of Object.keys(d.open)) if (!seen.has(k)) finish(d, k, d.open[k], closed);
  d.blocks++; d.lastBlock = block;
  d.persistent = Object.values(d.pairs).filter((s) => s.durations.length >= 3 && median(s.durations) >= 3).length;
  const keys = Object.keys(d.pairs);
  if (keys.length > MAX_PAIRS) {
    keys.sort((a, b) => d.pairs[b].episodes - d.pairs[a].episodes);
    for (const k of keys.slice(MAX_PAIRS)) delete d.pairs[k];
  }
  if (Object.keys(d.prev).length > 20000) d.prev = {};
  return closed;
}

function finish(d, k, o, closed) {
  const st = d.pairs[k];
  if (st) {
    st.durations.push(o.blocks);
    if (st.durations.length > MAX_DUR_HIST) st.durations.shift();
    if (o.blocks > st.maxDur) st.maxDur = o.blocks;
    if (o.peakExcess > st.peakExcess) st.peakExcess = o.peakExcess;
  }
  const rec = { pair: o.label, startBlock: o.startBlock, endBlock: o.lastBlock, blocks: o.blocks, peakExcess: Math.round(o.peakExcess * 10) / 10, low: o.low, high: o.high, trigger: o.trigger, captured: o.captured, ts: o.ts };
  d.recent.push(rec);
  if (d.recent.length > 40) d.recent.shift();
  closed.push(rec);
  delete d.open[k];
}

/** Resumen para el API / panel: pares ordenados por persistencia del desajuste. */
export function summarize(d, top = 25) {
  const rows = Object.values(d.pairs)
    .filter((s) => s.episodes > 0)
    .map((s) => ({
      pair: s.label, pools: s.pools, episodes: s.episodes, blocks: s.blocks,
      share: s.blocks ? s.dislocBlocks / s.blocks : 0,
      medianDur: median(s.durations), maxDur: s.maxDur,
      peakExcess: Math.round(s.peakExcess * 10) / 10,
      moves: s.moves, captured: s.captured,
      nowExcess: Math.round(s.lastExcess * 10) / 10, nowSpread: Math.round(s.lastSpread * 10) / 10,
    }))
    .sort((a, b) => b.share * b.medianDur - a.share * a.medianDur || b.episodes - a.episodes);
  return {
    blocks: d.blocks, pairsTracked: Object.keys(d.pairs).length, episodes: d.episodes, moves: d.moves, persistent: d.persistent,
    open: Object.values(d.open).map((o) => ({ pair: o.label, blocks: o.blocks, peakExcess: Math.round(o.peakExcess * 10) / 10, low: o.low, high: o.high, trigger: o.trigger, captured: o.captured })),
    top: rows.slice(0, top), recent: d.recent.slice(-15).reverse(),
  };
}
