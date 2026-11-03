// Liquidaciones en Base (detección): Aave v3 y Morpho Blue.
//
// Aave v3: se descubren prestatarios por eventos Borrow, se lee getUserAccountData (factor de salud) por multicall:
//          lista completa cada N lecturas, "lista de vigilancia" (HF < 1.08) en cada lectura. HF < 1 = liquidable.
// Morpho Blue: posiciones con factor de salud bajo desde la API pública de Morpho (GraphQL), verificadas on-chain
//          con position()/market()/oracle.price(). Liquidable si deuda > colateral · precio · LLTV.
// También se registran las liquidaciones que ejecutan otros (eventos LiquidationCall / Liquidate) para medir la
// competencia: cuántas, de qué tamaño y cuántos bloques tarda alguien en tomarlas.

import { ethers } from "ethers";
import * as core from "../src/core.js";

export const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
export const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MORPHO_API = process.env.MORPHO_API || "https://api.morpho.org/graphql";
const ABI = [
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  "function position(bytes32,address) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function price() view returns (uint256)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
];
const MAX_RECENT = 80;

export function emptyLiq() {
  return {
    version: 1,
    aave: { borrowers: 0, lastDiscoveryBlock: null, lastScan: null, scanBlock: null, scanned: 0, watch: 0, candidates: [], liquidatable: 0, error: null },
    morpho: { lastApi: null, apiPositions: 0, candidates: [], liquidatable: 0, error: null },
    seen: { aave: 0, morpho: 0, aaveUsd: 0, recent: [] }, // liquidaciones ejecutadas por otros
    opportunities: 0, // veces que vimos una posición liquidable (episodios, por usuario)
    estProfitUsd: 0, // suma del beneficio estimado de esos episodios (bono − gas), tope
    recent: [], // episodios recientes
    updatedAt: null,
  };
}

export class Liquidations {
  constructor({ provider, logsProvider, store, diag }) {
    this.provider = provider; this.logs = logsProvider ?? provider; this.store = store; this.diag = diag;
    this.iface = new ethers.Interface(ABI);
    this.cfg = {
      lookback: Number(process.env.LIQ_LOOKBACK_BLOCKS ?? 120_000), // ~2.8 días de eventos Borrow al arrancar
      chunk: Number(process.env.LIQ_LOG_CHUNK ?? 2000),
      scanEvery: Number(process.env.LIQ_SCAN_BLOCKS ?? 30),
      fullEvery: Number(process.env.LIQ_FULL_EVERY ?? 10), // lista completa cada 10 lecturas, vigilancia en todas
      maxBorrowers: Number(process.env.LIQ_MAX_BORROWERS ?? 6000),
      watchHf: 1.08,
      aaveBonus: 0.05, // bono típico (depende de la reserva; se refina al ejecutar)
      gasUsd: 0.03,
    };
    this.borrowers = new Map(); // addr -> {hf, debtUsd, colUsd, at}
    this.open = new Map(); // episodios abiertos: user -> block
    this.scans = 0; this.busy = false; this.discovering = false;
  }

  async init() {
    this.liq = (await this.store.get("liq")) ?? emptyLiq();
    if (this.liq.version !== 2) { this.liq.version = 2; this.liq.estProfitUsd = 0; this.liq.opportunities = 0; } // techo recalculado: solo posiciones ejecutables
    this.badUsers = new Set((await this.store.get("liqBad")) ?? []);
    for (const [u, b] of Object.entries(this.liq.openUsers ?? {})) this.open.set(u, b); // episodios abiertos sobreviven al reinicio
    const saved = await this.store.get("aaveBorrowers");
    if (saved?.list) { for (const a of saved.list) this.borrowers.set(a, {}); this.liq.aave.lastDiscoveryBlock = saved.block; }
    await this.save();
  }
  async save() { this.liq.updatedAt = Date.now(); await this.store.set("liq", this.liq); }

  async onBlock({ block, ts, gas, ethUsd }) {
    if (!this.discovering && (this.liq.aave.lastDiscoveryBlock === null || block - this.liq.aave.lastDiscoveryBlock > 300)) {
      this.discovering = true;
      this.discoverAave(block).catch((e) => { this.liq.aave.error = e.shortMessage || e.message; }).finally(() => { this.discovering = false; });
    }
    if (this.busy || block % this.cfg.scanEvery !== 0) return;
    this.busy = true;
    try {
      await Promise.all([this.scanAave({ block, ts, gas, ethUsd }).catch((e) => { this.liq.aave.error = e.shortMessage || e.message; }), this.scanMorpho({ block, ts, gas, ethUsd }).catch((e) => { this.liq.morpho.error = e.shortMessage || e.message; })]);
      await this.save();
    } finally { this.busy = false; }
  }

