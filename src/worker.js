// Worker 24/7: corre el pipeline del protocolo bloque a bloque en el servidor y acumula resultados.
// Independiente de la plataforma: recibe ethers, un provider y un "store" con get/set de JSON.
// En Netlify el store es Netlify Blobs; en las pruebas, un Map en memoria.

import * as core from "./core.js";

export const MIN_LIQ = {
  [core.TOKENS.WETH.address.toLowerCase()]: 5n * 10n ** 16n, // 0.05 WETH
  [core.TOKENS.USDC.address.toLowerCase()]: 150n * 10n ** 6n, // 150 USDC
};
export const HEARTBEAT_STALE_MS = 45_000;
export const BUILDING_STALE_MS = 4 * 60_000; // armar el universo puede tardar minutos con RPC públicos
const UNIVERSE_TTL_MS = 30 * 60_000; // el universo se reconstruye cada 30 min; mientras, se reutiliza
const MAX_EVENTS = 500;
const MAX_HOURS = 24 * 14;

export function emptyStats() {
  return {
    version: 1,
    startedAt: null,
    blocksProcessed: 0,
    blocksWithOpp: 0,
    firstBlock: null,
    lastBlock: null,
    lastBlockTs: null,
    heartbeat: null,
    runs: 0,
    universe: { pools: 0, cycles: 0, builtAt: null },
    totals: { episodes: 0, netUsd: 0, grossUsd: 0, gasUsd: 0, flashFeeUsd: 0, over1Usd: 0, over1NetUsd: 0, needsV4: 0 },
    best: null,
    byRoute: {}, // key -> {label, episodes, netUsd, lastBlock}
    hourly: [], // [{h: epochHour, episodes, netUsd, blocks}]
    open: {}, // episodios abiertos: routeKey -> {startBlock, netUsd, peakUsd}
    gaps: [], // huecos de cobertura [{from, to}]
    lastError: null,
    phase: null,
  };
}

function routeLabel(r) {
  let t = r.start;
  const parts = [r.start];
  for (const p of r.route) {
    const nxt = p.token0.sym === t ? p.token1.sym : p.token0.sym;
    parts.push(`${p.dex} ${(p.feeBps / 100).toFixed(p.feeBps < 10 ? 3 : 2)}% → ${nxt}`);
    t = nxt;
  }
  return parts.join(" → ");
}

/**
 * Contabilidad por episodios: una ruta rentable en bloques consecutivos cuenta UNA vez,
 * con el beneficio de su primer bloque (si el protocolo la hubiera ejecutado, el arbitraje
 * habría cerrado la diferencia). Es un tope superior: asume que nadie más la toma antes.
 */
export function accountBlock(stats, block, ts, results) {
  const winners = results.filter((r) => r.profitable);
  const nowKeys = new Set(winners.map((r) => r.key));
  const hour = Math.floor(ts / 3600);
  let h = stats.hourly[stats.hourly.length - 1];
  if (!h || h.h !== hour) {
    h = { h: hour, episodes: 0, netUsd: 0, blocks: 0 };
    stats.hourly.push(h);
    if (stats.hourly.length > MAX_HOURS) stats.hourly.shift();
  }
  h.blocks++;
  const events = [];
  // cerrar episodios que ya no están
  for (const key of Object.keys(stats.open)) if (!nowKeys.has(key)) delete stats.open[key];
  for (const r of winners) {
    const o = stats.open[r.key];
    if (o) { o.peakUsd = Math.max(o.peakUsd, r.netUsd); o.lastBlock = block; continue; }
    stats.open[r.key] = { startBlock: block, lastBlock: block, netUsd: r.netUsd, peakUsd: r.netUsd };
    const label = routeLabel(r);
    const t = stats.totals;
    t.episodes++; t.netUsd += r.netUsd; t.grossUsd += r.grossUsd; t.gasUsd += r.gasUsd; t.flashFeeUsd += r.flashFeeUsd;
    if (r.netUsd >= 1) { t.over1Usd++; t.over1NetUsd += r.netUsd; }
    if (r.needsV4) t.needsV4++;
    h.episodes++; h.netUsd += r.netUsd;
    const br = (stats.byRoute[r.key] ??= { label, episodes: 0, netUsd: 0, lastBlock: 0 });
    br.episodes++; br.netUsd += r.netUsd; br.lastBlock = block;
    const ev = { block, ts, route: label, start: r.start, amountUsd: r.amountInUsd, grossUsd: r.grossUsd, gasUsd: r.gasUsd, flashFeeUsd: r.flashFeeUsd, netUsd: r.netUsd, lender: r.lender, needsV4: !!r.needsV4 };
    events.push(ev);
    if (!stats.best || r.netUsd > stats.best.netUsd) stats.best = ev;
  }
  stats.blocksProcessed++;
  if (winners.length) stats.blocksWithOpp++;
  if (stats.firstBlock === null) stats.firstBlock = block;
  if (stats.lastBlock !== null && block > stats.lastBlock + 1) {
    stats.gaps.push({ from: stats.lastBlock + 1, to: block - 1 });
    if (stats.gaps.length > 200) stats.gaps.shift();
    stats.open = Object.fromEntries(Object.entries(stats.open).filter(([k]) => nowKeys.has(k)));
  }
  stats.lastBlock = block;
  stats.lastBlockTs = ts;
  // podar rutas: conservar las 300 con más beneficio
  const keys = Object.keys(stats.byRoute);
  if (keys.length > 400) {
    keys.sort((a, b) => stats.byRoute[b].netUsd - stats.byRoute[a].netUsd);
    for (const k of keys.slice(300)) delete stats.byRoute[k];
  }
  return events;
}

