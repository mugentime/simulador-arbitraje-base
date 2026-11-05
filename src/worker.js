// Worker 24/7: corre el pipeline del protocolo bloque a bloque en el servidor y acumula resultados.
// Independiente de la plataforma: recibe ethers, un provider y un "store" con get/set de JSON.
// En Netlify el store es Netlify Blobs; en las pruebas, un Map en memoria.

import * as core from "./core.js";
import { emptyDisloc, trackBlock, summarize as summarizeDisloc } from "./dislocations.js";
import { isExcludedPool } from "./pairs.js";
import { emptyVaultStats, harvestTable, processVaultBlock } from "./vaultsim.js";

/** Liquidez mínima por token de referencia (≈ $150): se calcula al usarse porque la cadena activa puede cambiar. */
export function minLiq() {
  return {
    [core.TOKENS.WETH.address.toLowerCase()]: 5n * 10n ** 16n, // 0.05 del nativo envuelto (piso; filterPools lo sube al equivalente en USDC)
    // MIN_LIQ_USD (por defecto 500): reserva mínima de USDC en un pool; el mínimo del nativo envuelto se eleva a su
    // equivalente en filterPools con el precio del pool WETH/USDC más profundo.
    [core.TOKENS.USDC.address.toLowerCase()]: BigInt(Math.max(1, Math.round(Number(globalThis.process?.env?.MIN_LIQ_USD ?? 500)))) * 10n ** BigInt(core.TOKENS.USDC.decimals),
  };
}
export const MIN_LIQ = new Proxy({}, { get: (_, k) => minLiq()[k], ownKeys: () => Object.keys(minLiq()), getOwnPropertyDescriptor: (_, k) => ({ value: minLiq()[k], enumerable: true, configurable: true }) });
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
const usd = (v, d = 2) => (isFinite(v) ? (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(d) : "—");
/** Las 8 etapas del protocolo (punto 1) explicadas con los números de este bloque. */
export function describeBlock({ block, gas, ethUsd, pools, cycles, results, newEvents, open, totals, execText }) {
  const live = pools.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n).length;
  const spread = results.filter((r) => r.amountIn > 0n);
  const winners = results.filter((r) => r.profitable && !core.PHANTOM_ROUTES.has(core.routeId(r.route)));
  const best = results[0];
  const sized = spread[0];
  const gwei = (w) => (Number(w) / 1e9).toFixed(4);
  const twoHop = results.find((r) => r.hops === 2);
  return {
    block, ts: gas.timestamp,
    stages: [
      { k: "ingesta", name: "1 · Ingesta", t: `Bloque ${block.toLocaleString("es-MX")} leído · base fee ${gwei(gas.baseFee)} gwei · ETH ${usd(ethUsd)} (mediana on-chain de los pools WETH/USDC)` },
      { k: "estado", name: "2 · Estado", t: `${live} de ${pools.length} pools con liquidez, reservas leídas en este mismo bloque · ${pools.filter((p) => p.ticks && p.ticks.length).length} pools v3/v4 con tabla de ticks (${pools.reduce((s, p) => s + (p.ticks?.length ?? 0), 0)} ticks)` },
      { k: "deteccion", name: "3 · Detección", t: spread.length ? `${spread.length} de ${cycles.toLocaleString("es-MX")} rutas tienen spread marginal mayor que sus comisiones` : `Ninguna de las ${cycles.toLocaleString("es-MX")} rutas tiene spread mayor que sus comisiones` + (best ? ` (la mejor: ${best.marginalBps.toFixed(2)} bps vs ${best.feesBps.toFixed(2)} bps)` : "") },
      { k: "tamano", name: "4 · Tamaño óptimo", t: sized ? `Mejor ruta ${sized.start} · ${sized.hops} saltos · préstamo óptimo ${usd(sized.amountInUsd, 0)} de ${sized.lender} (donde el beneficio bruto deja de crecer)` : "Sin tamaño que rinda: con cualquier monto las comisiones superan el spread" },
      { k: "simulacion", name: "5 · Simulación", t: `${results.length.toLocaleString("es-MX")} rutas simuladas con la fórmula exacta de cada pool (x·y=k / liquidez concentrada)` + (sized ? ` · bruto de la mejor ${usd(sized.grossUsd, 4)}` : "") },
      { k: "filtro", name: "6 · Filtro EV", hit: winners.length > 0, t: winners.length ? `${winners.length} ruta(s) con valor esperado positivo · mejor neto ${usd(winners[0].netUsd, 4)} = bruto ${usd(winners[0].grossUsd, 4)} − gas ${usd(winners[0].gasUsd, 4)} − comisión flash ${usd(winners[0].flashFeeUsd, 4)}` : `0 pasan: el gas de un arbitraje cuesta ${twoHop ? usd(twoHop.gasUsd, 4) : "—"}` + (sized ? ` y el mejor bruto es ${usd(sized.grossUsd, 4)}` : "") },
      { k: "ejecucion", name: "7 · Ejecución", hit: !!execText && /éxito|confirmada/.test(execText), t: execText ?? (winners.length ? "Fase 1 inactiva en este bloque" : "Nada que ejecutar") },
      { k: "registro", name: "8 · Registro", t: `${newEvents.length ? newEvents.length + " oportunidad(es) nueva(s) registrada(s)" : "Sin oportunidades nuevas"} · ${open} abierta(s) de bloques anteriores · acumulado ${usd(totals.netUsd)} en ${totals.episodes} episodios` },
    ],
  };
}

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
export async function buildUniverse(ethers, provider, { ltHours = 2, head, progress = async () => {}, extraTokens = null } = {}) {
  head = head ?? (await provider.getBlockNumber());
  if (ltHours <= 0) {
    const found = await core.existingPools(ethers, provider, Object.values(core.TOKENS).map((t) => t.address));
    const metaList = Object.entries(core.TOKENS).map(([sym, t]) => ({ sym, ...t }));
    return fromSpecs(ethers, provider, [...found.entries()], metaList);
  }
  let extra = extraTokens;
  if (extra === null) {
    try { extra = await core.verifiedExtraTokens(ethers, provider); await progress(`tokens adicionales verificados: ${extra.map((t) => t.sym).join(", ") || "ninguno"}${extra.rejected?.length ? ` · rechazados: ${extra.rejected.join(", ")}` : ""}`); }
    catch (e) { extra = []; await progress(`tokens adicionales: no se pudieron verificar (${e.shortMessage || e.message})`); }
  }
  const { foundEntries, metaList } = await core.longTailUniverse(ethers, provider, {
    lookback: Math.round((ltHours * 3600) / 2), head, minLiq: MIN_LIQ, progress, extraTokens: extra,
  });
  await progress(`cargando ${foundEntries.length} pools`);
  return fromSpecs(ethers, provider, foundEntries, metaList);
}

