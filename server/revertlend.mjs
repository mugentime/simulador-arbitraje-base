// Revert Lend (sustituto de YLDR): préstamos USDC contra posiciones Uniswap v3 / Aerodrome Slipstream.
// Fase 0, solo observación: estado de cada vault (deuda, prestado, utilización, tasas), préstamos descubiertos por
// eventos (Add/Borrow, adelante + backfill), salud por loanInfo() y liquidaciones ajenas (Liquidate).
// Liquidar es permisionless: el liquidador paga `liquidationCost` en el activo del vault y recibe la posición
// (amount0/amount1) por `liquidationValue`; beneficio = value − cost − desarme − gas.

import { ethers } from "ethers";
import * as core from "../src/core.js";

// docs.revert.finance/revert/resources/contract-addresses
export const REVERT_VAULTS = {
  base: [
    { name: "Uniswap v3", vault: "0x36AEAe0E411a1E28372e0d66f02E57744EbE7599", irm: "0xD0524a77C8E2bD22b1F57268fD6beA1973aC7927" },
    { name: "Aerodrome Slipstream", vault: "0x1EF7C181188687e20A9750714f1b9DE6F70f17C0", irm: "0x9E29b74336A0D698AD600b3e52729bFda85e0564" },
  ],
  arbitrum: [{ name: "Uniswap v3", vault: "0x74e6afef5705beb126c6d3bf46f8fad8f3e07825", irm: "0x18616C0a8389A2cabF596f91D3e6CCC626E58997" }],
};
const YEAR = 31_536_000;
const Q64 = 2n ** 64n;

const iface = new ethers.Interface([
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function vaultInfo() view returns (uint256 debt, uint256 lent, uint256 balance, uint256 reserves, uint256 debtExchangeRateX96, uint256 lendExchangeRateX96)",
  "function loans(uint256) view returns (uint256 debtShares)",
  "function loanInfo(uint256) view returns (uint256 debt, uint256 fullValue, uint256 collateralValue, uint256 liquidationCost, uint256 liquidationValue)",
  "function getRatesPerSecondX64(uint256 cash, uint256 debt) view returns (uint256 borrowRateX64, uint256 supplyRateX64)",
  "event Add(uint256 indexed tokenId, address owner, uint256 oldTokenId)",
  "event Borrow(uint256 indexed tokenId, address owner, uint256 assets, uint256 shares)",
  "event Liquidate(uint256 indexed tokenId, address liquidator, address owner, uint256 value, uint256 cost, uint256 amount0, uint256 amount1, uint256 reserve, uint256 missing)",
]);
const enc = (fn, a = []) => iface.encodeFunctionData(fn, a);
const dec = (fn, r) => (r ? iface.decodeFunctionResult(fn, r) : null);

/** Tasas anuales desde las tasas por segundo en Q64. */
export function ratesFromX64(borrowX64, supplyX64) {
  const b = Number(borrowX64) / Number(Q64), s = Number(supplyX64) / Number(Q64);
  return { borrowApr: b * YEAR, supplyApr: s * YEAR, borrowApy: Math.expm1(b * YEAR), supplyApy: Math.expm1(s * YEAR) };
}

/** Resumen de un préstamo a partir de loanInfo (unidades crudas del activo). */
export function loanSummary({ debt, fullValue, collateralValue, liquidationCost, liquidationValue }, decimals, { exitCostBps = 10, gasUsd = 0.03, assetUsd = 1 } = {}) {
  const k = 10 ** decimals;
  const d = Number(debt) / k * assetUsd, full = Number(fullValue) / k * assetUsd, col = Number(collateralValue) / k * assetUsd;
  const cost = Number(liquidationCost) / k * assetUsd, value = Number(liquidationValue) / k * assetUsd;
  const liquidatable = liquidationCost > 0n || liquidationValue > 0n;
  return { debtUsd: d, fullUsd: full, colUsd: col, health: d > 0 ? col / d : Infinity, liquidatable, costUsd: cost, valueUsd: value,
    estProfitUsd: liquidatable ? value - cost - value * exitCostBps / 1e4 - gasUsd : 0 };
}