/** Construye el universo: pares principales + long tail de las últimas `ltHours` horas, filtrado por liquidez. */
export async function buildUniverse(ethers, provider, { ltHours = 2, head, progress = async () => {} } = {}) {
  head = head ?? (await provider.getBlockNumber());
  if (ltHours <= 0) {
    const found = await core.existingPools(ethers, provider, Object.values(core.TOKENS).map((t) => t.address));
    const metaList = Object.entries(core.TOKENS).map(([sym, t]) => ({ sym, ...t }));
    return fromSpecs(ethers, provider, [...found.entries()], metaList);
  }
  const { foundEntries, metaList } = await core.longTailUniverse(ethers, provider, {
    lookback: Math.round((ltHours * 3600) / 2), head, minLiq: MIN_LIQ, progress,
  });
  await progress(`cargando ${foundEntries.length} pools`);
  return fromSpecs(ethers, provider, foundEntries, metaList);
}

/** Reconstruye pools/ciclos a partir de specs guardados (arranque rápido). */
export async function fromSpecs(ethers, provider, foundEntries, metaList) {
  const baseAddrs = Object.values(core.TOKENS).map((t) => t.address);
  const meta = new Map(metaList.map((t) => [t.address.toLowerCase(), t]));
  const found = new Map(foundEntries);
  const all = await core.loadPools(ethers, provider, found, meta);
  const pools = core.filterPools(all, baseAddrs.slice(0, 2), MIN_LIQ);
  // guardar solo los specs que pasaron el filtro, para que el próximo arranque sea ligero
  const keep = new Set(pools.map((p) => p.address));
  const keptEntries = foundEntries.filter(([k]) => keep.has(k));
  const usedTokens = new Set(pools.flatMap((p) => [p.token0.address.toLowerCase(), p.token1.address.toLowerCase()]));
  return { pools, cycles: core.enumerateCycles(pools), specs: { found: keptEntries, meta: metaList.filter((t) => usedTokens.has(t.address.toLowerCase())) } };
}

/**
 * Corre hasta `deadlineMs` (epoch ms). Guarda stats y eventos en el store cada `flushEvery` bloques.
 * Devuelve las stats finales. No envía transacciones.
 */
export async function runWorker({ ethers, provider, store, deadlineMs, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ltHours = 2, pollMs = 1000, flushEvery = 5, log = () => {} }) {
  const runId = `${now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.set("owner", { id: runId, since: now() }); // el último en arrancar es el dueño
  const stats = (await store.get("stats")) ?? emptyStats();
  let events = (await store.get("events")) ?? [];
  stats.runs++;
  stats.startedAt ??= new Date(now()).toISOString();
  const setPhase = async (phase) => { stats.phase = phase; stats.heartbeat = now(); await store.set("stats", stats); log(phase); };
  await setPhase("armando universo");

  let uni;
  const cached = await store.get("universe");
  if (cached && now() - cached.builtAt < UNIVERSE_TTL_MS && ltHours > 0) {
    await setPhase("cargando universo guardado");
    uni = await fromSpecs(ethers, provider, cached.found, cached.meta);
  } else {
    uni = await buildUniverse(ethers, provider, { ltHours, progress: (m) => setPhase(`armando universo: ${m}`) });
    await store.set("universe", { builtAt: now(), ...uni.specs });
  }
  stats.universe = { pools: uni.pools.length, cycles: uni.cycles.length, builtAt: new Date(now()).toISOString() };
  await setPhase("procesando bloques");
  let lenders = await core.readLenders(ethers, provider);
  log(`universo listo: ${uni.pools.length} pools, ${uni.cycles.length} ciclos`);

  let last = stats.lastBlock ?? 0;
  let sinceFlush = 0, n = 0;
  let evicted = false;
  const flush = async () => {
    const owner = await store.get("owner");
    if (owner && owner.id !== runId) { evicted = true; return; } // otro worker tomó el relevo: no pisar sus datos
    stats.heartbeat = now();
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    await store.set("stats", stats);
    await store.set("events", events);
    sinceFlush = 0;
  };
  while (now() < deadlineMs && !evicted) {
    let head;
    try {
      head = await provider.getBlockNumber();
    } catch (e) {
      stats.lastError = `getBlockNumber: ${e.shortMessage || e.message}`;
      await sleep(pollMs * 3);
      continue;
    }
    if (head <= last) { await sleep(pollMs); continue; }
    // Si nos atrasamos mucho (arranque o hueco), saltamos al bloque actual: el estado histórico no siempre está disponible.
    const b = head - last > 5 ? head : last + 1;
    try {
      const [gas] = await Promise.all([core.readGas(ethers, provider), core.refreshPools(ethers, provider, uni.pools, b)]);
      const ethUsd = core.referenceEthUsd(uni.pools);
      if (n % 60 === 0) lenders = await core.readLenders(ethers, provider);
      const results = core.evaluateAll({ pools: uni.pools, cycles: uni.cycles, lenders, gas, ethUsd });
      events.push(...accountBlock(stats, b, gas.timestamp, results));
      stats.lastError = null;
      last = b; n++; sinceFlush++;
      if (sinceFlush >= flushEvery) await flush();
    } catch (e) {
      stats.lastError = `bloque ${b}: ${e.shortMessage || e.message}`;
      last = b; // no reintentar el mismo bloque para siempre
      await sleep(pollMs);
    }
  }
  if (!evicted) await flush();
  return { stats, evicted };
}

/** ¿Hay un worker vivo? (latido reciente) */
export function isAlive(stats, nowMs) {
  if (!stats || !stats.heartbeat) return false;
  const limit = stats.phase && stats.phase.startsWith("procesando") ? HEARTBEAT_STALE_MS : BUILDING_STALE_MS;
  return nowMs - stats.heartbeat < limit;
}
