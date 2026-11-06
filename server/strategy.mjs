// Estrategia activada por Jose (2026-11-05): depósito simple de USDC en el vault de préstamo de Revert Lend (Uniswap v3, Base),
// financiado con el ETH de la wallet del executor. Sin apalancamiento: no hay precio que liquide.
// Una sola ejecución por etiqueta (STRATEGY_RUN=<etiqueta>); el estado persiste en el volumen.
//   Entrada (STRATEGY=revert-usdc): swap ETH→USDC (Uniswap v3 0.05 %) → approve → vault.deposit. Reserva de gas ≥ STRATEGY_RESERVE_ETH.
//   Salida  (STRATEGY=revert-usdc-exit): vault.redeem(todas las participaciones) → swap USDC→WETH → unwrap a ETH.
// Cada transacción se simula con eth_call (y estimateGas) contra el estado actual antes de enviarse; si la simulación falla, se detiene.
import { ethers } from "ethers";
import { enterClm, exitClm, netOf } from "./beefyclm.mjs";
import * as core from "../src/core.js";

export const BASE = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap SwapRouter02 (Base)
  VAULT: "0x36AEAe0E411a1E28372e0d66f02E57744EbE7599", // Revert Lend V3Vault (Uniswap v3), activo USDC
  FEE: 500,
};
const I = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function asset() view returns (address)",
  "function deposit(uint256 assets,address receiver) returns (uint256)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
]);

/** Cantidad de ETH a usar: saldo − reserva − colchón de gas de las 3 tx (nunca negativo). */
export function spendable(balanceWei, reserveWei, gasBufferWei) {
  const x = balanceWei - reserveWei - gasBufferWei;
  return x > 0n ? x : 0n;
}
/** Salida mínima aceptada: lo que devuelve la simulación menos el deslizamiento, y no peor que el precio de referencia −2 %. */
export function minOut(simOut, slipBps, refOut) {
  const m = simOut * BigInt(10_000 - slipBps) / 10_000n;
  if (refOut && simOut * 100n < refOut * 98n) throw new Error(`cotización ${simOut} más de 2 % peor que la referencia ${refOut}`);
  return m;
}

export class Strategy {
  constructor({ executor, provider, store, diag }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag;
    this.kind = process.env.STRATEGY || ""; this.label = process.env.STRATEGY_RUN || (this.kind === "beefy-clm-dca" ? "dca" : "");
    // depósito periódico (STRATEGY=beefy-clm-dca): DCA_USD cada DCA_EVERY_H horas en STRATEGY_VAULT_ID
    this.dcaUsdCfg = Number(process.env.DCA_USD ?? 10); this.dcaEveryMs = Number(process.env.DCA_EVERY_H ?? 24) * 3600_000;
    this.reserve = ethers.parseEther(process.env.STRATEGY_RESERVE_ETH || "0.002");
    this.slipBps = Number(process.env.STRATEGY_SLIP_BPS ?? 50);
    this.busy = false; this.done = false;
    this.net = netOf(core.CHAIN?.key);
  }
  get wanted() { return !!this.kind && !!this.label && this.x?.wallet && this.x.mode === "live"; }

  async init() { this.s = (await this.store.get("strategy")) ?? { runs: {} }; }
  async save() { await this.store.set("strategy", this.s); }
  get me() { return this.x.wallet.address; }

  async sim(tx) {
    const t = { from: this.me, ...tx };
    await this.provider.call(t); // revierte → lanza
    const g = await this.provider.estimateGas(t);
    return g * 13n / 10n;
  }
  async send(step, tx) {
    const gasLimit = await this.sim(tx);
    const eth = await this.provider.getBalance(this.me);
    const fee = await this.provider.getFeeData();
    const cost = gasLimit * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
    if (eth - (tx.value ?? 0n) - cost < this.reserve) throw new Error(`${step}: dejaría menos de la reserva de gas`);
    const r = await this.x.withSender((w) => w.sendTransaction({ ...tx, gasLimit }));
    await this.diag(`estrategia ${this.kind}: ${step} enviada ${r.hash}`);
    const rc = await this.provider.waitForTransaction(r.hash, 1, 180_000);
    if (!rc || rc.status !== 1) throw new Error(`${step}: ${r.hash} ${rc ? "revertida" : "sin recibo"}`);
    this.run.txs.push({ step, hash: r.hash, block: rc.blockNumber, gasUsed: String(rc.gasUsed) }); await this.save();
    return rc;
  }