export class RevertLend {
  constructor({ provider, logsProvider, store, diag }) {
    this.provider = provider; this.logs = logsProvider ?? provider; this.store = store; this.diag = diag;
    this.vaults = REVERT_VAULTS[core.CHAIN.key] ?? [];
    this.cfg = {
      scanEvery: Number(process.env.RVL_SCAN_BLOCKS ?? 30),
      backfill: Number(process.env.RVL_BACKFILL_BLOCKS ?? (core.CHAIN.key === "arbitrum" ? 3_500_000 : 450_000)), // ≈ 10 días
      maxChunks: Number(process.env.RVL_CHUNKS_PER_SCAN ?? 30),
      gasUsd: Number(process.env.RVL_GAS_USD ?? 0.03),
    };
    this.busy = false; this.lastLog = 0; this.open = new Set();
  }
  get active() { return this.vaults.length > 0 && process.env.REVERT_LEND !== "0"; }

  async init() {
    this.s = (await this.store.get("rvl")) ?? { version: 1, vaults: {}, opportunities: 0, estProfitUsd: 0, lastScanBlock: null, lastError: null };
    this.ids = (await this.store.get("rvlIds")) ?? {}; // vault -> [tokenId]
    for (const v of this.vaults) {
      this.s.vaults[v.vault] ??= { name: v.name, vault: v.vault, fwdBlock: null, backBlock: null, backTarget: null, logChunk: 5000, loans: 0, debtUsd: 0, colUsd: 0, minHealth: null, near110: 0, liquidatable: 0, candidates: [], seen: [], seenCount: 0, seenProfitUsd: 0 };
      this.ids[v.vault] ??= [];
    }
  }
  async save() { this.s.updatedAt = Date.now(); await this.store.set("rvl", this.s); }

  async onBlock({ block }) {
    if (!this.active || this.busy || (this.s.lastScanBlock !== null && block - this.s.lastScanBlock < this.cfg.scanEvery)) return;
    this.busy = true;
    try {
      for (const v of this.vaults) await this.scanVault(v, block);
      this.s.lastScanBlock = block; this.s.lastError = null;
    } catch (e) { this.s.lastError = (e.shortMessage || e.message || String(e)).slice(0, 200); }
    finally { this.busy = false; await this.save().catch(() => {}); }
    if (Date.now() - this.lastLog > 30 * 60_000) { this.lastLog = Date.now(); console.log(`${new Date().toISOString()} ${this.line()}`); }
  }

  async scanVault(v, head) {
    const V = this.s.vaults[v.vault];
    if (!V.asset) {
      const [a] = await core.multicall(ethers, this.provider, [[v.vault, enc("asset")]]);
      V.asset = dec("asset", a)?.[0] ?? null;
      const [d, s] = V.asset ? await core.multicall(ethers, this.provider, [[V.asset, enc("decimals")], [V.asset, "0x95d89b41"]]) : [];
      V.decimals = Number(dec("decimals", d)?.[0] ?? 6);
      try { V.assetSymbol = s ? ethers.AbiCoder.defaultAbiCoder().decode(["string"], s)[0] : "?"; } catch { V.assetSymbol = "?"; }
    }
    await this.discover(v, V, head);
    const ids = this.ids[v.vault];
    const calls = [[v.vault, enc("vaultInfo")], ...ids.map((id) => [v.vault, enc("loanInfo", [id])])];
    const res = await core.multicall(ethers, this.provider, calls, head);
    const vi = dec("vaultInfo", res[0]);
    const k = 10 ** V.decimals;
    if (vi) {
      Object.assign(V, { debtTotal: Number(vi.debt) / k, lent: Number(vi.lent) / k, cash: Number(vi.balance) / k, reserves: Number(vi.reserves) / k });
      V.utilization = V.lent ? V.debtTotal / V.lent : 0;
      const [r] = await core.multicall(ethers, this.provider, [[v.irm, enc("getRatesPerSecondX64", [vi.balance, vi.debt])]]);
      const rr = dec("getRatesPerSecondX64", r);
      if (rr) Object.assign(V, ratesFromX64(rr.borrowRateX64, rr.supplyRateX64)); // supply antes de la reserva del protocolo
    }
    let loans = 0, debtUsd = 0, colUsd = 0, near110 = 0, minHealth = null; const cands = []; const keep = [];
    ids.forEach((id, i) => {
      const li = dec("loanInfo", res[i + 1]); if (!li) { keep.push(id); return; }
      if (li.debt === 0n) return; // pagado o retirado: deja de vigilarse
      keep.push(id);
      const s = loanSummary(li, V.decimals, { gasUsd: this.cfg.gasUsd });
      loans++; debtUsd += s.debtUsd; colUsd += s.colUsd;
      if (s.health < 1.1) near110++;
      if (minHealth === null || s.health < minHealth) minHealth = s.health;
      if (s.health < 1.1 || s.liquidatable) cands.push({ tokenId: id, ...s });
    });
    this.ids[v.vault] = keep;
    cands.sort((a, b) => a.health - b.health);
    Object.assign(V, { loans, debtUsd, colUsd, near110, minHealth, liquidatable: cands.filter((c) => c.liquidatable).length, candidates: cands.slice(0, 10) });
    for (const c of cands.filter((x) => x.liquidatable)) {
      const key = `${v.vault}|${c.tokenId}`; if (this.open.has(key)) continue;
      this.open.add(key); this.s.opportunities++; if (c.estProfitUsd > 0) this.s.estProfitUsd += c.estProfitUsd;
      this.diag(`revert-lend: ${v.name} · préstamo ${c.tokenId} liquidable · deuda $${c.debtUsd.toFixed(2)} · costo $${c.costUsd.toFixed(2)} → recibe $${c.valueUsd.toFixed(2)} · neto est. $${c.estProfitUsd.toFixed(2)}`).catch(() => {});
    }
    for (const key of [...this.open]) if (key.startsWith(v.vault) && !cands.some((c) => c.liquidatable && `${v.vault}|${c.tokenId}` === key)) this.open.delete(key);
  }

