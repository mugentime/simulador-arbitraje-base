// Simulación de la estrategia del punto 6: back-run de rebalanceos y zaps de vaults + keeper de harvest.
// Comparte el pipeline del protocolo: los eventos solo dicen QUÉ pool mirar; la detección, el tamaño
// óptimo y el filtro de EV son los mismos de siempre. No envía transacciones.

import * as core from "./core.js";

const MAX_RECENT = 60;

export function emptyVaultStats() {
  return {
    version: 1,
    blocks: 0,
    events: { rebalanceo: 0, zap: 0, salida: 0 },
    withOpp: 0, // eventos que dejaron una oportunidad con EV > 0 en su bloque
    netUsd: 0, // tope superior: suma de netos de esas oportunidades
    byManager: {}, // addr -> {label, kind, events, withOpp, netUsd, lastBlock}
    recent: [], // últimos eventos con el resultado del back-run simulado
    harvest: [], // estrategias Beefy: callReward vs gas
    harvestUpdatedAt: null,
  };
}

/** Desvío del precio del pool contra la mediana de su par, en bps (mide cuánto movió el evento). */
export function poolDeviationBps(pool, pools) {
  const key = [pool.token0.address, pool.token1.address].map((a) => a.toLowerCase()).sort().join();
  const peers = pools.filter((p) => p.reserve0 > 0n && [p.token0.address, p.token1.address].map((a) => a.toLowerCase()).sort().join() === key);
  if (peers.length < 2) return null;
  const px = (p) => core.poolPrice(p, pool.token0.sym);
  const prices = peers.map(px).filter((x) => isFinite(x) && x > 0).sort((a, b) => a - b);
  if (prices.length < 2) return null;
  const med = prices[Math.floor(prices.length / 2)];
  const mine = px(pool);
  return isFinite(mine) ? ((mine - med) / med) * 10000 : null;
}

/**
 * Atribuye a cada evento de vault la mejor ruta rentable que toca su pool en ese bloque.
 * results: salida de evaluateAll para el bloque (ya con tamaño óptimo, gas y proveedor).
 */
export function processVaultBlock(stats, { block, ts, events, results, pools, ethUsd, managers }) {
  stats.blocks++;
  const out = [];
  for (const ev of events) {
    stats.events[ev.kind] = (stats.events[ev.kind] ?? 0) + 1;
    const touching = results.filter((r) => r.route.some((p) => p.address === ev.pool.address));
    const best = touching.filter((r) => r.profitable).sort((a, b) => b.netUsd - a.netUsd)[0] ?? touching.sort((a, b) => b.netUsd - a.netUsd)[0] ?? null;
    const m = managers?.get(ev.actor);
    const label = m?.label ?? ev.actor.slice(0, 8) + "…";
    const kind = m?.kind ?? "otro";
    const sold = soldUsd(ev, ethUsd);
    const dev = poolDeviationBps(ev.pool, pools);
    const rec = {
      block, ts, tx: ev.tx, kind: ev.kind, manager: label, managerKind: kind, actor: ev.actor,
      pool: `${ev.pool.dex} ${ev.pool.token0.sym}/${ev.pool.token1.sym} ${(ev.pool.feeBps / 100).toFixed(ev.pool.feeBps < 10 ? 3 : 2)}%`,
      soldUsd: sold, deviationBps: dev,
      opp: best ? { profitable: best.profitable, netUsd: best.netUsd, amountInUsd: best.amountInUsd, lender: best.lender, hops: best.hops, start: best.start, marginalBps: best.marginalBps, needsV4: !!best.needsV4 } : null,
    };
    out.push(rec);
    const bm = (stats.byManager[ev.actor] ??= { label, kind, events: 0, withOpp: 0, netUsd: 0, lastBlock: 0 });
    bm.events++; bm.lastBlock = block; bm.label = label; bm.kind = kind;
    if (best?.profitable) { stats.withOpp++; stats.netUsd += best.netUsd; bm.withOpp++; bm.netUsd += best.netUsd; }
    stats.recent.unshift(rec);
  }
  if (stats.recent.length > MAX_RECENT) stats.recent.length = MAX_RECENT;
  const keys = Object.keys(stats.byManager);
  if (keys.length > 200) { keys.sort((a, b) => stats.byManager[b].events - stats.byManager[a].events); for (const k of keys.slice(150)) delete stats.byManager[k]; }
  return out;
}

function soldUsd(ev, ethUsd) {
  const val = (amt, tok) => {
    const u = Number(amt) / 10 ** tok.decimals;
    if (tok.sym === "USDC") return u;
    if (tok.sym === "WETH") return u * ethUsd;
    return null;
  };
  const a = val(ev.sold0, ev.pool.token0), b = val(ev.sold1, ev.pool.token1);
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Lista de harvest: recompensa al caller vs gas, para cada estrategia Beefy vista. */
export function harvestTable(managers, gas, ethUsd, ts) {
  const gasUsd = (Number(core.HARVEST_GAS * (gas.baseFee + gas.priority) + gas.l1Fee) / 1e18) * ethUsd;
  const rows = [];
  for (const m of managers.values()) {
    if (!m.beefy || m.callReward === null) continue;
    const rewardUsd = (Number(m.callReward) / 1e18) * ethUsd; // callReward se paga en el token nativo (WETH en Base)
    rows.push({ address: m.address, label: m.label, rewardUsd, gasUsd, netUsd: rewardUsd - gasUsd, worth: rewardUsd > gasUsd * 1.5,
      lastHarvest: m.lastHarvest, sinceMin: m.lastHarvest ? Math.round((ts - m.lastHarvest) / 60) : null });
  }
  rows.sort((a, b) => b.netUsd - a.netUsd);
  return rows;
}