  /** Prestatarios de Aave: eventos Borrow (histórico al arrancar, incremental después) + liquidaciones ajenas. */
  async discoverAave(head) {
    const topicBorrow = this.iface.getEvent("Borrow").topicHash, topicLiq = this.iface.getEvent("LiquidationCall").topicHash;
    let from = this.liq.aave.lastDiscoveryBlock === null ? head - this.cfg.lookback : this.liq.aave.lastDiscoveryBlock + 1;
    const first = this.liq.aave.lastDiscoveryBlock === null;
    let added = 0;
    while (from <= head) {
      const to = Math.min(head, from + this.cfg.chunk - 1);
      const [logs, mlogs] = await Promise.all([
        this.logs.getLogs({ address: AAVE_POOL, fromBlock: from, toBlock: to, topics: [[topicBorrow, topicLiq]] }),
        this.logs.getLogs({ address: MORPHO, fromBlock: from, toBlock: to, topics: [[this.iface.getEvent("Liquidate").topicHash]] }).catch(() => []),
      ]);
      for (const lg of mlogs) {
        const ev = this.iface.parseLog(lg);
        this.noteSeen("morpho", { block: lg.blockNumber, user: ev.args.borrower, liquidator: ev.args.caller, repaid: ev.args.repaidAssets.toString(), seized: ev.args.seizedAssets.toString(), market: ev.args.id });
      }
      for (const lg of logs) {
        if (lg.topics[0] === topicBorrow) {
          const user = ethers.getAddress("0x" + lg.topics[2].slice(-40));
          if (!this.borrowers.has(user)) { this.borrowers.set(user, {}); added++; }
        } else {
          const ev = this.iface.parseLog(lg);
          this.noteSeen("aave", { block: lg.blockNumber, user: ev.args.user, liquidator: ev.args.liquidator, debt: ev.args.debtToCover.toString(), collateral: ev.args.collateralAsset, debtAsset: ev.args.debtAsset });
        }
      }
      from = to + 1;
      this.liq.aave.lastDiscoveryBlock = to;
      if (first && (to - (head - this.cfg.lookback)) % (this.cfg.chunk * 10) === 0) { this.liq.aave.borrowers = this.borrowers.size; await this.save(); }
    }
    if (this.borrowers.size > this.cfg.maxBorrowers) { // recorte: los más recientes
      const keep = [...this.borrowers.keys()].slice(-this.cfg.maxBorrowers);
      this.borrowers = new Map(keep.map((a) => [a, this.borrowers.get(a)]));
    }
    this.liq.aave.borrowers = this.borrowers.size;
    await this.store.set("aaveBorrowers", { block: this.liq.aave.lastDiscoveryBlock, list: [...this.borrowers.keys()] });
    if (added) await this.diag(`liquidaciones: Aave v3 · ${this.borrowers.size} prestatarios (${added} nuevos) hasta el bloque ${this.liq.aave.lastDiscoveryBlock}`);
  }

  noteSeen(proto, ev) {
    this.liq.seen[proto]++;
    this.liq.seen.recent.unshift({ proto, ...ev });
    if (this.liq.seen.recent.length > MAX_RECENT) this.liq.seen.recent.length = MAX_RECENT;
    // ¿la habíamos visto nosotros como liquidable? medir cuántos bloques tardó alguien en tomarla
    const o = this.open.get(ev.user);
    if (o) { ev.blocksAfterUs = ev.block - o; this.open.delete(ev.user); this.liq.openUsers = Object.fromEntries(this.open); }
  }