  async discover(v, V, head) {
    const t = [iface.getEvent("Add").topicHash, iface.getEvent("Borrow").topicHash, iface.getEvent("Liquidate").topicHash];
    if (V.fwdBlock === null) { V.fwdBlock = head; V.backBlock = head; V.backTarget = head - this.cfg.backfill; }
    const get = async (from, to) => {
      for (;;) {
        try { return await this.logs.getLogs({ address: v.vault, fromBlock: from, toBlock: to, topics: [t] }); }
        catch (e) { if (V.logChunk <= 250) throw e; V.logChunk = Math.floor(V.logChunk / 2); to = Math.min(to, from + V.logChunk - 1); }
      }
    };
    const set = new Set(this.ids[v.vault].map(String));
    const apply = (logs) => {
      for (const lg of logs) {
        const id = BigInt(lg.topics[1]).toString();
        if (lg.topics[0] === t[2]) {
          const ev = iface.parseLog(lg); const k = 10 ** V.decimals;
          const profit = (Number(ev.args.value) - Number(ev.args.cost)) / k;
          V.seenCount++; V.seenProfitUsd += profit;
          if (!V.seen.some((x) => x.tx === lg.transactionHash)) { V.seen.unshift({ block: lg.blockNumber, tx: lg.transactionHash, tokenId: id, liquidator: ev.args.liquidator, costUsd: Number(ev.args.cost) / k, valueUsd: Number(ev.args.value) / k, profitUsd: profit, missing: ev.args.missing > 0n }); V.seen.length = Math.min(V.seen.length, 40); }
        } else set.add(id);
      }
    };
    let chunks = 0;
    while (V.fwdBlock < head && chunks < this.cfg.maxChunks) { const from = V.fwdBlock + 1, to = Math.min(head, from + V.logChunk - 1); apply(await get(from, to)); V.fwdBlock = to; chunks++; }
    while (V.backBlock > V.backTarget && chunks < this.cfg.maxChunks) { const to = V.backBlock - 1, from = Math.max(V.backTarget, to - V.logChunk + 1); apply(await get(from, to)); V.backBlock = from; chunks++; }
    this.ids[v.vault] = [...set];
    if (chunks) await this.store.set("rvlIds", this.ids);
  }

  line() {
    const parts = Object.values(this.s.vaults).map((V) => `${V.name}: ${V.loans} préstamos ($${(V.debtUsd ?? 0).toFixed(0)} deuda / $${(V.colUsd ?? 0).toFixed(0)} colateral), salud mín ${V.minHealth?.toFixed(3) ?? "—"}, <1.10: ${V.near110}, liquidables ${V.liquidatable}, util ${((V.utilization ?? 0) * 100).toFixed(0)} %, préstamo ${V.borrowApy !== undefined ? (V.borrowApy * 100).toFixed(2) : "—"} % / depósito ${V.supplyApy !== undefined ? (V.supplyApy * 100).toFixed(2) : "—"} %, liquidaciones ajenas ${V.seenCount} ($${(V.seenProfitUsd ?? 0).toFixed(2)} ganado), backfill ${V.backBlock !== null ? Math.round((V.fwdBlock - V.backBlock) / 1000) + "k" : "—"}`);
    return `revert-lend: ${parts.join(" | ")}${this.s.lastError ? ` · error: ${this.s.lastError}` : ""}`;
  }
}
