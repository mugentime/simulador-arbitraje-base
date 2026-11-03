// Fase 1: ejecución del protocolo con el contrato ArbExecutor desplegado en Base.
//
// Modos (variable EXECUTE_MODE):
//   simulate (por defecto): por cada oportunidad con EV > 0 arma el Plan real y lo simula con eth_call
//                           desde la wallet contra el contrato desplegado, en el bloque actual. Registra si
//                           habría tenido éxito, el beneficio que devolvería y el gas. NO envía nada.
//   live:                   además envía la transacción, con límites (gas máximo, envíos por hora,
//                           pausa tras reverts seguidos).
//
// La llave privada SOLO se lee de la variable de entorno PRIVATE_KEY (Railway > Variables). Nunca se
// registra, nunca se expone en la API. El contrato se despliega una sola vez si AUTO_DEPLOY=1 y no hay
// dirección guardada; luego se reutiliza.

import fs from "node:fs";
import { ethers } from "ethers";
import * as core from "../src/core.js";

const ART = JSON.parse(fs.readFileSync(new URL("./artifacts/ArbExecutor.json", import.meta.url)));
const SOURCE = { "Morpho Blue": 0, "Balancer v3": 1, "Aave v3": 2 };
const MAX_RECENT = 80;

export function emptyPhase1() {
  return {
    version: 1, mode: null, wallet: null, executor: null, balanceEth: null, deployedAt: null, deployTx: null,
    simulated: 0, wouldSucceed: 0, wouldRevert: 0, byReason: {}, projectedNetUsd: 0, gasUsdSimulated: 0,
    sent: 0, confirmed: 0, reverted: 0, realizedUsd: 0, gasPaidUsd: 0, paused: false, pausedReason: null,
    recent: [], lastError: null, updatedAt: null,
  };
}