/** Reconstruye pools/ciclos a partir de specs guardados (arranque rápido). */
export async function fromSpecs(ethers, provider, foundEntries, metaList) {
  const baseAddrs = Object.values(core.TOKENS).map((t) => t.address);
  const meta = new Map(metaList.map((t) => [t.address.toLowerCase(), t]));
  const found = new Map(foundEntries);
  const all = (await core.loadPools(ethers, provider, found, meta)).filter((p) => !isExcludedPool(p, core.EXCLUDED_PAIRS) && !core.BLOCKED_TOKENS.has(p.token0.address.toLowerCase()) && !core.BLOCKED_TOKENS.has(p.token1.address.toLowerCase()));
  const pools = core.filterPools(all, baseAddrs.slice(0, 2), MIN_LIQ);
  // guardar solo los specs que pasaron el filtro, para que el próximo arranque sea ligero
  const keep = new Set(pools.map((p) => p.address));
  const keptEntries = foundEntries.filter(([k]) => keep.has(k));
  const usedTokens = new Set(pools.flatMap((p) => [p.token0.address.toLowerCase(), p.token1.address.toLowerCase()]));
  // los ciclos se arman sin los pools de tokens en observación (Stock Tokens: el contrato no puede recibirlos); el rastreador de desajustes sí los ve
  const execPools = core.OBSERVE_TOKENS.size ? pools.filter((p) => !core.OBSERVE_TOKENS.has(p.token0.address.toLowerCase()) && !core.OBSERVE_TOKENS.has(p.token1.address.toLowerCase())) : pools;
  return { pools, cycles: core.enumerateCycles(execPools), specs: { found: keptEntries, meta: metaList.filter((t) => usedTokens.has(t.address.toLowerCase())) } };
}