  /** Depósito periódico: una corrida "<etiqueta>#n" por periodo; sin fondos → reintenta cada hora; error → espera al siguiente periodo. */
  async dca(ctx) {
    const now = Date.now();
    const d = ((this.s.dca ??= {})[this.label] ??= { n: 0, lastAt: 0, totalUsd: 0, deposits: [], vaultId: process.env.STRATEGY_VAULT_ID || null });
    if (this.retryAt && now < this.retryAt) return;
    // barrido inmediato de sobrantes (DCA_SWEEP=<etiqueta>): deposita el X de la wallet y el estable que sobró en depósitos anteriores
    const sweepTag = process.env.DCA_SWEEP;
    if (sweepTag && d.sweptTag !== sweepTag) {
      const sl = `${this.label}-sweep-${sweepTag}`;
      const leftStable = Object.entries(this.s.runs).filter(([k, r]) => k.startsWith(`${this.label}#`) && r.status === "hecho" && !r.swept)
        .reduce((a, [, r]) => a + (r.leftover ? r.leftover.stable : (r.used && r.usdcForClm ? Number(BigInt(r.usdcForClm) - BigInt(r.usdcIs0 ? r.used[0] : r.used[1])) / 10 ** this.net.stableDec : 0)), 0);
      this.run = this.s.runs[sl] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", sweep: true };
      this.dcaUsd = null; this.sweepStable = Math.max(0, leftStable);
      try {
        await enterClm(this, ctx);
        this.run.status = "hecho"; d.sweptTag = sweepTag;
        for (const [k, r] of Object.entries(this.s.runs)) if (k.startsWith(`${this.label}#`)) r.swept = true;
        await this.diag(`estrategia beefy-clm-dca: barrido ${sweepTag} hecho · sobrantes depositados en ${this.run.vaultId}`);
      } catch (e) {
        const msg = (e.shortMessage || e.message || String(e)).slice(0, 300);
        if (e.retry) { this.retryAt = now + 60_000; } else { d.sweptTag = sweepTag; this.run.status = "error"; this.run.error = msg; await this.diag(`estrategia beefy-clm-dca: barrido falló · ${msg}`); }
      } finally { this.sweepStable = undefined; }
      return;
    }
    const label = `${this.label}#${d.n + 1}`;
    if (!this.s.runs[label] && now - d.lastAt < this.dcaEveryMs) return;
    this.run = this.s.runs[label] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", usd: this.dcaUsdCfg };
    this.dcaUsd = this.dcaUsdCfg;
    try {
      await enterClm(this, ctx);
      this.run.status = "hecho"; this.run.endedAt = Date.now();
      d.n++; d.lastAt = now; d.totalUsd += this.dcaUsdCfg; d.deposits.push({ at: new Date(now).toISOString(), usd: this.dcaUsdCfg, txs: this.run.txs.map((t) => t.hash) }); if (d.deposits.length > 60) d.deposits.shift();
      d.nextAt = new Date(now + this.dcaEveryMs).toISOString(); this.retryAt = 0;
      await this.diag(`estrategia beefy-clm-dca: depósito ${d.n} de $${this.dcaUsdCfg} en ${this.run.vaultId} · acumulado $${d.totalUsd} · siguiente ${d.nextAt}`);
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 300);
      if (e.retry && (this.run.retries = (this.run.retries ?? 0) + 1) <= 60) { this.retryAt = now + 60_000; this.run.lastRetry = msg; if (this.run.retries === 1 || this.run.retries % 10 === 0) await this.diag(`estrategia beefy-clm-dca: reintento ${this.run.retries} en 1 min · ${msg}`); }
      else if (e.noFunds) { this.retryAt = now + 3600_000; if (d.lastNoFunds !== label) { d.lastNoFunds = label; await this.diag(`estrategia beefy-clm-dca: ${msg} · reintento cada hora hasta que haya fondos`); } }
      else { this.run.status = "error"; this.run.error = msg; d.lastAt = now; d.n++; d.errors = (d.errors ?? 0) + 1; this.retryAt = 0; await this.diag(`estrategia beefy-clm-dca: depósito ${label} falló · ${msg} · se intenta de nuevo en el siguiente periodo`); }
    }
  }

  async onBlock(ctx) {
    if (this.kind === "beefy-clm-dca") {
      if (this.busy || !this.wanted) return;
      this.busy = true;
      try { await this.dca(ctx); } finally { this.busy = false; await this.save().catch(() => {}); }
      return;
    }
    if (this.done || this.busy || !this.wanted) return;
    this.busy = true;
    try {
      this.run = this.s.runs[this.label] ??= { kind: this.kind, startedAt: Date.now(), txs: [], status: "pendiente" };
      if (this.run.status === "hecho" || this.run.status === "error") { this.done = true; return; }
      if (this.retryAt && Date.now() < this.retryAt) return;
      if (this.kind === "revert-usdc") await this.enter(ctx);
      else if (this.kind === "revert-usdc-exit") await this.exit(ctx);
      else if (this.kind === "beefy-clm") await enterClm(this, ctx);
      else if (this.kind === "beefy-clm-exit") await exitClm(this, ctx);
      else throw new Error(`STRATEGY desconocida: ${this.kind}`);
      this.run.status = "hecho"; this.run.endedAt = Date.now(); this.done = true;
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 300);
      if (e.retry && (this.run.retries = (this.run.retries ?? 0) + 1) <= 60) {
        // p. ej. el CLM no está "calm": se reintenta en 1 min sin repetir los pasos ya hechos
        this.retryAt = Date.now() + 60_000; this.run.lastRetry = msg;
        if (this.run.retries === 1 || this.run.retries % 10 === 0) await this.diag(`estrategia ${this.kind}: reintento ${this.run.retries} en 1 min · ${msg}`);
      } else {
        this.run.status = "error"; this.run.error = msg; this.done = true;
        await this.diag(`estrategia ${this.kind}: detenida · ${msg}`);
      }
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }

  async enter(ctx) {
    const usdc = new ethers.Contract(BASE.USDC, I, this.provider), vault = new ethers.Contract(BASE.VAULT, I, this.provider);
    if ((await vault.asset()).toLowerCase() !== BASE.USDC.toLowerCase()) throw new Error("el vault no es de USDC");
    // 1) swap ETH→USDC (solo si este run aún no lo hizo)
    if (this.run.usdcIn === undefined) {
      const bal = await this.provider.getBalance(this.me);
      const amountIn = spendable(bal, this.reserve, ethers.parseEther("0.0002"));
      if (amountIn < ethers.parseEther("0.001")) throw new Error(`saldo insuficiente (${ethers.formatEther(bal)} ETH)`);
      const p = { tokenIn: BASE.WETH, tokenOut: BASE.USDC, fee: BASE.FEE, recipient: this.me, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
      const simOut = I.decodeFunctionResult("exactInputSingle", await this.provider.call({ from: this.me, to: BASE.ROUTER, value: amountIn, data: I.encodeFunctionData("exactInputSingle", [p]) }))[0];
      const ref = ctx?.ethUsd ? BigInt(Math.floor(Number(ethers.formatEther(amountIn)) * ctx.ethUsd * 1e6)) : 0n;
      p.amountOutMinimum = minOut(simOut, this.slipBps, ref);
      const before = await usdc.balanceOf(this.me);
      await this.diag(`estrategia revert-usdc: ${ethers.formatEther(amountIn)} ETH de ${ethers.formatEther(bal)} (reserva ${ethers.formatEther(this.reserve)}) → ~${ethers.formatUnits(simOut, 6)} USDC (ETH $${ctx?.ethUsd?.toFixed?.(2) ?? "?"})`);
      await this.send("swap ETH→USDC", { to: BASE.ROUTER, value: amountIn, data: I.encodeFunctionData("exactInputSingle", [p]) });
      const got = (await usdc.balanceOf(this.me)) - before;
      this.run.ethIn = ethers.formatEther(amountIn); this.run.usdcIn = String(got); await this.save();
    }
    const amt = BigInt(this.run.usdcIn);
    if (amt <= 0n) throw new Error("el swap no dejó USDC");
    const maxDep = await vault.maxDeposit(this.me).catch(() => null);
    if (maxDep !== null && maxDep < amt) throw new Error(`el vault solo admite ${ethers.formatUnits(maxDep, 6)} USDC ahora`);
    // 2) approve exacto 3) deposit
    if ((await usdc.allowance(this.me, BASE.VAULT)) < amt) await this.send("approve USDC", { to: BASE.USDC, data: I.encodeFunctionData("approve", [BASE.VAULT, amt]) });
    const sharesBefore = await vault.balanceOf(this.me);
    await this.send("deposit Revert Lend", { to: BASE.VAULT, data: I.encodeFunctionData("deposit", [amt, this.me]) });
    const shares = (await vault.balanceOf(this.me)) - sharesBefore;
    this.run.shares = String(shares);
    await this.diag(`estrategia revert-usdc: activa · ${ethers.formatUnits(amt, 6)} USDC depositados en Revert Lend (vault ${BASE.VAULT}) · participaciones ${shares} · txs ${this.run.txs.map((t) => t.hash).join(", ")}`);
  }

  async exit(ctx) {
    const usdc = new ethers.Contract(BASE.USDC, I, this.provider), vault = new ethers.Contract(BASE.VAULT, I, this.provider);
    const shares = await vault.balanceOf(this.me);
    if (shares > 0n) {
      const before = await usdc.balanceOf(this.me);
      await this.send("redeem Revert Lend", { to: BASE.VAULT, data: I.encodeFunctionData("redeem", [shares, this.me, this.me]) });
      this.run.usdcOut = String((await usdc.balanceOf(this.me)) - before); await this.save();
    }
    const amt = this.run.usdcOut ? BigInt(this.run.usdcOut) : 0n;
    if (amt <= 0n) throw new Error("no hay USDC del vault que vender");
    if ((await usdc.allowance(this.me, BASE.ROUTER)) < amt) await this.send("approve USDC→router", { to: BASE.USDC, data: I.encodeFunctionData("approve", [BASE.ROUTER, amt]) });
    // swap a WETH con el router como destinatario y unwrap a ETH en la misma tx (multicall)
    const p = { tokenIn: BASE.USDC, tokenOut: BASE.WETH, fee: BASE.FEE, recipient: BASE.ROUTER, amountIn: amt, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
    const simOut = I.decodeFunctionResult("exactInputSingle", await this.provider.call({ from: this.me, to: BASE.ROUTER, data: I.encodeFunctionData("exactInputSingle", [p]) }))[0];
    const ref = ctx?.ethUsd ? BigInt(Math.floor(Number(amt) / 1e6 / ctx.ethUsd * 1e18)) : 0n;
    p.amountOutMinimum = minOut(simOut, this.slipBps, ref);
    const data = I.encodeFunctionData("multicall", [[I.encodeFunctionData("exactInputSingle", [p]), I.encodeFunctionData("unwrapWETH9", [p.amountOutMinimum, this.me])]]);
    await this.send("swap USDC→ETH", { to: BASE.ROUTER, data });
    await this.diag(`estrategia revert-usdc-exit: cerrada · ${ethers.formatUnits(amt, 6)} USDC → ETH · txs ${this.run.txs.map((t) => t.hash).join(", ")}`);
  }
}