  async scanAave({ block, ts, gas, ethUsd }) {
    if (!this.borrowers.size) return;
    this.scans++;
    const full = this.scans % this.cfg.fullEvery === 1;
    const list = full ? [...this.borrowers.keys()] : [...this.borrowers.entries()].filter(([, v]) => v.hf !== undefined && v.hf < this.cfg.watchHf).map(([a]) => a);
    if (!list.length) return;
    const calls = list.map((a) => [AAVE_POOL, this.iface.encodeFunctionData("getUserAccountData", [a])]);
    const res = await core.multicall(ethers, this.provider, calls, block);
    const cands = [];
    list.forEach((a, i) => {
      const raw = res[i]; if (!raw) return;
      const d = this.iface.decodeFunctionResult("getUserAccountData", raw);
      const debtUsd = Number(d.totalDebtBase) / 1e8, colUsd = Number(d.totalCollateralBase) / 1e8;
      const hf = debtUsd > 0 ? Number(d.healthFactor) / 1e18 : Infinity;
      this.borrowers.set(a, { hf, debtUsd, colUsd, at: block });
      if (debtUsd > 0 && hf < 1) {
        const closeFactor = hf < 0.95 ? 1 : 0.5;
        const repayUsd = Math.min(debtUsd * closeFactor, colUsd / (1 + this.cfg.aaveBonus));
        const estProfitUsd = repayUsd * this.cfg.aaveBonus - this.cfg.gasUsd;
        cands.push({ user: a, hf, debtUsd, colUsd, repayUsd, estProfitUsd });
      }
    });
    cands.sort((x, y) => y.estProfitUsd - x.estProfitUsd);
    this.liq.aave.candidates = cands.slice(0, 10); this.liq.aave.liquidatable = cands.length;
    this.liq.aave.scanned = list.length; this.liq.aave.watch = [...this.borrowers.values()].filter((v) => v.hf !== undefined && v.hf < this.cfg.watchHf).length;
    this.liq.aave.lastScan = Date.now(); this.liq.aave.scanBlock = block; this.liq.aave.error = null;
    const still = new Set(cands.map((c) => c.user));
    for (const [u, b] of this.open) if (list.includes(u) && !still.has(u)) { this.open.delete(u); }
    this.liq.openUsers = Object.fromEntries(this.open);
    for (const c of cands) this.episode("aave", c, block, ts);
    for (const c of cands.slice(0, 5)) this.onCandidate?.({ ...c, proto: "aave" }, { block, ts, gas, ethUsd });
  }

  episode(proto, c, block, ts) {
    if (this.open.has(c.user)) return;
    this.open.set(c.user, block);
    this.liq.openUsers = Object.fromEntries(this.open);
    this.liq.opportunities++;
    // el techo solo suma posiciones cuya ejecución no haya revertido en simulación (deuda mala fuera)
    if (c.estProfitUsd > 0 && !(this.badUsers?.has(c.user))) this.liq.estProfitUsd += c.estProfitUsd;
    const rec = { proto, block, ts, user: c.user, hf: c.hf, debtUsd: c.debtUsd, colUsd: c.colUsd, estProfitUsd: c.estProfitUsd, market: c.market ?? null };
    this.liq.recent.unshift(rec); if (this.liq.recent.length > MAX_RECENT) this.liq.recent.length = MAX_RECENT;
    this.diag(`liquidaciones: ${proto} · posición liquidable ${c.user.slice(0, 10)}… HF ${c.hf.toFixed(4)} · deuda $${c.debtUsd.toFixed(2)} · colateral $${c.colUsd.toFixed(2)} · beneficio estimado $${c.estProfitUsd.toFixed(2)}${c.market ? ` · ${c.market}` : ""}`).catch(() => {});
  }