/**
 * Corre hasta `deadlineMs` (epoch ms). Guarda stats y eventos en el store cada `flushEvery` bloques.
 * Devuelve las stats finales. No envía transacciones.
 */
export async function runWorker({ ethers, provider, store, deadlineMs, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ltHours = 2, pollMs = 1000, flushEvery = 5, log = () => {}, onBlock = null, live = null, logsProvider = null, waitBlock = null }) {
  const runId = `${now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.set("owner", { id: runId, since: now() }); // el último en arrancar es el dueño
  const MODEL_VERSION = 3; // 3 = sin rutas fantasma (las que la cadena rechaza siempre) ni Stock Tokens; 2 = liquidez concentrada con cruce de ticks. Al cambiar, el acumulado anterior deja de ser comparable: se reinicia.
  let stats = (await store.get("stats")) ?? emptyStats();
  let events = (await store.get("events")) ?? [];
  let vstats = (await store.get("vaults")) ?? emptyVaultStats();
  if (stats.modelVersion !== MODEL_VERSION) {
    log(`acumulado reiniciado: modelo v${stats.modelVersion ?? 1} → v${MODEL_VERSION} (sin fantasmas)`);
    const prevRuns = stats.runs ?? 0;
    stats = emptyStats(); stats.runs = prevRuns; stats.modelVersion = MODEL_VERSION; stats.resetAt = new Date(now()).toISOString();
    events = []; vstats = emptyVaultStats();
    await store.set("stats", stats); await store.set("events", events); await store.set("vaults", vstats);
  }
  sanitize(stats, events);
  const managers = new Map(Object.entries((await store.get("managers")) ?? {}).map(([a, m]) => [a, { ...m, callReward: m.callReward === null || m.callReward === undefined ? null : BigInt(m.callReward) }]));
  vstats.hourly ??= []; vstats.last ??= null;
  let dstats = (await store.get("disloc")) ?? emptyDisloc();
  if (dstats.v !== 2) dstats = emptyDisloc(); // v2: medida ejecutable (los datos de la medida ingenua se descartan)
  if (live) { live.stats = stats; live.vstats = vstats; live.events = () => events; live.disloc = () => summarizeDisloc(dstats); }
  stats.runs++;
  stats.startedAt ??= new Date(now()).toISOString();
  const setPhase = async (phase) => { stats.phase = phase; stats.heartbeat = now(); await store.set("stats", stats); log(phase); };
  await setPhase("armando universo");

  let uni;
  const cached = await store.get("universe");
  const UNIVERSE_FORMAT = 52; // v52: retira USR (Base), TUSD (BSC), OM (Polygon), ANIME/frxUSD (Arbitrum), BIFI/frxUSD (OP): 0 pools; v51: 23:45 +2 tokens por cadena (Base cbLTC/USR, BSC lisUSD/MBOX/TUSD, Polygon USDGLO/OM, Arbitrum ANIME/frxUSD, OP BIFI/frxUSD), peores 3 corridas (Base WETH/ZORA, Polygon USDC.e/WBTC), inactivos (Base COOKIE/VIRTUAL, BSC SFP/USDT) y Arbitrum retira SPELL; v50: retira ID (BSC) y SUSHI (OP): 0 pools; v49: SPEC/ODOS (Base), THE (BSC), IXT (Polygon), W (OP) dieron 0 pools → FAI/uSUI, ID, stMATIC, SUSHI; v48: 22:45 +2 tokens por cadena (Base SPEC/ODOS, BSC THE/GMT, Polygon IXT/EURe, Arbitrum CAKE/W, OP POOL/W), peores 3 corridas (Base AERO/wstETH, Arbitrum ARB/DAI), inactivos (Base BNKR/DRB, BSC ASTER ×4) y BSC retira LISTA; v47: retira USDS (Arbitrum) y KNC (OP): 0 pools; v46: 21:45 +2 tokens por cadena (Base MIGGLES/mfer, BSC AXS/WOO, Polygon QI/PolyDoge, Arbitrum MIM/USDS, OP DHT/KNC), peores 3 corridas (Base KTA/USDC, Polygon LDO/USDC), inactivos (BSC 1INCH/CAKE, Arbitrum GHO/USDT) y tokens retirados (BSC ankrBNB, Polygon ZRO, Arbitrum OHM, OP WCT); v45: v45: BSC retira wBETH (0 pools); v44: 20:45 +2 tokens por cadena, peores 3 corridas (Polygon GRT/WPOL → token GRT, OP OP/USDC), inactivos (BSC FDUSD/USDC, Polygon WETH/AVAX, Arbitrum PEPE/USDC) y tokens retirados (Base GHST, BSC SXP, Polygon SOL, Arbitrum COMP, OP FRAX/USDGLO); v43: Robinhood +7 tokens de los CLM de Beefy (AI, BONER, CASHCAT, PONS, TENDIES, ORBIO, UP) y Stock Tokens AMD/META/AMC/CRCL/SPCX solo en observación; v42: ciclos de 4 saltos (cupo MAX_CYCLES_4) y saltos repartidos; // v41: retira MKR/YFI (Polygon), BAL (Arbitrum), wrsETH (OP): 0 pools; v40: 19:45 +2 tokens por cadena (OP 1), Polygon WETH/LDO peor 5 corridas, inactivos (Base USDT/VVV y VVV/cbBTC, Arbitrum SOL/USDC y SOL/WBTC) y tokens retirados (BSC ETC, Polygon DIMO, Arbitrum ATH); v39: Base DRB en lugar de B3; retira tBTC (Polygon), DMT/RPL (Arbitrum), USDT0/kBTC (OP): 0 pools; v38: 18:45 +2 tokens por cadena, Polygon WETH/GNS peor 4 corridas, inactivos (Base LINK/USDC, BSC AAVE/ETH y ETH/USD1, Arbitrum tokens rsETH y LDO); v37: Polygon retira ORBS (0 pools); v36: Base BENJI por LUNA, Polygon ORBS por APE, OP sin ACX (0 pools); v35: 17:45 +2 tokens por cadena, peores 3 corridas (Base DEGEN/USDC, BSC DOT/USDT, Polygon USDC/USDT, OP DAI/USDC), inactivos y tokens retirados (Polygon MANA, Arbitrum ETHFI/XAI, OP rETH/EXTRA); v34: BSC SXP en lugar de BAKE (0 pools); v33: 16:45 +2 tokens por cadena, Arbitrum AAVE/USDT peor 3 corridas, inactivos (Base USDS/WETH, BSC ETH/INJ, ETH/NEAR, NEAR/USDC, Arbitrum token LUSD); v32: retira USDe (BSC), AXL (Polygon), msUSD/msETH (OP): 0 pools; v31: 15:45 +2 tokens por cadena, Base USDC/cbETH peor 4 corridas, inactivos (Base MOG/SPX + token cbDOGE, BSC ATOM/USDT, Arbitrum token FRAX, OP STG/USDC y STG/USDC.e); v30: v30: 14:45 +2 tokens por cadena, peores 3 corridas (Base USDC/wstETH, Polygon WETH/SUSHI, Arbitrum GMX/USDC.e) e inactivos excluidos, Base retira SNX; v29: Robinhood sin Stock Tokens (transferencias solo entre wallets aprobadas); v28: BSC TON con símbolo on-chain TONCOIN; Polygon retira STG y FRAX (0 pools); v27: 13:45 +2 tokens por cadena (OP 1), inactivos excluidos, tokens sin pares útiles retirados, Arbitrum AAVE/PENDLE peor 3 corridas; v26: retira EURA (Polygon), GRAIL (Arbitrum), PENDLE/BAL (OP): 0 pools; v25: Polygon EURA por SNX, Arbitrum GRAIL por WOO, OP PENDLE/BAL por FXS/USDe (0 pools); v24: 12:45 +2 tokens por cadena, 50 inactivos excluidos, OP sin sUSD (retirado); v23: retira WOO (Polygon) y alETH (OP), 0 pools; v22: 11:45 +2 tokens por cadena, inactivos excluidos, liquidez mínima en pools entre tokens no base y mínimo de WETH por precio (MIN_LIQ_USD); v21: OP sin alUSD (0 pools); v20: OP alUSD en lugar de frxETH (0 pools); v19: OP frxETH en lugar de sETH (0 pools), PERP/USDC vuelve (único enlace base de PERP); v18: 10:45 +2 tokens por cadena, inactivos excluidos (Base 10, BSC 8, Polygon 10, Arbitrum 4, OP 10); v17: OP CRV en lugar de DOLA (0 pools); v16: 09:45 +2 tokens por cadena, hasta 10 pares inactivos excluidos por cadena; v15: 08:45 +2 tokens por cadena, 1 par excluido en Base/BSC/Arbitrum, bucle rápido solo con pools en ciclos; v14: 07:45 +2 tokens por cadena y 1 par excluido más por cadena; v13: Base USDe en lugar de LBTC, OP PERP en lugar de LDO (0 pools); v12: 06:45 +2 tokens por cadena y 1 par excluido por cadena; v11: OP WLD/AAVE en lugar de cbETH/ezETH; v10: +2 tokens por cadena (05:50), comisión de protocolo v4; v9: descarta pares estables de Camelot; símbolos alternativos; excludedPairs
  if (cached && cached.format === UNIVERSE_FORMAT && now() - cached.builtAt < UNIVERSE_TTL_MS && ltHours > 0) {
    await setPhase("cargando universo guardado");
    uni = await fromSpecs(ethers, provider, cached.found, cached.meta);
  } else {
    uni = await buildUniverse(ethers, provider, { ltHours, progress: (m) => setPhase(`armando universo: ${m}`) });
    await store.set("universe", { builtAt: now(), format: UNIVERSE_FORMAT, ...uni.specs });
  }
  stats.universe = { pools: uni.pools.length, cycles: uni.cycles.length, builtAt: new Date(now()).toISOString() };
  if (live) { live.cycles = uni.cycles; live.pools = uni.pools; live.dislocRaw = () => dstats; }
  await setPhase("procesando bloques");
  let lenders = await core.readLenders(ethers, provider);
  const extraSyms = new Set((core.EXTRA_TOKENS ?? []).map((t) => t.sym));
  const perTok = {};
  for (const p of uni.pools) for (const t of [p.token0, p.token1]) if (extraSyms.has(t.sym)) perTok[t.sym] = (perTok[t.sym] ?? 0) + 1;
  log(`universo listo: ${uni.pools.length} pools, ${uni.cycles.length} ciclos · pools por token adicional: ${[...extraSyms].map((s) => `${s} ${perTok[s] ?? 0}`).join(", ")}${core.EXCLUDED_PAIRS.size ? ` · pares excluidos: ${[...core.EXCLUDED_PAIRS].join(", ")}` : ""}`);

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
    await store.set("vaults", vstats);
    await store.set("disloc", dstats);
    await store.set("managers", Object.fromEntries(managers));
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
    if (head <= last) { if (waitBlock) await waitBlock(pollMs); else await sleep(pollMs); continue; }
    // Si nos atrasamos mucho (arranque o hueco), saltamos al bloque actual: el estado histórico no siempre está disponible.
    const b = head - last > 5 ? head : last + 1;
    try {
      const [gas] = await Promise.all([core.readGas(ethers, provider), core.refreshPools(ethers, provider, uni.pools, b)]);
      if (n % 15 === 0) { try { stats.tickPools = await core.refreshTicks(ethers, provider, uni.pools, { blockTag: b }); } catch (e) { stats.tickError = `bloque ${b}: ${e.shortMessage || e.message}`; } }
      const ethUsd = core.referenceEthUsd(uni.pools);
      if (n % 60 === 0) lenders = await core.readLenders(ethers, provider);
      const results = core.evaluateAll({ pools: uni.pools, cycles: uni.cycles, lenders, gas, ethUsd });
      const newEvents = accountBlock(stats, b, gas.timestamp, results);
      events.push(...newEvents);
      // desajustes entre pools del mismo par: cuánto duran y si el mercado los iguala
      try {
        const attempted = new Set(results.filter((r) => r.profitable).flatMap((r) => r.route.map((p) => p.address)));
        for (const ep of trackBlock(dstats, { block: b, ts: gas.timestamp, pools: uni.pools, ethUsd, attempted })) {
          if (ep.blocks >= 3 && ep.peakExcess >= 5) log(`desajuste ${ep.pair}: ${ep.blocks} bloques, exceso pico ${ep.peakExcess} bps sobre comisiones (${ep.low} → ${ep.high}) · ${ep.trigger}${ep.captured ? " · con ruta rentable detectada" : " · sin ruta rentable (profundidad/gas)"}`);
        }
      } catch (e) { stats.lastError = `desajustes ${b}: ${e.shortMessage || e.message}`; }
      let execText = null;
      if (onBlock) { try { execText = await onBlock({ block: b, ts: gas.timestamp, results, lenders, gas, ethUsd, pools: uni.pools }); } catch (e) { stats.lastError = `onBlock ${b}: ${e.shortMessage || e.message}`; } }
      stats.pipeline = describeBlock({ block: b, gas, ethUsd, pools: uni.pools, cycles: uni.cycles.length, results, newEvents, open: Object.keys(stats.open).length, totals: stats.totals, execText });
      // punto 6: rebalanceos, zaps y salidas de vaults en este bloque, y qué habría hecho el protocolo
      try {
        const vev = await core.scanVaultEvents(ethers, logsProvider ?? provider, uni.pools, b);
        vstats.scanned = { block: b, ts: gas.timestamp, pools: uni.pools.length, found: vev.length };
        if (vev.length) {
          await core.describeManagers(ethers, provider, [...new Set(vev.map((e) => e.actor))], managers);
          const recs = processVaultBlock(vstats, { block: b, ts: gas.timestamp, events: vev, results, pools: uni.pools, ethUsd, managers });
          for (const r of recs) log(`vault ${r.kind} · ${r.manager} · ${r.pool}${r.opp ? ` · back-run ${r.opp.profitable ? "EV+" : "EV−"} neto $${r.opp.netUsd.toFixed(4)}` : " · sin ruta"}`);
        } else vstats.blocks++;
        if (n % 150 === 0 && [...managers.values()].some((m) => m.beefy)) {
          await core.refreshHarvest(ethers, provider, managers);
          vstats.harvest = harvestTable(managers, gas, ethUsd, gas.timestamp);
          vstats.harvestUpdatedAt = gas.timestamp;
        }
        vstats.lastError = null;
      } catch (e) { vstats.lastError = `bloque ${b}: ${e.shortMessage || e.message}`; vstats.scanned = { block: b, ts: gas.timestamp, pools: uni.pools.length, found: 0, error: vstats.lastError }; }
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

/** Limpieza única: quita del acumulado los episodios imposibles (> $1,000 netos) registrados antes del filtro de cordura. */
export function sanitize(stats, events) {
  if ((stats.version ?? 1) >= 3) return;
  const bad = events.filter((e) => e.netUsd > 100 || e.grossUsd > e.amountUsd * 0.1);
  for (const e of bad) {
    const t = stats.totals;
    t.episodes--; t.netUsd -= e.netUsd; t.grossUsd -= e.grossUsd; t.gasUsd -= e.gasUsd; t.flashFeeUsd -= e.flashFeeUsd;
    if (e.netUsd >= 1) { t.over1Usd--; t.over1NetUsd -= e.netUsd; }
    const h = stats.hourly.find((x) => x.h === Math.floor(e.ts / 3600));
    if (h) { h.episodes--; h.netUsd -= e.netUsd; }
  }
  for (const k of Object.keys(stats.byRoute)) if (stats.byRoute[k].netUsd > 100) delete stats.byRoute[k];
  const keep = events.filter((e) => !bad.includes(e));
  events.length = 0; events.push(...keep);
  stats.best = keep.reduce((b, e) => (!b || e.netUsd > b.netUsd ? e : b), null);
  stats.version = 3;
}

/** ¿Hay un worker vivo? (latido reciente) */
export function isAlive(stats, nowMs) {
  if (!stats || !stats.heartbeat) return false;
  const limit = stats.phase && stats.phase.startsWith("procesando") ? HEARTBEAT_STALE_MS : BUILDING_STALE_MS;
  return nowMs - stats.heartbeat < limit;
}