export class Executor {
  constructor({ provider, store, diag, mode = "simulate", autoDeploy = false }) {
    this.provider = provider; this.store = store; this.diag = diag; this.mode = mode; this.autoDeploy = autoDeploy;
    this.iface = new ethers.Interface(ART.abi);
    this.wallet = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY.trim(), provider) : null;
    this.limits = {
      maxGasUsd: Number(process.env.MAX_GAS_USD ?? 0.25),
      maxTxPerHour: Number(process.env.MAX_TX_PER_HOUR ?? 20),
      pauseAfterReverts: Number(process.env.PAUSE_AFTER_REVERTS ?? 3),
      minNetUsd: Number(process.env.MIN_NET_USD ?? 0.05),
    };
    this.sentTimes = []; this.consecutiveReverts = 0; this.inflight = false; this.lastSimBlock = 0;
  }

  async init() {
    this.p1 = (await this.store.get("phase1")) ?? emptyPhase1();
    this.p1.mode = this.wallet ? this.mode : "sin llave";
    this.p1.wallet = this.wallet?.address ?? null;
    if (!this.wallet) { await this.diag("fase 1: sin PRIVATE_KEY; solo observación"); await this.save(); return; }
    this.p1.balanceEth = Number(ethers.formatEther(await this.provider.getBalance(this.wallet.address)));
    if (!this.p1.executor && this.autoDeploy) await this.deploy();
    if (this.p1.executor) {
      const code = await this.provider.getCode(this.p1.executor);
      if (code === "0x") { await this.diag(`fase 1: no hay contrato en ${this.p1.executor}; se redespliega`); this.p1.executor = null; if (this.autoDeploy) await this.deploy(); }
    }
    await this.diag(`fase 1: modo ${this.p1.mode} · wallet ${this.wallet.address} · ${this.p1.balanceEth.toFixed(5)} ETH · contrato ${this.p1.executor ?? "no desplegado"}`);
    await this.save();
  }

  async deploy() {
    try {
      await this.diag("fase 1: desplegando ArbExecutor…");
      const f = new ethers.ContractFactory(ART.abi, ART.bytecode, this.wallet);
      const c = await f.deploy(this.wallet.address);
      const rc = await c.deploymentTransaction().wait();
      this.p1.executor = await c.getAddress();
      this.p1.deployTx = rc.hash; this.p1.deployedAt = Date.now();
      this.p1.gasPaidUsd += 0; // se contabiliza en ETH abajo
      await this.diag(`fase 1: ArbExecutor desplegado en ${this.p1.executor} (tx ${rc.hash}, gas ${rc.gasUsed})`);
    } catch (e) {
      this.p1.lastError = `deploy: ${e.shortMessage || e.message}`;
      await this.diag(`fase 1: falló el despliegue: ${this.p1.lastError}`);
    }
  }

  async save() { this.p1.updatedAt = Date.now(); await this.store.set("phase1", this.p1); }

  buildPlan(r, lenders, ethUsd) {
    const lender = lenders.find((l) => l.name === r.lender);
    if (!lender || !(r.lender in SOURCE)) return null;
    if (r.route.some((p) => p.kind === "v4")) return null; // el contrato aún no ejecuta hops v4
    let tokenIn = r.startTok.address;
    const hops = [];
    for (const p of r.route) {
      const tokenOut = core.other(p, tokenIn).address;
      hops.push([p.kind === "v3" ? 1 : 0, p.address, tokenIn, tokenOut, p.kind === "v3" ? 0 : Math.min(65535, Math.round(p.feeBps))]);
      tokenIn = tokenOut;
    }
    if (tokenIn !== r.startTok.address) return null;
    // beneficio mínimo on-chain = gas estimado del modelo, en unidades del token prestado
    const gasInToken = r.startTok.sym === "USDC" ? r.gasUsd : r.startTok.sym === "WETH" ? r.gasUsd / ethUsd : 0;
    const minProfit = BigInt(Math.floor(gasInToken * 10 ** r.startTok.decimals));
    return { source: SOURCE[r.lender], lender: lender.address, token: r.startTok.address, amount: r.amountIn, minProfit, hops, meta: r };
  }

  /** Llamado por el worker en cada bloque con los resultados ya evaluados. */
  async onBlock({ block, ts, results, lenders, gas, ethUsd }) {
    if (!this.wallet || !this.p1.executor || this.inflight || block <= this.lastSimBlock) return;
    const cands = results.filter((r) => r.profitable && r.netUsd >= this.limits.minNetUsd && !r.suspicious).slice(0, 3);
    if (!cands.length) return;
    this.inflight = true; this.lastSimBlock = block;
    try {
      for (const r of cands) {
        const plan = this.buildPlan(r, lenders, ethUsd);
        if (!plan) continue;
        const rec = await this.simulate(plan, block, ts, gas, ethUsd);
        if (rec.ok && this.mode === "live" && !this.p1.paused) await this.send(plan, rec, gas, ethUsd);
        if (rec.ok) break; // una por bloque
      }
      await this.save();
    } catch (e) {
      this.p1.lastError = `bloque ${block}: ${e.shortMessage || e.message}`;
    } finally { this.inflight = false; }
  }

  async simulate(plan, block, ts, gas, ethUsd) {
    const data = this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
    const tx = { to: this.p1.executor, from: this.wallet.address, data };
    const r = plan.meta;
    const rec = { block, ts, route: label(r), start: r.start, lender: r.lender, amountUsd: r.amountInUsd, modelNetUsd: r.netUsd, ok: false, reason: null, profitUsd: null, gasUsd: null, netUsd: null, sent: null };
    try {
      const [ret, gasEst] = await Promise.all([this.provider.call(tx), this.provider.estimateGas(tx)]);
      const profit = this.iface.decodeFunctionResult("execute", ret)[0];
      const toUsd = core.tokenToUsd(r.startTok, ethUsd);
      rec.ok = true; rec.profitUsd = toUsd(profit); rec.gasEst = Number(gasEst);
      rec.gasUsd = (Number(gasEst * (gas.baseFee + gas.priority) + gas.l1Fee) / 1e18) * ethUsd;
      rec.netUsd = rec.profitUsd - rec.gasUsd;
      this.p1.wouldSucceed++; this.p1.projectedNetUsd += rec.netUsd; this.p1.gasUsdSimulated += rec.gasUsd;
    } catch (e) {
      rec.reason = decodeRevert(this.iface, e);
      this.p1.wouldRevert++; this.p1.byReason[rec.reason] = (this.p1.byReason[rec.reason] ?? 0) + 1;
    }
    this.p1.simulated++;
    this.p1.recent.unshift(rec); if (this.p1.recent.length > MAX_RECENT) this.p1.recent.length = MAX_RECENT;
    return rec;
  }

  async send(plan, rec, gas, ethUsd) {
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
    if (this.sentTimes.length >= this.limits.maxTxPerHour) { rec.sent = "omitida: tope por hora"; return; }
    if (rec.gasUsd > this.limits.maxGasUsd) { rec.sent = `omitida: gas ${rec.gasUsd.toFixed(3)} > tope`; return; }
    if (rec.netUsd <= 0) { rec.sent = "omitida: neto simulado ≤ 0"; return; }
    try {
      const data = this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
      const tx = await this.wallet.sendTransaction({ to: this.p1.executor, data, gasLimit: BigInt(Math.floor(rec.gasEst * 1.25)), maxFeePerGas: (gas.baseFee + gas.priority) * 2n, maxPriorityFeePerGas: gas.priority });
      this.sentTimes.push(now); this.p1.sent++; rec.sent = tx.hash;
      await this.diag(`fase 1: enviada ${tx.hash} (${rec.route}, neto simulado $${rec.netUsd.toFixed(4)})`);
      const rcpt = await tx.wait(1, 60_000);
      const paid = (Number(rcpt.gasUsed * (rcpt.gasPrice ?? 0n)) / 1e18) * ethUsd;
      this.p1.gasPaidUsd += paid;
      if (rcpt.status === 1) {
        this.p1.confirmed++; this.consecutiveReverts = 0;
        const ev = rcpt.logs.map((l) => { try { return this.iface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Executed");
        const realized = ev ? core.tokenToUsd(plan.meta.startTok, ethUsd)(ev.args.profit) : 0;
        this.p1.realizedUsd += realized - paid; rec.sent = `${tx.hash} · confirmada · +$${(realized - paid).toFixed(4)}`;
      } else {
        this.p1.reverted++; this.consecutiveReverts++; rec.sent = `${tx.hash} · revertida (gas $${paid.toFixed(4)})`;
        if (this.consecutiveReverts >= this.limits.pauseAfterReverts) { this.p1.paused = true; this.p1.pausedReason = `${this.consecutiveReverts} reverts seguidos`; await this.diag(`fase 1: PAUSADA · ${this.p1.pausedReason}`); }
      }
    } catch (e) { rec.sent = `error al enviar: ${e.shortMessage || e.message}`; this.p1.lastError = rec.sent; }
  }

  async refreshBalance() {
    if (this.wallet) { try { this.p1.balanceEth = Number(ethers.formatEther(await this.provider.getBalance(this.wallet.address))); } catch { /* red */ } }
  }
}

function label(r) {
  let t = r.start; const parts = [t];
  for (const p of r.route) { const n = p.token0.sym === t ? p.token1.sym : p.token0.sym; parts.push(`${p.dex} → ${n}`); t = n; }
  return parts.join(" → ");
}

function decodeRevert(iface, e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try { const d = iface.parseError(data); return d ? `${d.name}${d.args.length ? "(" + d.args.map(String).join(",") + ")" : ""}` : data.slice(0, 10); } catch { /* no es nuestro */ }
    if (data.startsWith("0x08c379a0")) { try { return "Error: " + ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]; } catch { /* */ } }
    return "revert " + data.slice(0, 10);
  }
  return (e?.shortMessage || e?.message || "revert").slice(0, 120);
}
