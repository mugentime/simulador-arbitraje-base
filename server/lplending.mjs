// Préstamos con LP como colateral (Fase 0: solo observación, no envía nada).
//
// BSC — Lista Lending (Moolah, fork de Morpho Blue) "Smart Lending": el colateral es el LP de un pool StableSwap de
//   Lista (SmartProvider = oráculo del mercado; colateral = token LPCollateral del provider). Se descubren mercados
//   (API de Lista + verificación on-chain), prestatarios (eventos Borrow/SupplyCollateral, hacia adelante y backfill),
//   se mide la salud de cada posición cada N bloques y se registran las liquidaciones ajenas (Liquidate).
//   Liquidar sería atómico y sin capital: Moolah.liquidate(callback) → SmartProvider.redeemLpCollateral → swap → repagar.
//   Además: calculadora de apalancamiento (flashloan gratuito de Moolah + capital propio → LP → colateral → préstamo).
// OP / Base — Extra Finance (farming apalancado sobre LP de Velodrome/Aerodrome): lectura de vaults (getVault) y
//   actividad de eventos del gestor de posiciones. Base: solo observación (orden de Jose 2026-11-04).

import { ethers } from "ethers";
import * as core from "../src/core.js";

export const MOOLAH_BSC = "0x8F73b65B4caAf64FBA2aF91cC5D4a2A1318E5D8C";
const LISTA_API = process.env.LISTA_API || "https://api.lista.org/api/moolah";
const EXTRA = { // DefiLlama-Adapters projects/extra (misma dirección en OP, Base y Berachain)
  vaultFactory: "0x155620a2e6a9392c754b73296d9655061525729b",
  positionViewer: "0xf9cfb8a62f50e10adde5aa888b44cf01c5957055",
};
const YEAR = 31_536_000;
const WAD = 10n ** 18n;
const STABLES = new Set(["USDT", "USDC", "USD1", "U", "LISUSD", "FDUSD", "DAI", "USDE"]);

const ABI = [
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32,address) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function getPrice((address,address,address,address,uint256)) view returns (uint256)",
  "function getLiquidationWhitelist(bytes32) view returns (address[])",
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
  "function TOKEN() view returns (address)",
  "function dex() view returns (address)",
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function get_virtual_price() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  "function getVault(uint256 vaultId) view returns (tuple(address gauge, address pair, address token0, address token1, bool stable, bool paused, bool frozen, bool borrowingEnabled, bool liquidateWithTWAP, uint16 maxLeverage, uint16 premiumMaxLeverage, uint16 maxPriceDiff, uint16 liquidateDebtRatio, uint16 withdrawFeeRate, uint16 compoundFeeRate, uint16 liquidateFeeRate, uint16 rangeStopFeeRate, uint16 protocolFeeRate, uint256 premiumRequirement, uint256 protocolFee0Accumulated, uint256 protocolFee1Accumulated, uint256 minInvestValue, uint256 minSwapAmount0, uint256 minSwapAmount1, uint256 totalLp, uint256 totalLpShares, uint256 premiumUtilizationOfReserve0, uint256 debtLimit0, uint256 debtPositionId0, uint256 debtTotalShares0, uint256 premiumUtilizationOfReserve1, uint256 debtLimit1, uint256 debtPositionId1, uint256 debtTotalShares1))",
];
const iface = new ethers.Interface(ABI);
const enc = (fn, args = []) => iface.encodeFunctionData(fn, args);
const dec = (fn, raw) => (raw ? iface.decodeFunctionResult(fn, raw) : null);

// ------------------------------------------------------------------ funciones puras (probadas en test-local)

/** Incentivo de liquidación de Moolah/Morpho: min(1.15, 1/(1 − 0.3·(1 − LLTV))). */
export function lif(lltv) { return Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv))); }

