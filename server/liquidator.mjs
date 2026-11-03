// Ejecución de liquidaciones (Aave v3 y Morpho Blue) con el contrato ArbExecutor:
//   flashloan del token de deuda (Morpho, 0%) → salto AAVE_LIQ / MORPHO_LIQ (deuda → colateral con bono)
//   → venta del colateral por el mejor pool (v2/v3/v4, matemática exacta) → devolución → beneficio al owner.
// Se simula con eth_call desde la wallet; se envía solo si el beneficio simulado cubre el gas con margen.

import { ethers } from "ethers";
import * as core from "../src/core.js";
import { AAVE_POOL, MORPHO } from "./liquidations.mjs";

const ABI = [
  "function getReservesList() view returns (address[])",
  "function getReserveData(address) view returns (tuple(uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))",
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getPriceOracle() view returns (address)",
  "function getAssetPrice(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const MAX_RECENT = 60;

export function emptyLiqExec() {
  return { simulated: 0, wouldSucceed: 0, wouldRevert: 0, sent: 0, confirmed: 0, reverted: 0, realizedUsd: 0, gasPaidUsd: 0, byReason: {}, recent: [], pending: [], lastError: null };
}

export class Liquidator {
  constructor({ provider, store, diag, executor, liquidations }) {
    this.provider = provider; this.store = store; this.diag = diag; this.executor = executor; this.liqs = liquidations;
    this.iface = new ethers.Interface(ABI);
    this.limits = { minNetUsd: Number(process.env.MIN_LIQ_NET_USD ?? 0.05), maxPerHour: Number(process.env.MAX_LIQ_PER_HOUR ?? 10) };
    this.aave = null; // {reserves: Map(asset -> {aToken, vDebt, bonusBps, decimals, symbol}), oracle}
    this.poolCache = new Map(); // "a|b" -> {at, pools}
    this.sentTimes = []; this.inflight = new Set(); this.backoff = new Map();
  }

  async init() {
    this.x = (await this.store.get("liqExec")) ?? emptyLiqExec();
    this.x.pending ??= [];
  }
  async save() { await this.store.set("liqExec", this.x); }

  // ------------------------------------------------------------------ Aave: reservas y posición detallada
  async loadAave() {
    if (this.aave && Date.now() - this.aave.at < 3600_000) return this.aave;
    const pool = new ethers.Contract(AAVE_POOL, ABI, this.provider);
    const [list, ap] = await Promise.all([pool.getReservesList(), pool.ADDRESSES_PROVIDER()]);
    const oracle = await new ethers.Contract(ap, ABI, this.provider).getPriceOracle();
    const calls = list.flatMap((a) => [[AAVE_POOL, this.iface.encodeFunctionData("getReserveData", [a])], [a, this.iface.encodeFunctionData("decimals")], [a, this.iface.encodeFunctionData("symbol")]]);
    const res = await core.multicall(ethers, this.provider, calls);
    const reserves = new Map();
    list.forEach((a, i) => {
      const [rd, dec, sym] = res.slice(3 * i, 3 * i + 3);
      if (!rd) return;
      const d = this.iface.decodeFunctionResult("getReserveData", rd)[0];
      const cfg = BigInt(d.configuration);
      const bonusBps = Number((cfg >> 32n) & 0xffffn); // 10500 = 5%
      const active = ((cfg >> 56n) & 1n) === 1n, frozen = ((cfg >> 57n) & 1n) === 1n;
      let symbol = "?"; try { symbol = this.iface.decodeFunctionResult("symbol", sym)[0]; } catch { /* bytes32 symbol */ }
      reserves.set(a.toLowerCase(), { address: a, aToken: d.aTokenAddress, vDebt: d.variableDebtTokenAddress, bonusBps, decimals: dec ? Number(BigInt(dec)) : 18, symbol, active, frozen });
    });
    this.aave = { at: Date.now(), reserves, oracle };
    return this.aave;
  }

  /** Deuda y colateral por reserva del usuario (+ precios del oráculo de Aave en USD 8 dec). */
  async aavePosition(user) {
    const { reserves, oracle } = await this.loadAave();
    const rs = [...reserves.values()];
    const calls = rs.flatMap((r) => [[r.aToken, this.iface.encodeFunctionData("balanceOf", [user])], [r.vDebt, this.iface.encodeFunctionData("balanceOf", [user])], [oracle, this.iface.encodeFunctionData("getAssetPrice", [r.address])]]);
    const res = await core.multicall(ethers, this.provider, calls);
    const debts = [], cols = [];
    rs.forEach((r, i) => {
      const [a, d, p] = res.slice(3 * i, 3 * i + 3);
      const price = p ? Number(BigInt(p)) / 1e8 : 0;
      const col = a ? BigInt(a) : 0n, debt = d ? BigInt(d) : 0n;
      if (col > 0n) cols.push({ ...r, amount: col, usd: (Number(col) / 10 ** r.decimals) * price, price });
      if (debt > 0n) debts.push({ ...r, amount: debt, usd: (Number(debt) / 10 ** r.decimals) * price, price });
    });
    debts.sort((x, y) => y.usd - x.usd); cols.sort((x, y) => y.usd - x.usd);
    return { debts, cols };
  }

  // ------------------------------------------------------------------ ruta de venta del colateral
  async sellRoute(colTok, loanTok, amountIn) {
    const key = colTok.address.toLowerCase() + "|" + loanTok.address.toLowerCase();
    let c = this.poolCache.get(key);
    if (!c || Date.now() - c.at > 600_000) {
      const W = core.TOKENS.WETH;
      const toks = [colTok.address, loanTok.address]; if (![colTok, loanTok].some((t) => t.address.toLowerCase() === W.address.toLowerCase())) toks.push(W.address);
      const found = await core.existingPools(ethers, this.provider, toks);
      const meta = new Map([colTok, loanTok, { sym: W.sym, address: W.address, decimals: W.decimals }].map((t) => [t.address.toLowerCase(), { sym: t.sym, address: t.address, decimals: t.decimals }]));
      const pools = await core.loadPools(ethers, this.provider, found, meta);
      c = { at: Date.now(), pools };
      this.poolCache.set(key, c);
    } else { await core.refreshPools(ethers, this.provider, c.pools); }
    try { await core.refreshTicks(ethers, this.provider, c.pools); } catch { /* sin ticks: reservas virtuales */ }
    const live = c.pools.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n);
    const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
    let best = null;
    // directo
    for (const p of live) {
      if (!((eq(p.token0.address, colTok.address) && eq(p.token1.address, loanTok.address)) || (eq(p.token1.address, colTok.address) && eq(p.token0.address, loanTok.address)))) continue;
      const out = core.swapOut(p, colTok.address, amountIn);
      if (!best || out > best.out) best = { out, route: [p] };
    }
    // vía WETH
    const W = core.TOKENS.WETH.address;
    if (!eq(colTok.address, W) && !eq(loanTok.address, W)) {
      const first = live.filter((p) => [p.token0.address, p.token1.address].some((a) => eq(a, colTok.address)) && [p.token0.address, p.token1.address].some((a) => eq(a, W)));
      const second = live.filter((p) => [p.token0.address, p.token1.address].some((a) => eq(a, W)) && [p.token0.address, p.token1.address].some((a) => eq(a, loanTok.address)));
      for (const p1 of first) { const mid = core.swapOut(p1, colTok.address, amountIn); if (mid === 0n) continue; for (const p2 of second) { const out = core.swapOut(p2, W, mid); if (!best || out > best.out) best = { out, route: [p1, p2] }; } }
    }
    return best;
  }

  hopFor(p, tokenIn, tokenOut) {
    if (p.kind === "v4") return [2, p.manager, tokenIn, tokenOut, 0, Number(p.feePips), p.tickSpacing, "0x"];
    return [p.kind === "v3" ? 1 : 0, p.address, tokenIn, tokenOut, p.kind === "v3" ? 0 : Math.min(65535, Math.round(p.feeBps)), 0, 0, "0x"];
  }

  // ------------------------------------------------------------------ intento
  async attempt(cand, ctx) {
    const key = cand.proto + ":" + cand.user;
    if (this.inflight.has(key) || !this.executor?.wallet || !this.executor.p1?.executor) return;
    // tras un revert, la misma posición se reintenta como mucho cada 10 min (las posiciones con deuda mala no cambian)
    const b = this.backoff.get(key);
    if (b && Date.now() < b) return;
    this.inflight.add(key);
    try { await this._attempt(cand, ctx); } catch (e) { this.x.lastError = `${key}: ${e.shortMessage || e.message}`; await this.diag(`liquidación: error ${this.x.lastError.slice(0, 120)}`); }
    finally { this.inflight.delete(key); await this.save(); }
  }

  async _attempt(cand, { block, gas, ethUsd }) {
    const wallet = this.executor.wallet, exec = this.executor.p1.executor;
    let loanTok, colTok, hop0, amount, label, valueUsd, expectedCol = 0n;
    if (cand.proto === "aave") {
      const { debts, cols } = await this.aavePosition(cand.user);
      if (!debts.length || !cols.length) return;
      const d = debts[0], c = cols[0];
      loanTok = { sym: d.symbol, address: d.address, decimals: d.decimals }; colTok = { sym: c.symbol, address: c.address, decimals: c.decimals };
      const closeFactor = cand.hf < 0.95 ? 1 : 0.5;
      const maxByCol = (c.usd / (c.bonusBps / 10000)) / d.price; // deuda cubrible con el colateral disponible
      const coverUnits = Math.min((Number(d.amount) / 10 ** d.decimals) * closeFactor, maxByCol) * 0.995;
      amount = BigInt(Math.floor(coverUnits * 10 ** d.decimals));
      hop0 = [3, AAVE_POOL, d.address, c.address, 0, 0, 0, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [cand.user])];
      label = `Aave · ${d.symbol} deuda → ${c.symbol} colateral (bono ${(c.bonusBps / 100 - 100).toFixed(1)}%)`;
      valueUsd = coverUnits * d.price;
      expectedCol = BigInt(Math.floor((valueUsd * (c.bonusBps / 10000) / c.price) * 10 ** c.decimals));
    } else {
      const m = cand.raw; // de la API: market + posición
      loanTok = { sym: m.market.loanAsset.symbol, address: ethers.getAddress(m.market.loanAsset.address), decimals: Number(m.market.loanAsset.decimals) };
      colTok = { sym: m.market.collateralAsset.symbol, address: ethers.getAddress(m.market.collateralAsset.address), decimals: Number(m.market.collateralAsset.decimals) };
      const lif = cand.lif, price = cand.price; // price ×1e36 (colateral → préstamo)
      const collateral = BigInt(cand.collateralRaw), borrowed = BigInt(cand.borrowedRaw);
      // máximo incautable: todo el colateral o el que cubre toda la deuda·LIF
      if (price === 0n) return;
      const maxSeizeByDebt = (borrowed * BigInt(Math.floor(lif * 1e6)) / 1_000_000n) * 10n ** 36n / price;
      const seized = (collateral < maxSeizeByDebt ? collateral : maxSeizeByDebt) * 995n / 1000n;
      const repaid = (seized * price / 10n ** 36n) * 1_000_000n / BigInt(Math.floor(lif * 1e6));
      amount = repaid * 1005n / 1000n; // margen de redondeo; lo no usado vuelve con el préstamo
      const mp = [loanTok.address, colTok.address, ethers.getAddress(m.market.oracleAddress), ethers.getAddress(m.market.irmAddress), BigInt(m.market.lltv)];
      hop0 = [4, MORPHO, loanTok.address, colTok.address, 0, 0, 0, ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address,address,address,address,uint256)", "address", "uint256"], [mp, cand.user, seized])];
      label = `Morpho · ${colTok.sym}/${loanTok.sym} LLTV ${(Number(m.market.lltv) / 1e16).toFixed(0)}% (LIF ${((lif - 1) * 100).toFixed(1)}%)`;
      expectedCol = seized;
      if (price === 0n || borrowed === 0n) return;
      valueUsd = (Number(repaid) / 10 ** loanTok.decimals) * (cand.debtUsd / Math.max(1e-9, Number(borrowed) / 10 ** loanTok.decimals));
    }
    if (amount <= 0n) return;
    // ruta de venta del colateral (cantidad esperada ≈ valor/precio; se usa la salida real del salto en la cadena)
    const route = await this.sellRoute(colTok, loanTok, expectedCol > 0n ? expectedCol : 1n);
    if (!route) { this.note(cand, label, "sin pool para vender el colateral"); return; }
    const hops = [hop0];
    let t = colTok.address;
    for (const p of route.route) { const out = core.other(p, t).address; hops.push(this.hopFor(p, t, out)); t = out; }
    // prestamista: Morpho (0%) si tiene el token; si no, Balancer v3
    const morphoBal = await new ethers.Contract(loanTok.address, ABI, this.provider).balanceOf(MORPHO);
    const source = morphoBal >= amount ? 0 : 1, lender = source === 0 ? core.LENDERS[0].address : core.LENDERS[1].address;
    const plan = [source, lender, loanTok.address, amount, 0n, hops];
    const data = this.executor.iface.encodeFunctionData("execute", [plan]);
    const tx = { to: exec, from: wallet.address, data };
    const rec = { block, ts: Math.floor(Date.now() / 1000), proto: cand.proto, user: cand.user, label, amountUsd: valueUsd, ok: false, reason: null, profitUsd: null, gasUsd: null, netUsd: null, sent: null };
    this.x.simulated++;
    try {
      const [ret, gasEst] = await Promise.all([this.provider.call(tx), this.provider.estimateGas(tx)]);
      const profit = this.executor.iface.decodeFunctionResult("execute", ret)[0];
      const unitUsd = valueUsd / (Number(amount) / 10 ** loanTok.decimals);
      rec.profitUsd = (Number(profit) / 10 ** loanTok.decimals) * unitUsd;
      rec.gasUsd = (Number(gasEst * (gas.baseFee + gas.priority) + gas.l1Fee) / 1e18) * ethUsd;
      rec.netUsd = rec.profitUsd - rec.gasUsd; rec.ok = true; rec.gasEst = Number(gasEst);
      this.x.wouldSucceed++;
      await this.diag(`liquidación: simulada ${label} · ${cand.user.slice(0, 10)}… · paga $${valueUsd.toFixed(2)} · beneficio on-chain $${rec.profitUsd.toFixed(4)} − gas $${rec.gasUsd.toFixed(4)} = $${rec.netUsd.toFixed(4)}`);
    } catch (e) {
      rec.reason = decodeRevert(this.executor.iface, e);
      this.x.wouldRevert++; this.x.byReason[rec.reason] = (this.x.byReason[rec.reason] ?? 0) + 1;
      this.backoff.set(cand.proto + ":" + cand.user, Date.now() + 10 * 60_000);
      if ((this.x.wouldRevert % 25) === 1) await this.diag(`liquidación: revertiría (${rec.reason}) · ${label} · ${cand.user.slice(0, 10)}… · paga $${valueUsd.toFixed(2)} (se omiten avisos repetidos; ${this.x.wouldRevert} reverts en total)`);
      this.push(rec); return;
    }
    if (this.executor.mode !== "live") { rec.sent = "modo simulación"; this.push(rec); return; }
    if (rec.netUsd < this.limits.minNetUsd) { rec.sent = `omitida: neto $${rec.netUsd.toFixed(4)} < mínimo $${this.limits.minNetUsd}`; this.push(rec); return; }
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
    if (this.sentTimes.length >= this.limits.maxPerHour) { rec.sent = "omitida: tope por hora"; this.push(rec); return; }
    try {
      const prio = gas.priority > core.MIN_PRIORITY_WEI * 10n ? gas.priority : core.MIN_PRIORITY_WEI * 10n; // 0.01 gwei: delante de los que pagan lo mínimo
      const sent = await this.executor.withSender((w) => w.sendTransaction({ to: exec, data, gasLimit: BigInt(Math.floor(rec.gasEst * 1.3)), maxFeePerGas: gas.baseFee * 3n + prio, maxPriorityFeePerGas: prio }));
      this.sentTimes.push(now); this.x.sent++; rec.sent = sent.hash;
      this.x.pending.push({ hash: sent.hash, sentAt: now, label, user: cand.user, loan: loanTok, unitUsd: valueUsd / (Number(amount) / 10 ** loanTok.decimals) });
      await this.diag(`liquidación: ENVIADA ${sent.hash} · ${label} · neto simulado $${rec.netUsd.toFixed(4)}`);
    } catch (e) { rec.sent = `error al enviar: ${e.shortMessage || e.message}`; this.x.lastError = rec.sent; await this.diag(`liquidación: ${rec.sent}`); }
    this.push(rec);
  }

  note(cand, label, why) { this.push({ block: 0, ts: Math.floor(Date.now() / 1000), proto: cand.proto, user: cand.user, label, ok: false, reason: why, sent: null }); }
  push(rec) { this.x.recent.unshift(rec); if (this.x.recent.length > MAX_RECENT) this.x.recent.length = MAX_RECENT; }

  async reconcile(ethUsd) {
    if (!this.x.pending.length) return;
    const keep = [];
    for (const t of this.x.pending) {
      let rcpt = null;
      try { rcpt = await this.provider.getTransactionReceipt(t.hash); } catch { /* red */ }
      if (!rcpt) { if (Date.now() - t.sentAt > 15 * 60_000) await this.diag(`liquidación: ${t.hash} no minada en 15 min`); else keep.push(t); continue; }
      const paid = (Number(rcpt.gasUsed * (rcpt.gasPrice ?? 0n)) / 1e18) * ethUsd;
      this.x.gasPaidUsd += paid;
      const rec = this.x.recent.find((r) => r.sent === t.hash);
      if (rcpt.status === 1) {
        const ev = rcpt.logs.map((l) => { try { return this.executor.iface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Executed");
        const realized = ev ? (Number(ev.args.profit) / 10 ** t.loan.decimals) * t.unitUsd : 0;
        this.x.confirmed++; this.x.realizedUsd += realized - paid;
        if (rec) rec.sent = `${t.hash} · confirmada · +$${(realized - paid).toFixed(4)}`;
        await this.diag(`liquidación: CONFIRMADA ${t.hash} · ${t.label} · beneficio $${realized.toFixed(4)} − gas $${paid.toFixed(4)} = +$${(realized - paid).toFixed(4)}`);
      } else {
        this.x.reverted++; this.x.realizedUsd -= paid;
        if (rec) rec.sent = `${t.hash} · revertida (gas $${paid.toFixed(4)})`;
        await this.diag(`liquidación: revertida ${t.hash} · ${t.label} · gas perdido $${paid.toFixed(4)}`);
      }
    }
    this.x.pending = keep;
    await this.save();
  }
}

function decodeRevert(iface, e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try { const d = iface.parseError(data); return d ? `${d.name}${d.args.length ? "(" + d.args.map(String).join(",") + ")" : ""}` : data.slice(0, 10); } catch { /* */ }
    return "revert " + data.slice(0, 10);
  }
  return (e?.shortMessage || e?.message || "revert").slice(0, 120);
}