  /** Morpho Blue: posiciones con HF bajo según la API, verificadas on-chain. */
  async scanMorpho({ block, ts, gas, ethUsd }) {
    const mk = `market { marketId lltv loanAsset { address symbol decimals } collateralAsset { address symbol decimals } oracle { address } irmAddress }`;
    const fieldsA = `items { healthFactor user { address } state { borrowAssets borrowAssetsUsd collateral collateralUsd } ${mk} }`;
    const fieldsB = `items { user { address } state { healthFactor borrowAssets borrowAssetsUsd collateral collateralUsd } ${mk} }`;
    // variantes por si el esquema no admite algún campo/filtro/orden: se usa la primera que responda sin error
    const queries = [];
    for (const f of [fieldsA, fieldsB]) {
      queries.push(`{ marketPositions(first: 60, orderBy: HealthFactor, orderDirection: Asc, where: { chainId_in: [8453], healthFactor_lte: 1.05, borrowShares_gte: 1 }) { ${f} } }`);
      queries.push(`{ marketPositions(first: 100, orderBy: HealthFactor, orderDirection: Asc, where: { chainId_in: [8453], borrowShares_gte: 1 }) { ${f} } }`);
      queries.push(`{ marketPositions(first: 100, orderBy: BorrowShares, orderDirection: Desc, where: { chainId_in: [8453] }) { ${f} } }`);
    }
    let items = null; const errs = [];
    for (const query of queries) {
      const r = await fetch(MORPHO_API, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000) });
      let j = null; try { j = await r.json(); } catch { /* sin JSON */ }
      if (!r.ok || j?.errors?.length) { errs.push(`v${errs.length + 1}: ${j?.errors?.length ? j.errors[0].message.slice(0, 90) : "HTTP " + r.status}`); continue; }
      items = j?.data?.marketPositions?.items ?? []; this.liq.morpho.queryVariant = errs.length + 1; break;
    }
    if (items === null) throw new Error("API Morpho: " + errs.join(" | ").slice(0, 400));
    items = items.map((it) => ({ ...it, market: it.market ? { ...it.market, uniqueKey: it.market.uniqueKey ?? it.market.marketId, oracleAddress: it.market.oracleAddress ?? it.market.oracle?.address } : it.market, healthFactor: it.healthFactor ?? it.state?.healthFactor, borrowAssets: it.state?.borrowAssets ?? it.borrowAssets, borrowAssetsUsd: it.state?.borrowAssetsUsd ?? it.borrowAssetsUsd, collateral: it.state?.collateral ?? it.collateral, collateralUsd: it.state?.collateralUsd ?? it.collateralUsd }))
      .filter((it) => it.market?.oracleAddress && it.user?.address && Number(it.healthFactor ?? 0) < 1.05 && Number(it.borrowAssets ?? 0) > 0);
    this.liq.morpho.lastApi = Date.now(); this.liq.morpho.apiPositions = items.length;
    // verificación on-chain de las más cercanas a 1
    const calls = [];
    for (const it of items) {
      calls.push([MORPHO, this.iface.encodeFunctionData("position", [it.market.uniqueKey, it.user.address])], [MORPHO, this.iface.encodeFunctionData("market", [it.market.uniqueKey])], [it.market.oracleAddress, this.iface.encodeFunctionData("price")]);
    }
    const res = calls.length ? await core.multicall(ethers, this.provider, calls, block) : [];
    const cands = [];
    items.forEach((it, i) => {
      const [p, m, pr] = res.slice(3 * i, 3 * i + 3);
      if (!p || !m || !pr) return;
      const pos = this.iface.decodeFunctionResult("position", p), mk = this.iface.decodeFunctionResult("market", m);
      const price = BigInt(pr);
      if (price === 0n) return; // oráculo sin precio: no se puede valorar ni liquidar
      const borrowed = mk.totalBorrowShares > 0n ? (pos.borrowShares * mk.totalBorrowAssets + mk.totalBorrowShares - 1n) / mk.totalBorrowShares : 0n;
      const lltv = BigInt(it.market.lltv);
      const maxBorrow = (pos.collateral * price / 10n ** 36n) * lltv / 10n ** 18n;
      if (borrowed === 0n || borrowed <= maxBorrow) return;
      const hf = Number(maxBorrow) / Number(borrowed);
      const lif = Math.min(1.15, 1 / (1 - 0.3 * (1 - Number(lltv) / 1e18)));
      const debtUsd = Number(it.borrowAssetsUsd ?? 0), colUsd = Number(it.collateralUsd ?? 0);
      const repayUsd = Math.min(debtUsd, colUsd / lif);
      const estProfitUsd = repayUsd * (lif - 1) - this.cfg.gasUsd;
      cands.push({ user: it.user.address, hf, debtUsd, colUsd, repayUsd, estProfitUsd, market: `${it.market.collateralAsset.symbol}/${it.market.loanAsset.symbol} LLTV ${(Number(lltv) / 1e16).toFixed(0)}%`, id: it.market.uniqueKey,
        raw: it, lif, price, collateralRaw: pos.collateral.toString(), borrowedRaw: borrowed.toString() });
    });
    cands.sort((x, y) => y.estProfitUsd - x.estProfitUsd);
    this.liq.morpho.candidates = cands.slice(0, 10).map(({ raw, price, collateralRaw, borrowedRaw, ...rest }) => rest); this.liq.morpho.liquidatable = cands.length; this.liq.morpho.error = null;
    for (const c of cands) this.episode("morpho", c, block, ts);
    for (const c of cands.slice(0, 5)) this.onCandidate?.({ ...c, proto: "morpho" }, { block, ts, gas, ethUsd });
  }
}
