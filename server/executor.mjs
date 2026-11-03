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
const ART_ID = (ART.version ?? "v1") + "-" + ethers.keccak256(ART.bytecode).slice(2, 10); // cambia cuando cambia el contrato
const MAX_RECENT = 80;
// RPCs para ENVIAR transacciones (eth_sendRawTransaction). Algunos nodos públicos de solo lectura devuelven 403 al enviar.
const sendRpcs = () => (process.env.SEND_RPC ? [process.env.SEND_RPC] : []).concat(["https://mainnet.base.org", "https://base.llamarpc.com", "https://1rpc.io/base", "https://base-rpc.publicnode.com"]);

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
    this.sendIdx = 0; this.sendRpcs = sendRpcs();
  }

  /** Wallet conectada al RPC de envío actual; `rotateSender` pasa al siguiente si uno rechaza el envío. */
  sender() {
    const url = this.sendRpcs[this.sendIdx % this.sendRpcs.length];
    if (!this.sendProv || this.sendUrl !== url) { this.sendUrl = url; this.sendProv = new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true, batchMaxCount: 1 }); }
    return this.wallet.connect(this.sendProv);
  }
  rotateSender() { this.sendIdx++; return this.sender(); }

  /** Ejecuta `fn(walletConectada)` probando cada RPC de envío si el anterior rechaza (403/405/-32601…). */
  async withSender(fn) {
    let lastErr;
    for (let i = 0; i < this.sendRpcs.length; i++) {
      const w = this.sender();
      try { return await fn(w); } catch (e) {
        lastErr = e;
        const m = `${e.shortMessage || e.message}`;
        if (!/403|405|Forbidden|Method not|not supported|unsupported|-32601|429/i.test(m)) throw e;
        await this.diag(`fase 1: el RPC ${new URL(this.sendUrl).host} rechazó el envío (${m.slice(0, 60)}); probando otro`);
        this.rotateSender();
      }
    }
    throw lastErr;
  }

  async init() {
    this.p1 = (await this.store.get("phase1")) ?? emptyPhase1();
    if (!this.p1.executor && process.env.EXECUTOR_ADDRESS) this.p1.executor = process.env.EXECUTOR_ADDRESS; // respaldo si se perdiera el volumen
    this.p1.mode = this.wallet ? this.mode : "sin llave";
    this.p1.wallet = this.wallet?.address ?? null;
    if (!this.wallet) { await this.diag("fase 1: sin PRIVATE_KEY; solo observación"); await this.save(); return; }
    this.p1.balanceEth = Number(ethers.formatEther(await this.provider.getBalance(this.wallet.address)));
    if (!this.p1.executor && this.autoDeploy) await this.deploy();
    if (this.p1.executor) {
      const code = await this.provider.getCode(this.p1.executor);
      if (code === "0x") { await this.diag(`fase 1: no hay contrato en ${this.p1.executor}; se redespliega`); this.p1.executor = null; if (this.autoDeploy) await this.deploy(); }
      else if (this.p1.artifact !== ART_ID) {
        await this.diag(`fase 1: el contrato en ${this.p1.executor} es de una versión anterior (${this.p1.artifact ?? "sin versión"} ≠ ${ART_ID})${this.autoDeploy ? "; se despliega la nueva" : "; pon AUTO_DEPLOY=1 para desplegar la nueva"}`);
        if (this.autoDeploy) { this.p1.previousExecutor = this.p1.executor; this.p1.executor = null; await this.deploy(); }
      }
    }
    await this.diag(`fase 1: modo ${this.p1.mode} · wallet ${this.wallet.address} · ${this.p1.balanceEth.toFixed(5)} ETH · contrato ${this.p1.executor ?? "no desplegado"}`);
    await this.save();
  }

  async deploy() {
    try {
      await this.diag("fase 1: desplegando ArbExecutor…");
      const deployData = ART.bytecode + this.iface.encodeDeploy([this.wallet.address]).slice(2);
      const gasLimit = await this.provider.estimateGas({ from: this.wallet.address, data: deployData });
      const c = await this.withSender(async (w) => {
        const f = new ethers.ContractFactory(ART.abi, ART.bytecode, w);
        return f.deploy(this.wallet.address, { gasLimit: (gasLimit * 12n) / 10n });
      });
      const rc = await c.deploymentTransaction().wait();
      this.p1.executor = await c.getAddress(); this.p1.artifact = ART_ID;
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
    if (r.route.some((p) => p.kind === "v4" && !p.tickSpacing)) return null; // v4 sin tickSpacing conocido (universo viejo): se reconstruye solo
    let tokenIn = r.startTok.address;
    const hops = [];
    for (const p of r.route) {
      const tokenOut = core.other(p, tokenIn).address;
      if (p.kind === "v4") hops.push([2, p.manager, tokenIn, tokenOut, 0, Number(p.feePips), p.tickSpacing]);
      else hops.push([p.kind === "v3" ? 1 : 0, p.address, tokenIn, tokenOut, p.kind === "v3" ? 0 : Math.min(65535, Math.round(p.feeBps)), 0, 0]);
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
    if (!this.wallet) return results.some((r) => r.profitable) ? "Fase 1 sin llave: solo observación" : null;
    if (!this.p1.executor) return results.some((r) => r.profitable) ? "Fase 1: contrato no desplegado" : null;
    if (this.inflight || block <= this.lastSimBlock) return null;
    const cands = results.filter((r) => r.profitable && r.netUsd >= this.limits.minNetUsd && !r.suspicious).slice(0, 3);
    if (!cands.length) return results.some((r) => r.profitable) ? `Oportunidad por debajo del mínimo de ${this.limits.minNetUsd} USD; no se simula` : null;
    this.inflight = true; this.lastSimBlock = block;
    let text = null;
    try {
      for (const r of cands) {
        const plan = this.buildPlan(r, lenders, ethUsd);
        if (!plan) { text = `${label(r)}: ruta v4 sin tickSpacing en el universo guardado; se reintenta cuando se reconstruya`; continue; }
        const rec = await this.simulate(plan, block, ts, gas, ethUsd);
        if (rec.ok) text = `Simulado on-chain (eth_call contra ${this.p1.executor.slice(0, 8)}…): éxito · beneficio ${rec.profitUsd.toFixed(4)} USD − gas ${rec.gasUsd.toFixed(4)} = neto ${rec.netUsd.toFixed(4)} USD (modelo: ${rec.modelNetUsd.toFixed(4)})`;
        else text = `Simulado on-chain: revertiría (${rec.reason})`;
        if (rec.ok && this.mode === "live" && !this.p1.paused) { await this.send(plan, rec, gas, ethUsd); text += ` · envío: ${rec.sent}`; }
        if (rec.ok) break; // una por bloque
      }
      await this.save();
    } catch (e) {
      this.p1.lastError = `bloque ${block}: ${e.shortMessage || e.message}`;
      text = `Error en Fase 1: ${this.p1.lastError}`;
    } finally { this.inflight = false; }
    return text;
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
      await this.diag(`fase 1: revertiría (${rec.reason}) · ${rec.route} · préstamo $${rec.amountUsd.toFixed(0)} · pools ${r.route.map((p) => `${p.dex}:${p.address.slice(0, 10)}${p.kind === "v3" ? ` √P=${p.sqrtPriceX96}` : ""}`).join(" → ")}`);
      if (Date.now() - (this.lastProbe ?? 0) > 60_000) { this.lastProbe = Date.now(); await this.probe(plan).catch((e) => this.diag(`fase 1: sonda falló: ${e.shortMessage || e.message}`)); }
    }
    this.p1.simulated++;
    this.p1.recent.unshift(rec); if (this.p1.recent.length > MAX_RECENT) this.p1.recent.length = MAX_RECENT;
    return rec;
  }

  /** Diagnóstico: por cada salto v3 del plan, lee token0/token1/slot0 del pool y prueba el swap directo desde el contrato
   *  (eth_call). Si el pool responde UnexpectedCaller, la validación del límite de precio (SPL) pasó. */
  async probe(plan) {
    const v3 = new ethers.Interface([
      "function token0() view returns (address)", "function token1() view returns (address)",
      "function slot0() view returns (uint160 sqrtPriceX96,int24 tick)",
      "function swap(address recipient,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,bytes data) returns (int256,int256)",
    ]);
    const MINP1 = 4295128740n, MAXM1 = 1461446703485210103287273642190157433829878702058n;
    let amount = plan.amount;
    for (const h of plan.hops) {
      const [kind, pool, tokenIn, tokenOut] = h;
      if (kind !== 1) { amount = amount / 2n; continue; }
      const c = new ethers.Contract(pool, v3, this.provider);
      const [t0, t1, s0] = await Promise.all([c.token0().catch(() => "?"), c.token1().catch(() => "?"), c.slot0().catch(() => null)]);
      const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
      const data = v3.encodeFunctionData("swap", [this.p1.executor, zeroForOne, amount, zeroForOne ? MINP1 : MAXM1, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [tokenIn])]);
      let res;
      try { await this.provider.call({ to: pool, from: this.p1.executor, data }); res = "ok (sin revert)"; } catch (e) { res = decodeRevert(this.iface, e); }
      await this.diag(`fase 1 sonda v3 ${pool.slice(0, 10)}: token0 ${String(t0).slice(0, 8)} token1 ${String(t1).slice(0, 8)} √P ${s0 ? s0[0] : "?"} · in ${tokenIn.slice(0, 8)} zeroForOne=${zeroForOne} amount ${amount} → ${res}`);
      amount = amount / 2n;
    }
  }

  async send(plan, rec, gas, ethUsd) {
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
    if (this.sentTimes.length >= this.limits.maxTxPerHour) { rec.sent = "omitida: tope por hora"; return; }
    if (rec.gasUsd > this.limits.maxGasUsd) { rec.sent = `omitida: gas ${rec.gasUsd.toFixed(3)} > tope`; return; }
    if (rec.netUsd <= 0) { rec.sent = "omitida: neto simulado ≤ 0"; return; }
    try {
      const data = this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
      const tx = await this.withSender((w) => w.sendTransaction({ to: this.p1.executor, data, gasLimit: BigInt(Math.floor(rec.gasEst * 1.25)), maxFeePerGas: (gas.baseFee + gas.priority) * 2n, maxPriorityFeePerGas: gas.priority }));
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