/** Salud de una posición. borrowed y collateral en unidades crudas; price con escala 1e36 (colateral→préstamo). */
export function positionHealth({ borrowShares, collateral, totalBorrowAssets, totalBorrowShares, price, lltvWad }) {
  const borrowed = totalBorrowShares > 0n ? (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares : 0n;
  const colValue = (collateral * price) / 10n ** 36n; // en unidades del token prestado
  const maxBorrow = (colValue * lltvWad) / WAD;
  const hf = borrowed > 0n ? Number(maxBorrow) / Number(borrowed) : Infinity;
  return { borrowed, colValue, maxBorrow, hf, liquidatable: borrowed > 0n && borrowed > maxBorrow };
}

/** Beneficio de liquidar: bono (LIF−1) sobre lo repagado, menos costo de desarmar el LP y gas. Todo en USD. */
export function liqProfit({ debtUsd, colUsd, lltv, exitCostBps = 5, gasUsd = 0.03 }) {
  const f = lif(lltv);
  const repayUsd = Math.min(debtUsd, colUsd / f);
  const seizedUsd = repayUsd * f;
  return { lif: f, repayUsd, seizedUsd, profitUsd: seizedUsd - repayUsd - seizedUsd * exitCostBps / 1e4 - gasUsd };
}

/**
 * Apalancamiento con flashloan + capital propio sobre LP como colateral (todo en el activo prestado).
 * capital C → flashloan (L−1)·C → LP por L·C → colateral → préstamo (L−1)·C → repagar flashloan.
 * Rinde L·y_lp − (L−1)·r_borrow (+ L·y_incentivos) − costo de entrada/salida amortizado. Liquidación si el LP pierde
 * d = 1 − (L−1)/(L·LLTV) contra el activo prestado.
 */
export function leverageTable({ lpApr, borrowApr, lltv, rewardApr = 0, entryExitBps = 10, buffer = 0.02, horizonDays = 30, levels = [1, 2, 3, 5, 10] }) {
  const ltvSafe = Math.max(0, lltv - buffer);
  const lMax = ltvSafe < 1 ? 1 / (1 - ltvSafe) : Infinity;
  const all = [...new Set([...levels, Math.floor(lMax * 10) / 10])].filter((l) => l >= 1 && l <= lMax + 1e-9).sort((a, b) => a - b);
  return {
    lMaxSafe: lMax,
    rows: all.map((L) => {
      const grossApr = L * (lpApr + rewardApr) - (L - 1) * borrowApr;
      const costApr = (L * entryExitBps / 1e4) * (365 / horizonDays); // entrar + salir sobre el nocional, amortizado al horizonte
      const ltv = (L - 1) / L;
      return { L, ltv, netApr: grossApr - costApr, grossApr, liqDrop: L > 1 ? 1 - ltv / lltv : 1 };
    }),
  };
}

/** APR anualizado a partir de dos lecturas de virtual price ({ts en s, vp}). */
export function vpApr(old, now) {
  if (!old || !now || now.ts <= old.ts || old.vp <= 0) return null;
  const g = now.vp / old.vp - 1;
  return g * (YEAR / (now.ts - old.ts));
}

// ------------------------------------------------------------------ observador

export function emptyLpl() {
  return {
    version: 1, chain: null, updatedAt: null, lastScanBlock: null, lastError: null,
    lista: { markets: [], borrowers: 0, positions: 0, debtUsd: 0, colUsd: 0, liquidatable: 0, near102: 0, near105: 0, minHf: null, candidates: [],
      seen: [], seenCount: 0, seenRepaidUsd: 0, fwdBlock: null, backBlock: null, backTarget: null, apiKeys: null, apiError: null, logChunk: 8000 },
    extra: { vaults: [], topics: {}, topicsFrom: null, error: null },
    opportunities: 0, estProfitUsd: 0,
  };
}

export class LpLending {
  constructor({ provider, logsProvider, store, diag, ourAddress = () => null }) {
    this.provider = provider; this.logs = logsProvider ?? provider; this.store = store; this.diag = diag; this.ourAddress = ourAddress;
    this.cfg = {
      scanEvery: Number(process.env.LPL_SCAN_BLOCKS ?? (core.CHAIN.key === "bsc" ? 200 : 60)),
      backfill: Number(process.env.LPL_BACKFILL_BLOCKS ?? 2_000_000), // BSC ≈ 10 días
      maxChunksPerScan: Number(process.env.LPL_CHUNKS_PER_SCAN ?? 30),
      marketsEveryMs: 6 * 3600_000,
      gasUsd: Number(process.env.LPL_GAS_USD ?? 0.03),
    };
    this.borrowers = new Map(); // `${id}|${user}` -> {id, user}
    this.open = new Set();
    this.busy = false; this.lastMarkets = 0; this.lastLog = 0;
  }

  get active() { return ["bsc", "optimism", "base"].includes(core.CHAIN.key); }

  async init() {
    this.s = (await this.store.get("lpl")) ?? emptyLpl();
    this.s.chain = core.CHAIN.key;
    for (const k of (await this.store.get("lplBorrowers")) ?? []) { const [id, user] = k.split("|"); this.borrowers.set(k, { id, user }); }
    this.vpHist = (await this.store.get("lplVp")) ?? {}; // dex -> [{ts, vp}]
    await this.save();
  }
  async save() { this.s.updatedAt = Date.now(); await this.store.set("lpl", this.s); }

  async onBlock({ block, ts, ethUsd }) {
    if (!this.active || this.busy || (this.s.lastScanBlock !== null && block - this.s.lastScanBlock < this.cfg.scanEvery)) return;
    this.busy = true;
    try {
      if (core.CHAIN.key === "bsc") await this.lista(block, ts, ethUsd);
      else await this.extra(block);
      this.s.lastScanBlock = block; this.s.lastError = null;
    } catch (e) { this.s.lastError = (e.shortMessage || e.message || String(e)).slice(0, 200); }
    finally { this.busy = false; await this.save().catch(() => {}); }
    if (Date.now() - this.lastLog > 30 * 60_000) { this.lastLog = Date.now(); console.log(`${new Date().toISOString()} ${this.line()}`); }
  }

  // ---------------------------------------------------------------- Lista (BSC)
  async lista(block, ts, ethUsd) {
    if (Date.now() - this.lastMarkets > this.cfg.marketsEveryMs || !this.s.lista.markets.length) { await this.listaMarkets(); this.lastMarkets = Date.now(); }
    const L = this.s.lista;
    if (!L.markets.length) return;
    await this.listaLogs(block);
    // salud de todas las posiciones conocidas + estado por mercado
    const mk = new Map(L.markets.map((m) => [m.id, m]));
    const keys = [...this.borrowers.values()].filter((b) => mk.has(b.id));
    const calls = [];
    for (const m of L.markets) {
      const mp = [m.loanToken, m.collateralToken, m.oracle, m.irm, BigInt(m.lltvWad)];
      calls.push([MOOLAH_BSC, enc("market", [m.id])], [MOOLAH_BSC, enc("getPrice", [mp])], [m.dex, enc("get_virtual_price")]);
    }
    for (const b of keys) calls.push([MOOLAH_BSC, enc("position", [b.id, b.user])]);
    const res = await core.multicall(ethers, this.provider, calls, block);
    const state = new Map();
    L.markets.forEach((m, i) => {
      const mkt = dec("market", res[3 * i]), price = res[3 * i + 1] ? BigInt(res[3 * i + 1]) : 0n, vp = res[3 * i + 2] ? Number(BigInt(res[3 * i + 2])) / 1e18 : null;
      state.set(m.id, { mkt, price });
      if (mkt) { m.totalBorrow = Number(mkt.totalBorrowAssets) / 10 ** m.loanDecimals; m.totalSupply = Number(mkt.totalSupplyAssets) / 10 ** m.loanDecimals; m.utilization = m.totalSupply ? m.totalBorrow / m.totalSupply : 0; }
      if (vp) this.noteVp(m.dex, ts, vp);
      m.lpApr = vpApr(this.vpOld(m.dex, ts), { ts, vp });
    });
    await this.listaRates(state);
    let debtUsd = 0, colUsd = 0, positions = 0, near102 = 0, near105 = 0, minHf = null; const cands = [];
    keys.forEach((b, j) => {
      const p = dec("position", res[3 * L.markets.length + j]); const st = state.get(b.id); const m = mk.get(b.id);
      if (!p || !st?.mkt || !st.price || p.borrowShares === 0n) return;
      const h = positionHealth({ borrowShares: p.borrowShares, collateral: p.collateral, totalBorrowAssets: st.mkt.totalBorrowAssets, totalBorrowShares: st.mkt.totalBorrowShares, price: st.price, lltvWad: BigInt(m.lltvWad) });
      const px = m.loanUsd ?? (m.loanSymbol === "WBNB" ? ethUsd : null);
      const dUsd = px !== null ? Number(h.borrowed) / 10 ** m.loanDecimals * px : 0, cUsd = px !== null ? Number(h.colValue) / 10 ** m.loanDecimals * px : 0;
      positions++; debtUsd += dUsd; colUsd += cUsd;
      if (h.hf < 1.02) near102++; if (h.hf < 1.05) near105++;
      if (minHf === null || h.hf < minHf) minHf = h.hf;
      if (h.hf < 1.05) {
        const pr = liqProfit({ debtUsd: dUsd, colUsd: cUsd, lltv: m.lltv, exitCostBps: (m.poolFeeBps ?? 4) + 1, gasUsd: this.cfg.gasUsd });
        cands.push({ market: m.label, id: m.id, user: b.user, hf: h.hf, debtUsd: dUsd, colUsd: cUsd, liquidatable: h.liquidatable, lif: pr.lif, estProfitUsd: pr.profitUsd, whitelisted: m.liqWhitelist === 0 || m.weAreWhitelisted === true });
      }
    });
    cands.sort((a, b) => a.hf - b.hf);
    Object.assign(L, { borrowers: this.borrowers.size, positions, debtUsd, colUsd, near102, near105, minHf, liquidatable: cands.filter((c) => c.liquidatable).length, candidates: cands.slice(0, 10) });
    for (const c of cands.filter((x) => x.liquidatable)) {
      const k = `${c.id}|${c.user}`; if (this.open.has(k)) continue;
      this.open.add(k); this.s.opportunities++; if (c.estProfitUsd > 0 && c.whitelisted) this.s.estProfitUsd += c.estProfitUsd;
      this.diag(`lp-colateral: Lista ${c.market} · posición liquidable ${c.user.slice(0, 10)}… HF ${c.hf.toFixed(4)} · deuda $${c.debtUsd.toFixed(2)} · bono ${((c.lif - 1) * 100).toFixed(2)} % · neto est. $${c.estProfitUsd.toFixed(2)}${c.whitelisted ? "" : " · lista blanca de liquidadores: NO podemos"}`).catch(() => {});
    }
    for (const k of [...this.open]) if (!cands.some((c) => c.liquidatable && `${c.id}|${c.user}` === k)) this.open.delete(k);
  }

  async listaMarkets() {
    const L = this.s.lista;
    let ids = (process.env.LISTA_SMART_MARKETS || "").split(",").map((x) => x.trim()).filter(Boolean);
    const extras = {};
    try {
      const list = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`${LISTA_API}/borrow/marketList?pageSize=200&page=${page}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
        const j = await r.json();
        const items = j?.data?.list ?? [];
        list.push(...items);
        if (!items.length || list.length >= (j?.data?.total ?? 0)) break;
      }
      if (list.length && !L.apiKeys) L.apiKeys = Object.keys(list[0]).slice(0, 60);
      for (const m of list) {
        if (m.chain && m.chain !== "bsc") continue;
        if (!(m.isSmartLending === true || m.smartCollateralConfig)) continue;
        if (m.status !== undefined && m.status !== 1) continue;
        ids.push(m.marketId);
        extras[m.marketId] = Object.fromEntries(Object.entries(m).filter(([k, v]) => /apy|apr|rate|reward|emission|incentive|tvl|liquidity/i.test(k) && (typeof v === "number" || (typeof v === "string" && v.length < 40))));
      }
      L.apiError = null;
    } catch (e) { L.apiError = (e.message || String(e)).slice(0, 120); }
    ids = [...new Set(ids)].filter((x) => /^0x[0-9a-fA-F]{64}$/.test(x));
    if (!ids.length) { if (!L.markets.length) await this.diag(`lp-colateral: Lista sin mercados Smart Lending (API: ${L.apiError ?? "0 resultados"}); usar LISTA_SMART_MARKETS=<ids>`); return; }
    const r1 = await core.multicall(ethers, this.provider, ids.map((id) => [MOOLAH_BSC, enc("idToMarketParams", [id])]));
    const params = ids.map((id, i) => ({ id, p: dec("idToMarketParams", r1[i]) })).filter((x) => x.p && x.p.loanToken !== ethers.ZeroAddress);
    // el oráculo de un mercado Smart Lending es el SmartProvider: TOKEN() = colateral, dex() = pool StableSwap
    const r2 = await core.multicall(ethers, this.provider, params.flatMap(({ p }) => [[p.oracle, enc("TOKEN")], [p.oracle, enc("dex")], [p.loanToken, enc("symbol")], [p.loanToken, enc("decimals")]]));
    const smart = [];
    params.forEach(({ id, p }, i) => {
      const tok = dec("TOKEN", r2[4 * i]), dex = dec("dex", r2[4 * i + 1]);
      if (!tok || !dex || tok[0].toLowerCase() !== p.collateralToken.toLowerCase()) return;
      smart.push({ id, loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltvWad: p.lltv.toString(), lltv: Number(p.lltv) / 1e18,
        dex: dex[0], loanSymbol: dec("symbol", r2[4 * i + 2])?.[0] ?? "?", loanDecimals: Number(dec("decimals", r2[4 * i + 3])?.[0] ?? 18), api: extras[id] ?? null });
    });
    const r3 = await core.multicall(ethers, this.provider, smart.flatMap((m) => [[m.dex, enc("coins", [0])], [m.dex, enc("coins", [1])], [m.dex, enc("fee")], [MOOLAH_BSC, enc("getLiquidationWhitelist", [m.id])]]));
    const coins = smart.flatMap((m, i) => [dec("coins", r3[4 * i])?.[0], dec("coins", r3[4 * i + 1])?.[0]]).filter(Boolean);
    const r4 = coins.length ? await core.multicall(ethers, this.provider, coins.map((c) => [c, enc("symbol")])) : [];
    const sym = new Map(coins.map((c, i) => [c.toLowerCase(), dec("symbol", r4[i])?.[0] ?? (c.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? "BNB" : "?")]));
    const us = this.ourAddress()?.toLowerCase();
    smart.forEach((m, i) => {
      const c0 = dec("coins", r3[4 * i])?.[0], c1 = dec("coins", r3[4 * i + 1])?.[0], fee = dec("fee", r3[4 * i + 2])?.[0], wl = dec("getLiquidationWhitelist", r3[4 * i + 3])?.[0] ?? [];
      m.coins = [c0, c1]; m.coinSymbols = [sym.get(c0?.toLowerCase()) ?? "?", sym.get(c1?.toLowerCase()) ?? "?"];
      m.poolFeeBps = fee !== undefined ? Number(fee) / 1e6 : null; // fee escala 1e10 (estilo Curve) → bps
      m.liqWhitelist = wl.length; m.weAreWhitelisted = wl.length === 0 || (us ? wl.some((a) => a.toLowerCase() === us) : false);
      m.label = `LP ${m.coinSymbols.join("-")} → ${m.loanSymbol} (LLTV ${(m.lltv * 100).toFixed(1)} %)`;
      m.loanUsd = STABLES.has(m.loanSymbol.toUpperCase()) ? 1 : null;
      m.stablePair = m.coinSymbols.every((s) => STABLES.has(s.toUpperCase()));
    });
    const prev = new Map(L.markets.map((m) => [m.id, m]));
    L.markets = smart.map((m) => ({ ...prev.get(m.id), ...m }));
    if (!L.fwdBlock && smart.length) await this.diag(`lp-colateral: Lista Smart Lending · ${smart.length} mercados: ${smart.map((m) => `${m.label}${m.liqWhitelist ? ` [lista blanca ${m.liqWhitelist}]` : ""}`).join(" · ")}`);
  }

  async listaRates(state) {
    const L = this.s.lista;
    const calls = L.markets.map((m) => {
      const st = state.get(m.id); if (!st?.mkt) return null;
      return [m.irm, enc("borrowRateView", [[m.loanToken, m.collateralToken, m.oracle, m.irm, BigInt(m.lltvWad)], [...st.mkt]])];
    });
    const res = await core.multicall(ethers, this.provider, calls.filter(Boolean));
    let k = 0;
    L.markets.forEach((m, i) => {
      if (!calls[i]) return;
      const r = res[k++]; if (!r) return;
      const perSec = Number(BigInt(r)) / 1e18;
      m.borrowApr = perSec * YEAR; m.borrowApy = Math.expm1(perSec * YEAR);
      const reward = Number(m.api?.rewardApr ?? m.api?.emissionApr ?? 0) || 0; // solo si la API lo trae con nombre reconocible
      if (m.lpApr !== null && m.lpApr !== undefined) m.leverage = leverageTable({ lpApr: m.lpApr, borrowApr: m.borrowApy, lltv: m.lltv, rewardApr: reward > 1 ? reward / 100 : reward, entryExitBps: 2 * ((m.poolFeeBps ?? 4) + 1) });
    });
  }

  async listaLogs(head) {
    const L = this.s.lista;
    const ids = L.markets.map((m) => m.id);
    const t = [iface.getEvent("Borrow").topicHash, iface.getEvent("SupplyCollateral").topicHash, iface.getEvent("Liquidate").topicHash];
    if (L.fwdBlock === null) { L.fwdBlock = head; L.backBlock = head; L.backTarget = head - this.cfg.backfill; }
    let chunks = 0;
    const get = async (from, to) => {
      for (;;) {
        try { return await this.logs.getLogs({ address: MOOLAH_BSC, fromBlock: from, toBlock: to, topics: [t, ids] }); }
        catch (e) { if (L.logChunk <= 500) throw e; L.logChunk = Math.floor(L.logChunk / 2); to = Math.min(to, from + L.logChunk - 1); }
      }
    };
    const apply = (logs) => {
      for (const lg of logs) {
        const id = lg.topics[1];
        if (lg.topics[0] === t[2]) {
          const ev = iface.parseLog(lg); const m = L.markets.find((x) => x.id === id);
          const repaid = m ? Number(ev.args.repaidAssets) / 10 ** m.loanDecimals * (m.loanUsd ?? 0) : 0;
          L.seenCount++; L.seenRepaidUsd += repaid;
          if (!L.seen.some((s) => s.tx === lg.transactionHash)) { L.seen.unshift({ block: lg.blockNumber, tx: lg.transactionHash, market: m?.label ?? id.slice(0, 10), borrower: ev.args.borrower, liquidator: ev.args.caller, repaidUsd: repaid, badDebt: ev.args.badDebtAssets > 0n }); L.seen.length = Math.min(L.seen.length, 50); }
        }
        const user = ethers.getAddress("0x" + (lg.topics[0] === t[0] ? lg.topics[2] : lg.topics[3]).slice(-40)); // Borrow: onBehalf; SupplyCollateral: onBehalf; Liquidate: borrower
        const k = `${id}|${user}`; if (!this.borrowers.has(k)) this.borrowers.set(k, { id, user });
      }
    };
    // hacia adelante (todo lo nuevo), luego backfill gradual hacia atrás
    while (L.fwdBlock < head && chunks < this.cfg.maxChunksPerScan) {
      const from = L.fwdBlock + 1, to = Math.min(head, from + L.logChunk - 1);
      apply(await get(from, to)); L.fwdBlock = to; chunks++;
    }
    while (L.backBlock > L.backTarget && chunks < this.cfg.maxChunksPerScan) {
      const to = L.backBlock - 1, from = Math.max(L.backTarget, to - L.logChunk + 1);
      apply(await get(from, to)); L.backBlock = from; chunks++;
    }
    if (chunks) await this.store.set("lplBorrowers", [...this.borrowers.keys()]);
  }

  noteVp(dex, ts, vp) {
    const h = (this.vpHist[dex] ??= []);
    if (!h.length || ts - h[h.length - 1].ts >= 1800) { h.push({ ts, vp }); while (h.length && ts - h[0].ts > 8 * 86400) h.shift(); this.store.set("lplVp", this.vpHist).catch(() => {}); }
  }
  /** La lectura más antigua con ≥ 6 h de distancia (si no hay, null: APR del LP aún sin dato). */
  vpOld(dex, ts) { return (this.vpHist[dex] ?? []).find((x) => ts - x.ts >= 6 * 3600) ?? null; }

  // ---------------------------------------------------------------- Extra Finance (OP, Base)
  async extra(head) {
    const E = this.s.extra;
    if (Date.now() - this.lastMarkets > this.cfg.marketsEveryMs || !E.vaults.length) {
      const code = await this.provider.getCode(EXTRA.positionViewer);
      if (code === "0x") { E.error = "positionViewer sin código en esta cadena"; this.lastMarkets = Date.now(); return; }
      const res = await core.multicall(ethers, this.provider, Array.from({ length: 150 }, (_, i) => [EXTRA.positionViewer, enc("getVault", [i + 1])]));
      const vs = [];
      res.forEach((r, i) => { const v = dec("getVault", r)?.[0]; if (v && v.pair !== ethers.ZeroAddress) vs.push({ id: i + 1, v }); });
      const toks = [...new Set(vs.flatMap(({ v }) => [v.token0, v.token1]))];
      const sres = toks.length ? await core.multicall(ethers, this.provider, toks.map((a) => [a, enc("symbol")])) : [];
      const sym = new Map(toks.map((a, i) => [a, dec("symbol", sres[i])?.[0] ?? "?"]));
      E.vaults = vs.map(({ id, v }) => ({ id, pair: v.pair, label: `${sym.get(v.token0)}-${sym.get(v.token1)}${v.stable ? " (estable)" : ""}`, paused: v.paused || v.frozen, borrowing: v.borrowingEnabled,
        maxLeverage: Number(v.maxLeverage) / 100, liquidateDebtRatio: Number(v.liquidateDebtRatio) / 1e4, liquidateFeeRate: Number(v.liquidateFeeRate) / 1e4, totalLp: v.totalLp.toString() }))
        .filter((v) => BigInt(v.totalLp) > 0n);
      E.error = null; this.lastMarkets = Date.now();
    }
    // actividad del gestor de posiciones por tipo de evento (topic0) en la última ventana; no se conoce el ABI de liquidación
    const from = Math.max(head - 2000 + 1, (E.topicsFrom ?? head - 2000) + 1);
    if (from <= head) {
      const logs = await this.logs.getLogs({ address: EXTRA.vaultFactory, fromBlock: from, toBlock: head }).catch(() => []);
      for (const lg of logs) E.topics[lg.topics[0]] = (E.topics[lg.topics[0]] ?? 0) + 1;
      E.topicsFrom = head;
    }
  }

  line() {
    if (core.CHAIN.key === "bsc") {
      const L = this.s.lista;
      const mk = L.markets.map((m) => `${m.coinSymbols?.join("-")}→${m.loanSymbol} util ${((m.utilization ?? 0) * 100).toFixed(0)} % borrow ${m.borrowApy !== undefined ? (m.borrowApy * 100).toFixed(2) : "—"} % LP ${m.lpApr !== null && m.lpApr !== undefined ? (m.lpApr * 100).toFixed(2) : "—"} %${m.leverage ? ` Lmax ${m.leverage.lMaxSafe.toFixed(1)}x neto ${(m.leverage.rows.at(-1).netApr * 100).toFixed(1)} %` : ""}${m.liqWhitelist ? ` WL${m.liqWhitelist}` : ""}`).join(" | ");
      return `lp-colateral: Lista ${L.markets.length} mercados · ${L.positions} posiciones ($${L.debtUsd.toFixed(0)} deuda / $${L.colUsd.toFixed(0)} colateral) · HF<1.05: ${L.near105}, <1.02: ${L.near102}, liquidables ${L.liquidatable} · HF mín ${L.minHf?.toFixed(4) ?? "—"} · liquidaciones ajenas ${L.seenCount} ($${L.seenRepaidUsd.toFixed(0)}) · backfill ${L.backBlock !== null ? Math.round((L.fwdBlock - L.backBlock) / 1000) + "k bloques" : "—"} · ${mk}${L.apiError ? ` · API: ${L.apiError}` : ""}${this.s.lastError ? ` · error: ${this.s.lastError}` : ""}`;
    }
    const E = this.s.extra;
    return `lp-colateral: Extra Finance ${E.vaults.length} vaults con LP (${E.vaults.filter((v) => !v.paused && v.borrowing).length} activos) · eventos ${Object.values(E.topics).reduce((a, b) => a + b, 0)} (${Object.keys(E.topics).length} tipos)${E.error ? ` · ${E.error}` : ""}${this.s.lastError ? ` · error: ${this.s.lastError}` : ""}`;
  }
}
