// Estrategia activada por Jose (2026-11-05): depósito simple de USDC en el vault de préstamo de Revert Lend (Uniswap v3, Base),
// financiado con el ETH de la wallet del executor. Sin apalancamiento: no hay precio que liquide.
// Una sola ejecución por etiqueta (STRATEGY_RUN=<etiqueta>); el estado persiste en el volumen.
//   Entrada (STRATEGY=revert-usdc): swap ETH→USDC (Uniswap v3 0.05 %) → approve → vault.deposit. Reserva de gas ≥ STRATEGY_RESERVE_ETH.
//   Salida  (STRATEGY=revert-usdc-exit): vault.redeem(todas las participaciones) → swap USDC→WETH → unwrap a ETH.
// Cada transacción se simula con eth_call (y estimateGas) contra el estado actual antes de enviarse; si la simulación falla, se detiene.
import { ethers } from "ethers";
import { enterClm, exitClm, netOf, harvestProfit, claimForCompound, sellVaultTokens, checkVault, routeSwap, vaultValue, stakeLoose } from "./beefyclm.mjs";
import { scanHighApy, pickTarget, exitCheck, exitThreshold, rotateCheck, RULES, watchSummary, parseRedeployAdd } from "./highapy.mjs";
import { dcaCostReport } from "./dcacost.mjs";
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

/** DCA_EXTRA="SNDKc-USDC@10, AI-USDG" → [{spec, usd}] (puro, probado). */
export function parseDcaExtra(v, defUsd = 10) {
  return String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const m = /^(.+?)(?:@([0-9]*\.?[0-9]+))?$/.exec(x); return { spec: m[1].trim(), usd: m[2] ? Number(m[2]) : defUsd }; }).filter((x) => x.spec && x.usd > 0);
}
/** Id de un vault de Beefy en `chain` por id o por nombre exacto (sin distinguir mayúsculas); prefiere vault/reward pool activo con más TVL. */
export async function resolveVaultSpec(spec, chain) {
  const get = async (path) => { const r = await fetch(`https://api.beefy.finance${path}`, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); };
  const [vs, gs, tvl] = await Promise.all([get("/vaults"), get("/gov-vaults").catch(() => []), get("/tvl").catch(() => ({}))]);
  const tv = {}; for (const b of Object.values(tvl ?? {})) for (const [k, x] of Object.entries(b ?? {})) tv[k] = Number(x) || 0;
  const all = [...vs, ...gs].filter((v) => v.chain === chain && v.status === "active" && v.type !== "cowcentrated");
  const byId = all.find((v) => v.id === spec);
  if (byId) return byId.id;
  // nombre sin distinguir mayúsculas, sin el sufijo "Reward Pool" y sin importar el orden del par (CASHCAT-USDG = USDG-CASHCAT)
  const norm = (x) => String(x ?? "").toLowerCase().replace(/\s*reward pool\s*$/, "").replace(/\s*\(gov\)\s*$/, "").trim().split("-").map((t) => t.trim()).sort().join("-");
  const exact = all.filter((v) => String(v.name).toLowerCase() === spec.toLowerCase()).sort((a, b) => (tv[b.id] ?? 0) - (tv[a.id] ?? 0));
  if (exact.length) return exact[0].id; // el nombre exacto gana (p. ej. "AI-USDG" = el vault, no su Reward Pool)
  const m = all.filter((v) => norm(v.name) === norm(spec)).sort((a, b) => (tv[b.id] ?? 0) - (tv[a.id] ?? 0));
  if (!m.length) throw new Error("sin coincidencias");
  return m[0].id;
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
    // demo dinámico (STRATEGY_DYNAMIC=1, solo con STRATEGY_VAULT_ID=auto): retiene ganancias, rota y reinvierte el capital
    this.dynamic = process.env.STRATEGY_DYNAMIC === "1";
    // modo auto con vault fijo (AUTO_PIN=<id>): deposita ahí mientras no salga; al salir (APY o pérdida) el capital va al mejor
    // elegible (AUTO_REDEPLOY=1, sin rotación ni retención) y el DCA sigue en ese destino. HIGH_APY_EXIT_LOSS_PCT: sale si PnL ≤ −X %.
    this.pin = process.env.AUTO_PIN || null;
    this.redeployOnExit = this.dynamic || process.env.AUTO_REDEPLOY === "1";
    this.lossPct = Number(process.env.HIGH_APY_EXIT_LOSS_PCT ?? 0);
    // "quedarse en el mejor" (AUTO_ROTATE=1): rota solo si otro elegible paga ≥ HIGH_APY_ROTATE_MULT × durante HIGH_APY_ROTATE_HOURS
    this.rotate = this.dynamic || process.env.AUTO_ROTATE === "1";
    this.profitEveryMs = Number(process.env.PROFIT_EVERY_H ?? 6) * 3600_000;
    // composición (STRATEGY_COMPOUND=1): cobra las recompensas del reward pool y las vuelve a depositar cada COMPOUND_EVERY_H
    this.compound = process.env.STRATEGY_COMPOUND === "1";
    this.compoundEveryMs = Number(process.env.COMPOUND_EVERY_H ?? 24) * 3600_000;
    this.compoundMinUsd = Number(process.env.COMPOUND_MIN_USD ?? 0.2);
    // pausa del DCA principal (DCA_MAIN_PAUSE=1): sin depósitos diarios, reinversiones, rotaciones ni destinos nuevos; las
    // posiciones abiertas se quedan (siguen las reglas de salida) y el capital por reinvertir se estaciona en PARK_TOKEN
    // (p. ej. USDG en Robinhood) en lugar de ir a otro vault. Los DCA_EXTRA no se tocan.
    this.pauseMain = process.env.DCA_MAIN_PAUSE === "1";
    this.parkToken = process.env.PARK_TOKEN || null;
  }

  /** DCA principal en pausa: salidas por reglas (cada hora), cobro de ganancias del demo y estacionamiento del sobrante. */
  async pausedMain(ctx, d, now) {
    if (d.pausedSince === undefined) { d.pausedSince = new Date(now).toISOString(); await this.diag(`estrategia ${this.kind}: DCA principal EN PAUSA (DCA_MAIN_PAUSE=1) · sin depósitos ni reinversiones · posiciones abiertas: ${Object.entries(d.holdings ?? {}).filter(([, h]) => !h.closed).map(([id]) => id).join(", ") || "—"} · sobrante → ${this.parkToken ?? "se queda en " + this.net.stableSym}`); }
    if (process.env.STRATEGY_VAULT_ID === "auto" && (!this.autoAt || now - this.autoAt >= 3600_000)) { this.autoAt = now; if (await this.autoTick(ctx, d, now)) return; }
    if (this.dynamic && (!d.profitAt || now - d.profitAt >= this.profitEveryMs)) {
      d.profitAt = now;
      for (const [id, h] of Object.entries(d.holdings ?? {})) if (!h.closed) await this.takeProfit(d, id, h, now).catch(async (e) => this.diag(`estrategia dinámica: cobro de ${id} falló · ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`));
      return;
    }
    let amt = BigInt(d.redeploy ?? "0");
    if (!this.parkToken || amt <= 0n || (d.parkRetryAt && now < d.parkRetryAt)) return;
    // tope = estable libre en la wallet (sin la ganancia retenida): el apartado contable puede superar lo que de verdad hay
    const free = BigInt(await new ethers.Contract(this.net.stable, ["function balanceOf(address) view returns (uint256)"], this.provider).balanceOf(this.me)) - BigInt(d.retained ?? "0");
    if (amt > free) amt = free > 0n ? free : 0n;
    if (amt === 0n) { d.redeploy = "0"; await this.diag(`estrategia ${this.kind}: sobrante apartado sin saldo real en la wallet (${this.net.stableSym} libre 0); se pone en 0`); return; }
    const label = `${this.label}-park-${d.redeployTag ?? now}`;
    this.run = this.s.runs[label] ??= { kind: "park", startedAt: now, txs: [], status: "pendiente" };
    try {
      const got = await routeSwap(this, this.net.stable, this.parkToken, amt, `swap sobrante ${this.net.stableSym}→estacionado`);
      this.run.status = "hecho"; this.run.endedAt = Date.now(); this.run.usdcIn = String(amt); this.run.parkedOut = String(got);
      d.redeploy = "0"; d.parkRetryAt = 0; // lo que no había en la wallet ya se había gastado: se descarta del apartado
      (d.parked ??= []).push({ at: new Date(now).toISOString(), token: this.parkToken, in: String(amt), out: String(got), txs: this.run.txs.map((t) => t.hash) });
      await this.diag(`estrategia ${this.kind}: sobrante estacionado · ${ethers.formatUnits(amt, this.net.stableDec)} ${this.net.stableSym} → ${got} (crudo) de ${this.parkToken}`);
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 200);
      this.run.status = "pendiente"; this.run.error = msg; d.parkRetryAt = now + 3600_000;
      await this.diag(`estrategia ${this.kind}: estacionar sobrante falló · ${msg} · reintento en 1 h (el capital queda apartado en ${this.net.stableSym})`);
    }
  }

  /** Cobra y reinvierte las recompensas de `id` (si valen ≥ COMPOUND_MIN_USD). Pasos reanudables: cobro y depósito por separado. */
  async compoundOnce(d, id, now, ctx) {
    const D = this.net.stableDec;
    const stableUsd = this.net.wrapNative ? (ctx?.ethUsd || 0) : 1;
    const c = (d.compound ??= {});
    if (!c.pending) {
      const label = `${this.label}-compound-${id}-${now}`;
      this.run = this.s.runs[label] = { kind: "beefy-clm-compound", startedAt: now, txs: [], status: "pendiente" };
      this.vaultId = id;
      const min = stableUsd > 0 ? ethers.parseUnits((this.compoundMinUsd / stableUsd).toFixed(Math.min(D, 12)), D) : 10n ** 30n;
      const r = await claimForCompound(this, min);
      if (r.skipped) { delete this.s.runs[label]; c.lastSkip = { at: new Date(now).toISOString(), id, valueUsd: +(Number(ethers.formatUnits(r.value, D)) * stableUsd).toFixed(4) }; return; }
      this.run.status = "hecho"; this.run.claimed = { stable: String(r.stable), x: String(r.x), other: r.other };
      c.pending = { id, stable: String(r.stable), valueUsd: Number(ethers.formatUnits(r.value, D)) * stableUsd, tag: now };
      this.addClaimed(id, c.pending.valueUsd);
    }
    // depósito de lo cobrado (estable + el X que haya en la wallet) en el mismo vault
    const p = c.pending, dl = `${this.label}-compound-dep-${p.tag}`;
    this.run = this.s.runs[dl] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", compound: true };
    this.vaultId = p.id; this.dcaUsd = null; this.sweepStable = Number(ethers.formatUnits(p.stable, D));
    try {
      await enterClm(this, ctx); this.run.status = "hecho"; c.pending = null;
      c.n = (c.n ?? 0) + 1; c.totalUsd = +((c.totalUsd ?? 0) + p.valueUsd).toFixed(4); c.last = { at: new Date(now).toISOString(), id: p.id, usd: +p.valueUsd.toFixed(4) };
      await this.diag(`estrategia ${this.kind}: recompensas reinvertidas en ${p.id} · ≈$${p.valueUsd.toFixed(4)} · composición ${c.n} · acumulado ≈$${c.totalUsd}`);
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 200);
      if (e.retry) { this.retryAt = now + 60_000; this.run.lastRetry = msg; }
      else { this.run.status = "error"; this.run.error = msg; c.pending = null; await this.diag(`estrategia ${this.kind}: reinversión de recompensas falló · ${msg} (lo cobrado queda en la wallet y entra en el siguiente depósito)`); }
    } finally { this.sweepStable = undefined; }
  }

  /** Rendimiento cobrado por vault (USD), para separar comisiones/recompensas de la volatilidad en los reportes. */
  addClaimed(id, usd) { if (!(usd > 0)) return; const c = (this.s.claimed ??= {}); c[id] = +((c[id] ?? 0) + usd).toFixed(6); }
  stableUsd() { return this.net.wrapNative ? (this.lastCtx?.ethUsd || 0) : 1; }

  /** Cobra las recompensas de `id` y las suma a lo retenido (estable que los depósitos no tocan). */
  async takeProfit(d, id, h, now, why = "") {
    const label = `${this.label}-profit-${id}-${now}`;
    this.run = this.s.runs[label] = { kind: "beefy-clm-profit", startedAt: now, txs: [], status: "pendiente" };
    this.vaultId = id;
    const r = await harvestProfit(this);
    this.run.status = "hecho"; this.run.stable = String(r.stable); this.run.other = r.other;
    this.addClaimed(id, Number(ethers.formatUnits(r.stable, this.net.stableDec)) * this.stableUsd());
    if (r.stable > 0n || r.other.length) {
      d.retained = String(BigInt(d.retained ?? "0") + r.stable); h.retained = String(BigInt(h.retained ?? "0") + r.stable);
      await this.diag(`estrategia dinámica: ganancia retenida de ${id}${why ? " (" + why + ")" : ""} · +${ethers.formatUnits(r.stable, this.net.stableDec)} ${this.net.stableSym}${r.other.length ? ` + otros tokens ${r.other.map((o) => `${o.amount} ${o.token}`).join(", ")}` : ""} · total retenido ${ethers.formatUnits(d.retained, this.net.stableDec)} ${this.net.stableSym}`);
    } else delete this.s.runs[label];
  }
  get wanted() { return !!this.kind && this.kind !== "off" && !!this.label && this.x?.wallet && this.x.mode === "live"; }

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

  /** Selección y salidas del modo automático. Devuelve true si ejecutó una salida en esta llamada. */
  async autoTick(ctx, d, now) {
    // AUTO_CLEAR_FAILED=<etiqueta> (una vez): los destinos descartados por un fallo de reinversión vuelven a ser elegibles
    const cf = process.env.AUTO_CLEAR_FAILED;
    if (cf && d.clearFailedTag !== cf) { d.clearFailedTag = cf; const n = Object.keys(d.failed ?? {}).length; d.failed = {}; await this.diag(`estrategia auto: ${n} destino(s) descartado(s) por fallo vuelven a ser elegibles (AUTO_CLEAR_FAILED=${cf})`); }
    const rules = RULES();
    let scan;
    // solo CLM que tengan el estable de la cadena (WETH en Robinhood, USDT en BSC)
    try { scan = await scanHighApy(this.net.beefy, rules, this.net.stable); } catch (e) { await this.diag(`estrategia auto: no se pudo leer Beefy (${e.message})`); return false; }
    this.lastScan = scan; scan.at = new Date(now).toISOString();
    // vaults de los que se salió en las últimas 24 h no vuelven a ser destino (evita salir y re-entrar al mismo)
    // …ni los que fallaron al entrar en las últimas 24 h (p. ej. una fábrica sin router conocido)
    const elig = scan.eligible.filter((x) => { const h = d.holdings?.[x.id]; return !(h?.closed && now - Date.parse(h.closed) < 24 * 3600_000) && !(d.failed?.[x.id] && now - d.failed[x.id] < 24 * 3600_000); });
    // PnL on-chain por vault (línea "dca costo") para la regla de pérdida
    let cost = {};
    if (this.lossPct > 0) { try { await dcaCostReport(this, { ethUsd: ctx?.ethUsd ?? null }); cost = this.lastCost ?? {}; } catch {} }
    // salidas
    for (const [id, h] of Object.entries(d.holdings ?? {})) {
      if (h.closed) continue;
      const nowApy = scan.byId[id]?.apyPct ?? null;
      if (nowApy !== null) h.peakApyPct = Math.max(h.peakApyPct ?? 0, h.entryApyPct ?? 0, nowApy);
      const c = exitCheck({ apyPct: h.entryApyPct, peakApyPct: h.peakApyPct, tvl: h.entryTvl }, scan.byId[id] ?? null, h.badSince ?? null, now, rules);
      const pc = cost[id];
      if (!c.exit && this.lossPct > 0 && pc && pc.invested > 0 && Number.isFinite(pc.pnlPct) && pc.pnlPct <= -this.lossPct) Object.assign(c, { exit: true, why: `pérdida ${pc.pnlPct.toFixed(1)} % sobre lo invertido (≥ ${this.lossPct} %)` });
      h.badSince = c.badSince; h.lastApyPct = scan.byId[id]?.apyPct ?? null; h.lastTvl = scan.byId[id]?.tvl ?? null;
      // demo dinámico: rotación si otro vault elegible paga mucho más durante HIGH_APY_ROTATE_HOURS
      if (!c.exit && this.rotate && !this.pauseMain && id === d.target) {
        const rc = rotateCheck(scan.byId[id] ?? null, elig.filter((x) => x.id !== id)[0] ?? null, h.rotateSince ?? null, now, rules);
        h.rotateSince = rc.since;
        if (rc.rotate) Object.assign(c, { exit: true, why: rc.why });
      }
      if (!c.exit) { if (c.why && h.warned !== c.why) { h.warned = c.why; await this.diag(`estrategia auto: ${id} en vigilancia (${c.why}); sale si dura ${rules.exitHours} h`); } continue; }
      const label = `${this.label}-exit-${id}-${now}`;
      this.run = this.s.runs[label] = { kind: "beefy-clm-exit", startedAt: now, txs: [], status: "pendiente" };
      this.vaultId = id;
      try {
        if (this.dynamic) await this.takeProfit(d, id, h, now, "antes de salir").catch(() => {});
        this.run = this.s.runs[label];
        await exitClm(this, ctx); this.addClaimed(this.vaultId, Number(ethers.formatUnits(BigInt(this.run.claimedStable ?? "0"), this.net.stableDec)) * this.stableUsd()); this.run.status = "hecho"; h.closed = new Date(now).toISOString(); h.exitWhy = c.why; if (d.target === id) d.target = null;
        if (this.redeployOnExit && this.run.usdcOut) { d.redeploy = String(BigInt(d.redeploy ?? "0") + BigInt(this.run.usdcOut)); d.redeployTag = now; d.target = this.pauseMain ? null : pickTarget(elig.filter((x) => x.id !== id), null); }
        await this.diag(`estrategia auto: salida de ${id} (${c.why}) · ${this.run.usdcOut ? ethers.formatUnits(this.run.usdcOut, this.net.stableDec) : "?"} ${this.net.stableSym} de vuelta${this.redeployOnExit ? (this.pauseMain ? ` · DCA en pausa: se estaciona en ${this.parkToken ?? this.net.stableSym}` : ` · se reinvierte en ${d.target ?? "(ninguno elegible; queda en la wallet)"}`) : ""}`);
      }
      catch (e) { this.run.status = "error"; this.run.error = (e.shortMessage || e.message || String(e)).slice(0, 200); await this.diag(`estrategia auto: salida de ${id} falló · ${this.run.error}`); }
      return true;
    }
    // destino (en pausa no se elige ninguno: no entra capital nuevo a ningún vault)
    if (this.pauseMain) { d.target = null; return false; }
    const prev = d.target ?? null;
    const pinOpen = this.pin && !d.holdings?.[this.pin]?.closed;
    d.target = pinOpen ? this.pin : pickTarget(elig, prev);
    d.candidates = elig.slice(0, 5).map((x) => `${x.id} ${x.apyPct.toFixed(0)} % TVL $${Math.round(x.tvl)}`);
    if (d.target !== prev) await this.diag(`estrategia auto: destino ${d.target ?? "ninguno (no hay vaults ≥ " + rules.minApyPct + " % con TVL ≥ $" + rules.minTvl + ")"} · candidatos: ${d.candidates.join(" | ") || "—"}`);
    // capital olvidado: REDEPLOY_ADD="<monto>@<etiqueta>" lo suma a lo pendiente de reinvertir (una vez por etiqueta; tope = estable libre en la wallet)
    const add = this.dynamic ? parseRedeployAdd(process.env.REDEPLOY_ADD) : null;
    if (add && d.redeployAddTag !== add.tag) {
      try {
        let amt = ethers.parseUnits(add.amount, this.net.stableDec);
        const free = BigInt(await new ethers.Contract(this.net.stable, ["function balanceOf(address) view returns (uint256)"], this.provider).balanceOf(this.me)) - BigInt(d.retained ?? "0") - BigInt(d.redeploy ?? "0");
        if (amt > free) amt = free > 0n ? free : 0n;
        d.redeployAddTag = add.tag;
        if (amt > 0n) { d.redeploy = String(BigInt(d.redeploy ?? "0") + amt); d.redeployTag = now; }
        await this.diag(`estrategia dinámica: REDEPLOY_ADD ${add.tag} · +${ethers.formatUnits(amt, this.net.stableDec)} ${this.net.stableSym} pendientes de reinvertir (total ${ethers.formatUnits(d.redeploy ?? "0", this.net.stableDec)})`);
      } catch (e) { await this.diag(`estrategia dinámica: REDEPLOY_ADD falló · ${(e.shortMessage || e.message || String(e)).slice(0, 120)}`); }
    }
    // vigilancia horaria (siempre, aunque nada cambie): destino, posiciones abiertas, capital pendiente y mejores candidatos con su motivo
    const open = Object.entries(d.holdings ?? {}).filter(([, h]) => !h.closed).map(([id, h]) => `${id} APY ${h.lastApyPct?.toFixed(0) ?? "?"} % (máx. ${h.peakApyPct?.toFixed(0) ?? "?"} %, umbral ${exitThreshold({ apyPct: h.entryApyPct, peakApyPct: h.peakApyPct }, rules).toFixed(0)} %)${cost[id] && Number.isFinite(cost[id].pnlPct) ? ` PnL ${cost[id].pnlPct.toFixed(1)} %` : ""}${h.badSince ? ` en vigilancia desde ${new Date(h.badSince).toISOString().slice(11, 16)}Z` : ""}`);
    await this.diag(`estrategia auto: vigilancia · reglas APY ≥ ${rules.minApyPct} % y TVL ≥ $${rules.minTvl}` +
      `${rules.exitFrac > 0 ? ` · salida si APY < ${Math.round(rules.exitFrac * 100)} % del máximo por ${rules.exitHours} h` : rules.exitApyPct > 0 ? ` · salida si APY < ${rules.exitApyPct} % por ${rules.exitHours} h` : ""}${this.rotate ? ` · rota si otro elegible paga ≥ ×${rules.rotateMult} por ${rules.rotateHours} h` : ""}${this.lossPct > 0 ? ` · salida si PnL ≤ −${this.lossPct} %` : ""}${this.pin ? ` · fijo ${this.pin}${pinOpen ? "" : " (ya salió)"}` : ""} · destino ${d.target ?? "ninguno"} · abiertas: ${open.join(", ") || "ninguna"}` +
      `${d.redeploy && BigInt(d.redeploy) > 0n ? ` · por reinvertir ${ethers.formatUnits(d.redeploy, this.net.stableDec)} ${this.net.stableSym}` : ""}` +
      ` · próximo depósito ${d.target ? (d.lastAt ? new Date(d.lastAt + this.dcaEveryMs).toISOString() : "ahora") : "en pausa (sin destino)"} · top: ${watchSummary(scan.byId, rules)}`);
    return false;
  }

  /**
   * Migración única (MIGRATE="<vault origen>><vault destino>@<etiqueta>"): retira toda la posición del origen, la deja en el
   * estable (sin pasar a nativo) y la deposita en el destino. Pasos reanudables; una vez por etiqueta. true si actuó.
   */
  async migrate(ctx) {
    const m = /^\s*([\w.-]+)\s*>\s*([\w.-]+)\s*@\s*([\w.-]+)\s*$/.exec(process.env.MIGRATE ?? "");
    if (!m) return false;
    const [, from, to, tag] = m;
    const st = ((this.s.migrations ??= {})[tag] ??= { from, to, step: "salida" });
    if (st.step === "hecha" || st.step === "error" || (st.retryAt && Date.now() < st.retryAt)) return false;
    const now = Date.now();
    try {
      if (st.step === "salida") {
        this.run = this.s.runs[`${this.label}-migrate-${tag}-exit`] ??= { kind: "beefy-clm-exit", startedAt: now, txs: [], status: "pendiente", migrate: tag };
        this.vaultId = from; this.keepStable = true;
        await exitClm(this, ctx); this.addClaimed(this.vaultId, Number(ethers.formatUnits(BigInt(this.run.claimedStable ?? "0"), this.net.stableDec)) * this.stableUsd());
        this.run.status = "hecho"; st.usdcOut = this.run.usdcOut; st.step = "entrada"; st.retries = 0;
        await this.diag(`estrategia migración ${tag}: salida de ${from} · ${ethers.formatUnits(st.usdcOut ?? "0", this.net.stableDec)} ${this.net.stableSym} en la wallet · sigue la entrada a ${to}`);
        return true;
      }
      this.run = this.s.runs[`${this.label}-migrate-${tag}-enter`] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", migrate: tag };
      this.vaultId = to; this.dcaUsd = null; this.sweepStable = Number(ethers.formatUnits(st.usdcOut ?? "0", this.net.stableDec));
      await enterClm(this, ctx);
      this.run.status = "hecho"; st.step = "hecha"; st.at = new Date(now).toISOString();
      await this.diag(`estrategia migración ${tag}: hecha · ${from} → ${to} · ${ethers.formatUnits(this.run.usdcIn ?? "0", this.net.stableDec)} ${this.net.stableSym} depositados`);
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 240);
      if ((st.retries = (st.retries ?? 0) + 1) <= 30) { st.retryAt = now + (e.retry ? 60_000 : 600_000); if (st.retries === 1 || st.retries % 10 === 0) await this.diag(`estrategia migración ${tag}: ${st.step} reintenta (${st.retries}) · ${msg}`); }
      else { const at = st.step; st.step = "error"; st.error = msg; await this.diag(`estrategia migración ${tag}: se detiene en "${at}" tras 30 intentos · ${msg} (lo retirado queda en la wallet)`); }
    } finally { this.vaultId = null; this.keepStable = false; this.sweepStable = undefined; }
    return true;
  }

  /**
   * Cierres únicos (EXIT_VAULTS="<id>,<id>,…@<etiqueta>"): retira cada vault por completo y deja todo en el estable de la
   * cadena (en la wallet; de ahí lo toma TOPUP_ONCE u otra estrategia). Un vault por llamada; pasos reanudables. true si actuó.
   */
  async exitList(ctx) {
    const m = /^\s*(.+?)\s*@\s*([\w.-]+)\s*$/.exec(process.env.EXIT_VAULTS ?? "");
    if (!m) return false;
    const ids = m[1].split(",").map((x) => x.trim()).filter(Boolean), tag = m[2];
    const st = ((this.s.exits ??= {})[tag] ??= { done: {}, errors: {} });
    const now = Date.now();
    for (const id of ids) {
      if (st.done[id] || st.errors[id]?.final) continue;
      if (st.errors[id] && !st.errors[id].extraFix) st.errors[id] = { n: 0, extraFix: true }; // corridas previas al arreglo de pares sin estable
      const er = st.errors[id];
      if (er?.retryAt && now < er.retryAt) continue;
      this.run = this.s.runs[`${this.label}-exit-${tag}-${id}`] ??= { kind: "beefy-clm-exit", startedAt: now, txs: [], status: "pendiente", exitTag: tag, extra: true };
      this.run.extra = true;
      this.vaultId = id; this.keepStable = true;
      try {
        await exitClm(this, ctx);
        this.addClaimed(id, Number(ethers.formatUnits(BigInt(this.run.claimedStable ?? "0"), this.net.stableDec)) * this.stableUsd());
        this.run.status = "hecho"; this.run.endedAt = Date.now();
        st.done[id] = { at: new Date().toISOString(), out: this.run.usdcOut ?? "0" }; delete st.errors[id];
        await this.diag(`estrategia cierre ${tag}: ${id} cerrado · ${ethers.formatUnits(this.run.usdcOut ?? "0", this.net.stableDec)} ${this.net.stableSym} en la wallet`);
      } catch (e) {
        const msg = (e.shortMessage || e.message || String(e)).slice(0, 240);
        const x = (st.errors[id] ??= { n: 0 }); x.n++; x.msg = msg;
        if (x.n <= 30) { x.retryAt = now + (e.retry ? 60_000 : 600_000); if (x.n === 1 || x.n % 10 === 0) await this.diag(`estrategia cierre ${tag}: ${id} reintenta (${x.n}) · ${msg}`); }
        else { x.final = true; this.run.status = "error"; this.run.error = msg; await this.diag(`estrategia cierre ${tag}: ${id} se detiene tras 30 intentos · ${msg}`); }
      } finally { this.vaultId = null; this.keepStable = false; }
      return true;
    }
    return false;
  }

  /**
   * Depósitos únicos (DEPOSIT_ONCE="<id o nombre>@usd,…" + DEPOSIT_ONCE_TAG=<etiqueta>): un solo depósito por vault y etiqueta,
   * con el mismo flujo que el DCA. Sin fondos → reintenta cada hora (p. ej. mientras llega el puente). true si actuó.
   */
  async depositOnce(ctx) {
    const tag = process.env.DEPOSIT_ONCE_TAG, list = parseDcaExtra(process.env.DEPOSIT_ONCE, this.dcaUsdCfg);
    if (!tag || !list.length) return false;
    const st = ((this.s.once ??= {})[tag] ??= {});
    const now = Date.now();
    for (const e of list) {
      const key = e.spec.replace(/[^\w.-]+/g, "_");
      const d = (st[key] ??= { spec: e.spec, usd: e.usd, status: "pendiente" });
      if (d.fails && !d.extraFix) { d.extraFix = true; d.fails = 0; d.retryAt = 0; } // corridas previas al arreglo de pares sin estable
      if (d.status === "hecho" || d.status === "error") continue;
      if (d.retryAt && now < d.retryAt) continue;
      if (!d.vaultId) {
        try { d.vaultId = await resolveVaultSpec(e.spec, this.net.beefy); await this.diag(`estrategia depósito único ${tag}: "${e.spec}" → ${d.vaultId} · $${e.usd}`); }
        catch (err) { d.retryAt = now + 3600_000; await this.diag(`estrategia depósito único ${tag}: no se encontró "${e.spec}" (${err.message}); reintento en 1 h`); continue; }
      }
      this.run = this.s.runs[`${this.label}-once-${tag}-${key}`] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", usd: e.usd, once: tag, extra: true };
      this.run.extra = true;
      this.vaultId = d.vaultId; this.dcaUsd = e.usd; this.sweepStable = undefined;
      this.protectStable = BigInt(this.s.dca?.[this.label]?.retained ?? "0") + BigInt(this.s.dca?.[this.label]?.redeploy ?? "0");
      try {
        await enterClm(this, ctx);
        this.run.status = "hecho"; this.run.endedAt = Date.now(); d.status = "hecho"; d.at = new Date().toISOString(); d.retryAt = 0;
        await this.diag(`estrategia depósito único ${tag}: $${e.usd} en ${d.vaultId} hecho · txs ${this.run.txs.map((t) => t.hash).join(", ")}`);
      } catch (err) {
        const msg = (err.shortMessage || err.message || String(err)).slice(0, 300);
        // corrida a medias (p. ej. cortada por un reinicio): el siguiente intento empieza de cero con saldos actuales
        if (/STF|exceeds balance/i.test(msg)) { delete this.s.runs[`${this.label}-once-${tag}-${key}`]; if ((d.balResets = (d.balResets ?? 0) + 1) <= 2) { d.retryAt = now + 120_000; d.retries = 0; await this.diag(`estrategia depósito único ${tag}: ${d.vaultId} · corrida reiniciada por saldo (${msg.slice(0, 80)}) · reintento en 2 min`); return true; } }
        if (err.retry && (d.retries = (d.retries ?? 0) + 1) <= 60) { d.retryAt = now + 60_000; if (d.retries === 1 || d.retries % 10 === 0) await this.diag(`estrategia depósito único ${tag}: ${d.vaultId} reintento ${d.retries} en 1 min · ${msg}`); }
        else if (err.noFunds) { d.retryAt = now + 3600_000; if (!d.noFundsLogged) { d.noFundsLogged = true; await this.diag(`estrategia depósito único ${tag}: ${d.vaultId} · ${msg} · reintento cada hora hasta que haya fondos`); } }
        else if ((d.fails = (d.fails ?? 0) + 1) < 3) { d.retryAt = now + 3600_000; d.retries = 0; this.run.error = msg; await this.diag(`estrategia depósito único ${tag}: ${d.vaultId} falló (intento ${d.fails} de 3) · ${msg} · reintento en 1 h`); }
        else { d.status = "error"; d.error = msg; this.run.status = "error"; this.run.error = msg; await this.diag(`estrategia depósito único ${tag}: ${d.vaultId} falló 3 veces, se abandona · ${msg}`); }
      } finally { this.vaultId = null; this.dcaUsd = null; }
      return true;
    }
    return false;
  }

  /**
   * Sniper F1–F3 (doc 22), con SNIPER_TRADE=1 y el radar (this.sniper) en el mismo worker. Una acción por llamada (true si actuó).
   *  F1 semillas: SNIPER_SEED_USD ($5) en hasta SNIPER_SEEDS_MAX (3) candidatos del radar donde aún no hay posición.
   *  F2 disparo: al detectar un éxodo (≤ 2 h), SNIPER_SHOT_USD ($20) en ese vault (hasta SNIPER_SHOTS_MAX abiertos, 2).
   *     Salidas: pérdida ≥ 10 %; rendimiento medido < 0.5 %/día (6 h, desde las 6 h); 7 días. Semillas: pérdida ≥ 10 % o 24 h
   *     fuera de la lista de candidatos. Todo vuelve al estable de la cadena (sin swap a nativo).
   *  F3: cada 5 disparos exitosos (salida > lo invertido) el monto se duplica hasta SNIPER_SHOT_MAX (por defecto = SNIPER_SHOT_USD:
   *     no sube solo; avisa que está listo). Tope de capital abierto: SNIPER_BUDGET_USD ($60).
   */
  /** STAKE_LOOSE="<id>,<id>@<etiqueta>" (una vez por vault y etiqueta): deposita el CLM suelto de la wallet en su vault / reward pool. */
  async stakeLooseOnce() {
    const m = /^\s*(.+?)\s*@\s*([\w.-]+)\s*$/.exec(process.env.STAKE_LOOSE ?? "");
    if (!m) return false;
    const done = ((this.s.stakeLoose ??= {})[m[2]] ??= {});
    for (const id of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (done[id]) continue;
      this.run = { txs: [], extra: true };
      try { const sh = await stakeLoose(this, id); done[id] = { at: new Date().toISOString(), shares: String(sh) }; await this.diag(`estrategia: CLM suelto de ${id} depositado · ${sh} participaciones${this.run.txs.length ? ` · txs ${this.run.txs.map((t) => t.hash).join(", ")}` : " (no había)"}`); }
      catch (e) { done[id] = { error: (e.shortMessage || e.message || String(e)).slice(0, 160) }; await this.diag(`estrategia: CLM suelto de ${id} falló · ${done[id].error}`); }
      finally { this.run = null; }
      return true;
    }
    return false;
  }

  /** Fondos que esta cadena necesita para lo que el sniper quiere hacer (vigente 3 h); lo lee la recarga del worker de Base. */
  fundingNeed() {
    const n = this.s?.snipe?.need;
    return n && Date.now() - n.at < 3 * 3600_000 ? { needUsd: n.usd, why: `${n.kind} en ${n.id}` } : { needUsd: 0 };
  }

  async snipeStep(ctx) {
    const sn = this.sniper;
    if (!sn || process.env.SNIPER_TRADE !== "1") return false;
    const now = Date.now(), H = 3600_000;
    const st = (this.s.snipe ??= { pos: {}, handled: {}, wins: 0, losses: 0, level: 0 });
    const base = Number(process.env.SNIPER_SHOT_USD ?? 20), max = Number(process.env.SNIPER_SHOT_MAX ?? base);
    const shotUsd = Math.min(max, base * 2 ** (st.level ?? 0));
    const seedUsd = Number(process.env.SNIPER_SEED_USD ?? 5), seedsMax = Number(process.env.SNIPER_SEEDS_MAX ?? 3), shotsMax = Number(process.env.SNIPER_SHOTS_MAX ?? 2);
    const budget = Number(process.env.SNIPER_BUDGET_USD ?? 60);
    const D = this.net.stableDec, fmt = (raw) => Number(ethers.formatUnits(BigInt(raw ?? "0"), D));
    const open = () => Object.values(st.pos).filter((p) => p.status === "abierta");

    // a) seguimiento y salidas (cada 15 min por posición)
    for (const [key, p] of Object.entries(st.pos)) {
      if (p.status !== "abierta" || now - (p.checkAt ?? 0) < 15 * 60_000) continue;
      p.checkAt = now;
      // posiciones en Stock Tokens de Robinhood (entraron antes del filtro): sin acciones automáticas; se manejan a mano
      if (sn.info(p.id)?.stock === true) { p.status = "manual"; p.why = "Stock Token: sin acciones automáticas"; await this.diag(`sniper: ${p.kind} en ${p.id} es de un Stock Token · queda fuera del manejo automático (revisar a mano)`); return true; }
      let v; try { v = await vaultValue(this, p.id); } catch { continue; }
      // solo nuestra parte: participaciones de esta posición / participaciones de la wallet en el vault (otras estrategias depositan ahí)
      const frac = p.vshares && v.vshares > 0n ? Math.min(1, Number(BigInt(p.vshares) * 1_000_000n / v.vshares) / 1e6) : 1;
      const val = (fmt(v.value) + fmt(v.pending)) * frac, basis = fmt(p.basis) + Number(p.basisAdd ?? 0);
      if (!(basis > 0)) continue;
      if (v.shares > 0n && v.value === 0n) { if (!p.noValueLogged) { p.noValueLogged = true; await this.diag(`sniper: ${p.id} no se puede valuar (sin ruta de precio); no se toma ninguna salida automática`); } continue; }
      if (val < basis * 0.5 && !p.confirmLow) { p.confirmLow = true; continue; } // una caída > 50 % se confirma en la siguiente revisión antes de salir
      if (val >= basis * 0.5) p.confirmLow = false;
      p.samples = [...(p.samples ?? []), [now, +val.toPrecision(8)]].slice(-400);
      const pnl = val / basis - 1; p.pnlPct = +(pnl * 100).toFixed(2);
      const s6 = p.samples.find(([t]) => t >= now - 6 * H);
      const rate = s6 && now - s6[0] >= 3 * H && s6[1] > 0 ? (val / s6[1] - 1) * (24 * H / (now - s6[0])) : null;
      p.ratePct = rate == null ? null : +(rate * 100).toFixed(2);
      const age = now - Date.parse(p.at);
      if (p.kind === "semilla") { if (sn.isSeedCandidate(p.id)) p.outSince = null; else p.outSince ??= now; }
      let why = null;
      if (pnl <= -0.10) why = `pérdida ${(pnl * 100).toFixed(1)} %`;
      else if (p.kind === "disparo" && age >= 6 * H && rate !== null && rate < 0.005) why = `rendimiento ${(rate * 100).toFixed(2)} %/día < 0.5 %`;
      else if (p.kind === "disparo" && age >= 7 * 24 * H) why = "7 días";
      else if (p.kind === "semilla" && p.outSince && now - p.outSince >= 24 * H) why = "24 h fuera de la lista de candidatos";
      else if (p.kind === "cosecha") {
        if (age >= 6 * H && rate !== null && rate < 0.005) why = `rendimiento ${(rate * 100).toFixed(2)} %/día < 0.5 %`;
        else {
          // rotación: otro vault paga ≥ 2× lo nuestro (medido) durante 12 h
          const mine = sn.harvestCandidates().find((c) => c.id === p.id)?.pct ?? (rate != null ? rate * 100 : 0);
          const best = sn.harvestCandidates().find((c) => !open().some((q) => q.id === c.id));
          if (best && mine > 0 && best.pct >= 2 * mine) p.betterSince ??= now; else p.betterSince = null;
          if (p.betterSince && now - p.betterSince >= 12 * H) why = `rotación: ${best.name} paga ${best.pct} %/día vs ${mine.toFixed(2)} %`;
        }
      }
      if (!why) continue;
      this.run = this.s.runs[`${this.label}-snipe-exit-${key}`] ??= { kind: "beefy-clm-exit", startedAt: now, txs: [], status: "pendiente", extra: true };
      this.run.extra = true; this.vaultId = p.id; this.keepStable = true;
      this.exitShares = p.vshares ? BigInt(p.vshares) : null; // salida parcial: solo las participaciones de esta posición
      try {
        await exitClm(this, ctx);
        const out = fmt(this.run.usdcOut) + fmt(this.run.claimedStable);
        Object.assign(p, { status: "cerrada", closedAt: new Date().toISOString(), why, out, resultPct: +((out / basis - 1) * 100).toFixed(2) });
        this.run.status = "hecho";
        const okExit = out > basis;
        if (p.kind === "disparo") okExit ? st.wins++ : st.losses++;
        if (p.kind === "cosecha") okExit ? (st.hWins = (st.hWins ?? 0) + 1) : (st.hLosses = (st.hLosses ?? 0) + 1);
        await this.diag(`sniper ${p.kind} cerrado · ${p.id} · ${why} · invertido ${basis.toPrecision(5)} → salió ${out.toPrecision(5)} ${this.net.stableSym} (${p.resultPct > 0 ? "+" : ""}${p.resultPct} %) · disparos exitosos ${st.wins}, fallidos ${st.losses}`);
        if (p.kind === "cosecha" && okExit && st.hWins % 5 === 0) {
          const hb = Number(process.env.SNIPER_HARVEST_USD ?? 20), hm = Number(process.env.SNIPER_HARVEST_USD_MAX ?? hb), cur = Math.min(hm, hb * 2 ** (st.hLevel ?? 0));
          if (cur < hm) { st.hLevel = (st.hLevel ?? 0) + 1; await this.diag(`sniper cosecha: ${st.hWins} salidas con ganancia · el monto sube de $${cur} a $${Math.min(hm, hb * 2 ** st.hLevel)}`); }
          else await this.diag(`sniper cosecha: ${st.hWins} salidas con ganancia con $${cur} · listo para subir el monto (SNIPER_HARVEST_USD / SNIPER_HARVEST_USD_MAX)`);
        }
        if (p.kind === "disparo" && okExit && st.wins % 5 === 0) {
          if (shotUsd < max) { st.level = (st.level ?? 0) + 1; await this.diag(`sniper F3: ${st.wins} disparos exitosos · el disparo sube de $${shotUsd} a $${Math.min(max, base * 2 ** st.level)}`); }
          else await this.diag(`sniper F3: ${st.wins} disparos exitosos con $${shotUsd} · listo para subir el monto (SNIPER_SHOT_USD / SNIPER_SHOT_MAX)`);
        }
      } catch (e) {
        const msg = (e.shortMessage || e.message || String(e)).slice(0, 200);
        if (/STF|exceeds balance/i.test(msg)) delete this.s.runs[`${this.label}-snipe-exit-${key}`];
        p.checkAt = now + (e.retry ? 0 : 45 * 60_000); if (p.exitErr !== msg) { p.exitErr = msg; await this.diag(`sniper: salida de ${p.id} falló · ${msg} · reintento`); }
      } finally { this.vaultId = null; this.keepStable = false; this.exitShares = null; }
      return true;
    }

    // reserva para la siguiente entrada del sniper (orden de Jose 2026-11-09: los 20 USDG sueltos van en la siguiente llamada)
    const rm = /^\s*(0x[0-9a-fA-F]{40})\s*:\s*(\d+)\s*:\s*([0-9.]+)\s*@\s*([\w.-]+)\s*$/.exec(process.env.SNIPER_RESERVE ?? "");
    if (rm && !(st.reserveTags ??= {})[rm[4]]) { st.reserveTags[rm[4]] = true; st.reserve = { token: rm[1].toLowerCase(), amount: rm[2], usd: Number(rm[3]) }; await this.diag(`sniper: reserva para la siguiente entrada · ${rm[2]} de ${rm[1]} (~$${rm[3]})`); }
    const usedUsd = open().filter((p) => p.kind !== "cosecha").reduce((a, p) => a + (p.usd ?? 0), 0); // la cosecha tiene su propio tope
    const enter = async (kind, id, usd, extra = {}) => {
      // una entrada pendiente se reanuda con la misma corrida tras un reinicio (antes cada intento empezaba de cero y duplicaba swaps)
      const pend = st.pending?.kind === kind && st.pending?.id === id ? st.pending : (st.pending = { kind, id, at: now });
      const key = `${kind}-${id}-${pend.at}`;
      this.run = this.s.runs[`${this.label}-snipe-${key}`] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", usd, extra: true };
      await this.save();
      this.vaultId = id; this.dcaUsd = usd; this.sweepStable = undefined; this.carryExtra = null;
      this.protectStable = BigInt(this.s.dca?.[this.label]?.retained ?? "0") + BigInt(this.s.dca?.[this.label]?.redeploy ?? "0");
      // reserva: si el token es del par entra tal cual (y se envuelve menos nativo); si no, se cambia antes al estable de la cadena
      const rsv = st.reserve && BigInt(st.reserve.amount) > 0n ? st.reserve : null;
      let rsvUsed = null;
      if (rsv && this.run.usdcIn === undefined) {
        const toks = (sn.info(id)?.depTokens ?? []).map((a) => String(a).toLowerCase());
        if (toks.includes(rsv.token)) { this.carryExtra = { [rsv.token]: rsv.amount }; this.dcaUsd = Math.max(1, usd - rsv.usd); rsvUsed = rsv; }
        else { this.vaultId = id; await routeSwap(this, rsv.token, this.net.stable, BigInt(rsv.amount), `swap reserva→${this.net.stableSym}`); rsvUsed = rsv; }
      }
      try {
        await enterClm(this, ctx);
        if (rsvUsed) { st.reserve = null; extra.basisAddUsd = rsvUsed.usd; extra.reserve = true; if (this.carryExtra) extra.basisAdd = ctx?.ethUsd > 0 && this.net.wrapNative ? String(rsvUsed.usd / ctx.ethUsd) : String(rsvUsed.usd); }
        this.run.status = "hecho"; st.pending = null;
        if (st.need?.kind === kind) st.need = null;
        await this.save(); // que la demanda de fondos se borre ya (si no, un reinicio la deja viva y Base vuelve a puentear)
        st.pos[key] = { kind, id, usd, at: new Date().toISOString(), basis: this.run.usdcIn ?? "0", vshares: this.run.mooShares ?? null, status: "abierta", txs: this.run.txs.map((t) => t.hash), ...extra };
        await this.diag(`sniper ${kind} abierto · $${usd} en ${id}${extra.E ? ` · emisiones ~$${Math.round(extra.E)}/día, TVL ~$${Math.round(extra.T ?? 0)}` : ""} · txs ${this.run.txs.map((t) => t.hash).join(", ")}`);
        return "ok";
      } catch (e) {
        const msg = (e.shortMessage || e.message || String(e)).slice(0, 200);
        this.run.status = "error"; this.run.error = msg;
        if (!e.retry || /STF|exceeds balance/i.test(msg)) { st.pending = null; } // error definitivo o por saldo: la próxima vez empieza de cero
        await this.diag(`sniper: ${kind} en ${id} no entró · ${msg}`);
        if (e.noFunds && kind !== "semilla") st.need = { usd: usd + Number(process.env.SNIPER_NEED_GAS_USD ?? 2), kind, id, at: now };
        return e.noFunds ? "sinFondos" : e.retry ? "reintento" : "error";
      } finally { this.vaultId = null; this.dcaUsd = null; this.carryExtra = null; }
    };

    // b) F2 disparos: éxodos detectados en las últimas 2 h
    for (const rq of sn.requests ?? []) {
      if (st.handled[rq.key] || now - rq.at > 2 * H) continue;
      const info = sn.info(rq.id);
      const minE = Number(process.env.SNIPER_SHOT_MIN_E ?? 50);
      let skip = null;
      if (info?.stock !== false) skip = "Stock Token o tokens sin verificar";
      else if ((rq.E ?? 0) < minE) skip = `emisiones $${Math.round(rq.E ?? 0)}/día < $${minE}`;
      else if (open().filter((p) => p.kind === "disparo").length >= shotsMax) skip = `ya hay ${shotsMax} disparos abiertos`;
      else if (open().some((p) => p.kind === "disparo" && p.id === rq.id)) skip = "ya hay un disparo en ese vault";
      else if (usedUsd + shotUsd > budget) skip = `tope de capital $${budget}`;
      if (skip) { st.handled[rq.key] = { at: now, skip }; await this.diag(`sniper: éxodo en ${rq.id} sin disparo · ${skip}`); return true; }
      const r = await enter("disparo", rq.id, shotUsd, { E: rq.E, T: rq.T });
      if (r === "ok" || r === "error" || (rq.tries = (rq.tries ?? 0) + 1) >= 5) st.handled[rq.key] = { at: now, r };
      return true;
    }

    // c) cosecha: rendimiento real ≥ 1.5 %/día sobre TVL; $SNIPER_HARVEST_USD por vault, hasta SNIPER_HARVEST_MAX, uno por token
    const hUsd = Math.min(Number(process.env.SNIPER_HARVEST_USD_MAX ?? process.env.SNIPER_HARVEST_USD ?? 20), Number(process.env.SNIPER_HARVEST_USD ?? 20) * 2 ** (st.hLevel ?? 0));
    const hMax = Number(process.env.SNIPER_HARVEST_MAX ?? 3), hBudget = Number(process.env.SNIPER_HARVEST_BUDGET_USD ?? 60);
    const hOpen = open().filter((p) => p.kind === "cosecha");
    if (process.env.SNIPER_HARVEST !== "0" && hOpen.length < hMax && hOpen.reduce((a, p) => a + (p.usd ?? 0), 0) + hUsd <= hBudget && now >= (st.hRetryAt ?? 0)) {
      for (const c of sn.harvestCandidates()) {
        if (open().some((p) => p.kind === "cosecha" && (p.id === c.id || (c.token && p.token === c.token)))) continue; // uno por token volátil
        if (st.hSkip?.[c.id] && now - st.hSkip[c.id] < 12 * H) continue;
        const r = await enter("cosecha", c.id, hUsd, { E: c.perDay, T: c.tvl, pct: c.pct, token: c.token });
        if (r === "sinFondos") st.hRetryAt = now + 10 * 60_000;
        else if (r !== "ok") (st.hSkip ??= {})[c.id] = now;
        return true;
      }
    }

    // c2) F1 semillas
    const seeds = open().filter((p) => p.kind === "semilla");
    if (seeds.length < seedsMax && usedUsd + seedUsd <= budget && now >= (st.seedRetryAt ?? 0)) {
      for (const c of sn.seedCandidates()) {
        if (open().some((p) => p.id === c.id) || (st.skipSeed?.[c.id] && now - st.skipSeed[c.id] < 24 * H)) continue;
        // si la wallet ya tiene posición en ese vault (DCA o depósito manual), ya cumple el papel de semilla
        try { const v = await vaultValue(this, c.id); if (v.shares > 0n) { (st.skipSeed ??= {})[c.id] = now; continue; } } catch { continue; }
        const r = await enter("semilla", c.id, seedUsd, { E: c.E, T: c.tvl });
        if (r === "sinFondos") st.seedRetryAt = now + H;
        else if (r !== "ok") (st.skipSeed ??= {})[c.id] = now;
        return true;
      }
    }
    return false;
  }

  /** Al arrancar: verifica (sin enviar nada) que el vault del DCA principal y los de DCA_EXTRA se puedan usar. */
  async checkVaults() {
    const ids = [];
    const main = process.env.STRATEGY_VAULT_ID === "auto" ? process.env.AUTO_PIN : process.env.STRATEGY_VAULT_ID;
    if (main) ids.push({ id: main });
    for (const e of parseDcaExtra(process.env.DCA_EXTRA, this.dcaUsdCfg)) { try { ids.push({ id: await resolveVaultSpec(e.spec, this.net.beefy), extra: true }); } catch (err) { await this.diag(`estrategia ${this.kind}: verificación · "${e.spec}" no encontrado (${err.message})`); } }
    for (const { id, extra } of ids) { this.run = { txs: [] }; await this.diag(`estrategia ${this.kind}: verificación · ${await checkVault(this, id, { extra })}`); }
    this.run = null;
  }

  /**
   * DCA adicionales (DCA_EXTRA="<id o nombre>[@usd],…"): un depósito diario fijo a cada vault, aparte del DCA principal.
   * Estado por vault en s.dca["<etiqueta>+<vault>"]; corridas "<etiqueta>+<vault>#n". Una acción por llamada (true si actuó).
   */
  async extraDca(ctx) {
    const list = parseDcaExtra(process.env.DCA_EXTRA, this.dcaUsdCfg);
    if (!list.length) return false;
    const now = Date.now();
    for (const e of list) {
      const key = `${this.label}+${e.spec.replace(/[^\w.-]+/g, "_")}`;
      const d = ((this.s.dca ??= {})[key] ??= { n: 0, lastAt: 0, totalUsd: 0, deposits: [], spec: e.spec, extra: true });
      // migración: si todos los intentos fallaron (nunca depositó), se vuelve a empezar (los intentos quedan como "-fallido")
      if (!d.migrated && d.n > 0 && !d.totalUsd) { for (let i = 1; i <= d.n; i++) { const k = `${key}#${i}`; if (this.s.runs[k]) { this.s.runs[`${k}-fallido`] = this.s.runs[k]; delete this.s.runs[k]; } } d.n = 0; d.lastAt = 0; d.errors = 0; }
      d.migrated = true;
      if (d.retryAt && now < d.retryAt) continue;
      const label = `${key}#${d.n + 1}`;
      if (!this.s.runs[label] && now - d.lastAt < this.dcaEveryMs) continue;
      if (!d.vaultId) {
        try { d.vaultId = await resolveVaultSpec(e.spec, this.net.beefy); await this.diag(`estrategia ${this.kind} (extra): "${e.spec}" → ${d.vaultId} · $${e.usd} cada ${this.dcaEveryMs / 3600_000} h`); }
        catch (err) { d.retryAt = now + 3600_000; await this.diag(`estrategia ${this.kind} (extra): no se encontró el vault "${e.spec}" en ${this.net.beefy} (${err.message}); reintento en 1 h`); continue; }
      }
      this.run = this.s.runs[label] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", usd: e.usd, extra: true };
      this.vaultId = d.vaultId; this.dcaUsd = e.usd; this.sweepStable = undefined;
      // el capital de la estrategia principal (ganancia retenida + capital por reinvertir) no se usa en los extra
      this.protectStable = BigInt(this.s.dca?.[this.label]?.retained ?? "0") + BigInt(this.s.dca?.[this.label]?.redeploy ?? "0");
      try {
        await enterClm(this, ctx);
        this.run.status = "hecho"; this.run.endedAt = Date.now();
        d.n++; d.lastAt = now; d.totalUsd = +(d.totalUsd + e.usd).toFixed(2); d.retryAt = 0; d.retries = 0; d.fails = 0;
        d.deposits.push({ at: new Date(now).toISOString(), usd: e.usd, txs: this.run.txs.map((t) => t.hash) }); if (d.deposits.length > 60) d.deposits.shift();
        await this.diag(`estrategia beefy-clm-dca (extra): depósito ${d.n} de $${e.usd} en ${d.vaultId} · acumulado $${d.totalUsd} · siguiente ${new Date(now + this.dcaEveryMs).toISOString()}`);
      } catch (err) {
        const msg = (err.shortMessage || err.message || String(err)).slice(0, 300);
        if (err.retry && (d.retries = (d.retries ?? 0) + 1) <= 60) { d.retryAt = now + 60_000; this.run.lastRetry = msg; if (d.retries === 1 || d.retries % 10 === 0) await this.diag(`estrategia beefy-clm-dca (extra): ${d.vaultId} reintento ${d.retries} en 1 min · ${msg}`); }
        else if (err.noFunds) { d.retryAt = now + 3600_000; if (d.lastNoFunds !== label) { d.lastNoFunds = label; await this.diag(`estrategia beefy-clm-dca (extra): ${d.vaultId} · ${msg} · reintento cada hora hasta que haya fondos`); } }
        else if ((d.fails = (d.fails ?? 0) + 1) < 3) {
          // error: hasta 3 intentos por periodo, uno por hora (la misma corrida retoma los pasos ya hechos)
          this.run.status = "pendiente"; this.run.error = msg; d.retryAt = now + 3600_000; d.retries = 0;
          await this.diag(`estrategia beefy-clm-dca (extra): depósito ${label} en ${d.vaultId} falló (intento ${d.fails} de 3) · ${msg} · reintento en 1 h`);
        }
        else { this.run.status = "error"; this.run.error = msg; d.lastAt = now; d.n++; d.fails = 0; d.errors = (d.errors ?? 0) + 1; d.retryAt = 0; d.retries = 0; await this.diag(`estrategia beefy-clm-dca (extra): depósito ${label} en ${d.vaultId} falló 3 veces · ${msg} · se intenta de nuevo en el siguiente periodo`); }
      } finally { this.vaultId = null; this.dcaUsd = null; }
      return true;
    }
    return false;
  }

  /** Depósito periódico: una corrida "<etiqueta>#n" por periodo; sin fondos → reintenta cada hora; error → espera al siguiente periodo. */
  async dca(ctx) {
    const now = Date.now();
    const d = ((this.s.dca ??= {})[this.label] ??= { n: 0, lastAt: 0, totalUsd: 0, deposits: [], vaultId: process.env.STRATEGY_VAULT_ID || null });
    if (this.retryAt && now < this.retryAt) return;
    // LEFTOVER_SWEEP=<etiqueta> (una vez): vende al estable los tokens sueltos de los vaults por los que pasó la estrategia
    // y los suma al capital por reinvertir (así nada queda olvidado en la wallet)
    const lsTag = process.env.LEFTOVER_SWEEP;
    if (lsTag && d.leftSweepTag !== lsTag) {
      d.leftSweepTag = lsTag;
      const ids = [...new Set([...Object.keys(d.holdings ?? {}), ...Object.keys(d.failed ?? {})])];
      const stableUsd = this.net.wrapNative ? (ctx?.ethUsd || 0) : 1;
      const dust = stableUsd > 0 ? ethers.parseUnits((0.2 / stableUsd).toFixed(Math.min(this.net.stableDec, 12)), this.net.stableDec) : 10n ** 30n;
      let total = 0n; const parts = [];
      for (const id of ids) {
        try { const r = await sellVaultTokens(this, id, { dustStable: dust }); if (r.got > 0n) { total += r.got; parts.push(`${id} +${ethers.formatUnits(r.got, this.net.stableDec)} (${r.txs.map((t) => t.hash).join(", ")})`); } }
        catch (e) { parts.push(`${id} error ${(e.shortMessage || e.message || String(e)).slice(0, 80)}`); }
      }
      if (total > 0n && this.redeployOnExit) { d.redeploy = String(BigInt(d.redeploy ?? "0") + total); d.redeployTag = now; }
      await this.diag(`estrategia ${this.kind}: tokens sueltos vendidos (${lsTag}) · +${ethers.formatUnits(total, this.net.stableDec)} ${this.net.stableSym}${this.redeployOnExit ? " al capital por reinvertir" : ""} · ${parts.join(" | ") || "nada que vender"}`);
      return;
    }
    if (this.pauseMain) return this.pausedMain(ctx, d, now);
    // modo automático (STRATEGY_VAULT_ID=auto): solo vaults con APY publicado ≥ HIGH_APY_MIN_PCT; reglas de salida cada hora
    if (process.env.STRATEGY_VAULT_ID === "auto") {
      if (!this.autoAt || now - this.autoAt >= 3600_000) { this.autoAt = now; if (await this.autoTick(ctx, d, now)) return; }
      if (this.dynamic) {
        this.protectStable = BigInt(d.retained ?? "0");
        // retención de ganancias: cobra recompensas cada PROFIT_EVERY_H horas y las aparta (no se reinvierten)
        if (!d.profitAt || now - d.profitAt >= this.profitEveryMs) {
          d.profitAt = now;
          for (const [id, h] of Object.entries(d.holdings ?? {})) if (!h.closed) await this.takeProfit(d, id, h, now).catch(async (e) => this.diag(`estrategia dinámica: cobro de ${id} falló · ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`));
          this.protectStable = BigInt(d.retained ?? "0");
          return;
        }
      }
      if (this.redeployOnExit) {
        // reinversión del capital que salió de un vault (rotación o salida) en el nuevo destino
        if (d.redeploy && BigInt(d.redeploy) > 0n && d.target) {
          // el capital por reinvertir no puede ser mayor que el estable que de verdad hay en la wallet (evita que un
          // saldo contable sin respaldo haga fallar cada destino y los descarte uno por uno)
          try {
            const have = await new ethers.Contract(this.net.stable, ["function balanceOf(address) view returns (uint256)"], this.provider).balanceOf(this.me);
            if (have < BigInt(d.redeploy)) {
              await this.diag(`estrategia dinámica: capital por reinvertir ajustado a lo que hay en la wallet · ${ethers.formatUnits(d.redeploy, this.net.stableDec)} → ${ethers.formatUnits(have, this.net.stableDec)} ${this.net.stableSym}`);
              d.redeploy = String(have);
              if (have === 0n) return;
            }
          } catch {}
          const rl = `${this.label}-redeploy-${d.redeployTag ?? 0}`;
          this.run = this.s.runs[rl] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", redeploy: true };
          this.vaultId = d.target; this.dcaUsd = null; this.sweepStable = Number(ethers.formatUnits(d.redeploy, this.net.stableDec));
          try {
            await enterClm(this, ctx); this.run.status = "hecho"; d.redeploy = String(BigInt(this.run.cleanup?.leftStable ?? "0"));
            if (BigInt(d.redeploy) > 0n) { d.redeployTag = now; this.retryAt = now + 3600_000; } // lo que el CLM no aceptó: otro intento en 1 h
            const h = ((d.holdings ??= {})[d.target] ??= { since: new Date(now).toISOString(), entryApyPct: this.lastScan?.byId?.[d.target]?.apyPct ?? null, entryTvl: this.lastScan?.byId?.[d.target]?.tvl ?? null, usd: 0 });
            h.basis = String(BigInt(h.basis ?? "0") + BigInt(this.run.usdcIn ?? "0")); h.tokens ??= [this.run.t0 ?? this.run.x, this.run.t1].filter(Boolean);
            await this.diag(`estrategia dinámica: capital reinvertido en ${d.target} · ${ethers.formatUnits(this.run.usdcIn ?? "0", this.net.stableDec)} ${this.net.stableSym}`);
          } catch (e) { const msg = (e.shortMessage || e.message || String(e)).slice(0, 200); this.run.status = e.retry ? "pendiente" : "error"; this.run.error = msg; this.retryAt = now + 60_000; if (!e.retry) { if (!/exceeds balance|insufficient/i.test(msg)) (d.failed ??= {})[d.target] = now; d.target = null; d.redeployTag = now; this.autoAt = 0; } await this.diag(`estrategia dinámica: reinversión ${e.retry ? "reintenta" : "falló; se busca otro destino"} · ${msg}`); }
          finally { this.sweepStable = undefined; }
          return;
        }
      }
      if (!d.target) return;
      this.vaultId = d.target;
    }
    // composición de recompensas (una acción por llamada; reanuda un depósito pendiente)
    if (this.compound && (d.compound?.pending || !d.compoundAt || now - d.compoundAt >= this.compoundEveryMs)) {
      if (!d.compound?.pending) d.compoundAt = now;
      const ids = d.compound?.pending ? [d.compound.pending.id] : process.env.STRATEGY_VAULT_ID === "auto" ? [...new Set([...Object.entries(d.holdings ?? {}).filter(([, h]) => !h.closed).map(([id]) => id), d.target].filter(Boolean))] : [process.env.STRATEGY_VAULT_ID].filter(Boolean);
      let acted = false;
      for (const id of ids) {
        try { const before = Object.keys(this.s.runs).length; await this.compoundOnce(d, id, now, ctx); acted ||= Object.keys(this.s.runs).length !== before || !!d.compound?.pending; }
        catch (e) { await this.diag(`estrategia ${this.kind}: composición de ${id} falló · ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`); }
        if (d.compound?.pending) break;
      }
      if (acted) return;
    }
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
    this.protectStable = BigInt(d.retained ?? "0") + BigInt(d.redeploy ?? "0");
    try {
      await enterClm(this, ctx);
      this.run.status = "hecho"; this.run.endedAt = Date.now();
      // lo que el CLM no aceptó ni en la segunda pasada queda apartado y se reinvierte en la siguiente vuelta
      if (this.redeployOnExit && BigInt(this.run.cleanup?.leftStable ?? "0") > 0n) { d.redeploy = String(BigInt(d.redeploy ?? "0") + BigInt(this.run.cleanup.leftStable)); d.redeployTag = now; }
      d.n++; d.lastAt = now; d.totalUsd += this.dcaUsdCfg; d.deposits.push({ at: new Date(now).toISOString(), usd: this.dcaUsdCfg, txs: this.run.txs.map((t) => t.hash) }); if (d.deposits.length > 60) d.deposits.shift();
      d.nextAt = new Date(now + this.dcaEveryMs).toISOString(); this.retryAt = 0;
      if (this.vaultId) { const h = ((d.holdings ??= {})[this.vaultId] ??= { since: new Date(now).toISOString(), entryApyPct: this.lastScan?.byId?.[this.vaultId]?.apyPct ?? null, entryTvl: this.lastScan?.byId?.[this.vaultId]?.tvl ?? null, usd: 0 }); h.usd += this.dcaUsdCfg; h.basis = String(BigInt(h.basis ?? "0") + BigInt(this.run.usdcIn ?? "0")); h.tokens ??= [this.run.t0 ?? this.run.x, this.run.t1].filter(Boolean); }
      await this.diag(`estrategia beefy-clm-dca: depósito ${d.n} de $${this.dcaUsdCfg} en ${this.run.vaultId} · acumulado $${d.totalUsd} · siguiente ${d.nextAt}`);
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 300);
      if (e.retry && (this.run.retries = (this.run.retries ?? 0) + 1) <= 60) { this.retryAt = now + 60_000; this.run.lastRetry = msg; if (this.run.retries === 1 || this.run.retries % 10 === 0) await this.diag(`estrategia beefy-clm-dca: reintento ${this.run.retries} en 1 min · ${msg}`); }
      else if (e.noFunds) { this.retryAt = now + 3600_000; if (d.lastNoFunds !== label) { d.lastNoFunds = label; await this.diag(`estrategia beefy-clm-dca: ${msg} · reintento cada hora hasta que haya fondos`); } }
      else { this.run.status = "error"; this.run.error = msg; d.lastAt = now; d.n++; d.errors = (d.errors ?? 0) + 1; this.retryAt = 0; await this.diag(`estrategia beefy-clm-dca: depósito ${label} falló · ${msg} · se intenta de nuevo en el siguiente periodo`); }
    }
  }

  async onBlock(ctx) {
    this.lastCtx = ctx;
    if (this.kind === "beefy-clm-dca") {
      if (!this.wanted) return;
      if (this.busy) {
        // vigilancia: si una vuelta queda colgada (RPC sin respuesta) se reporta una vez con la etapa
        if (Date.now() - (this.busySince ?? Date.now()) > 10 * 60_000 && !this.stuckLogged) { this.stuckLogged = true; await this.diag(`estrategia ${this.kind}: vuelta ocupada desde ${new Date(this.busySince).toISOString()} en la etapa "${this.stage}" (${this.run?.vaultId ?? this.vaultId ?? "—"})`); }
        return;
      }
      this.busy = true; this.busySince = Date.now(); this.stuckLogged = false;
      try {
        if (!this.checked) { this.checked = true; this.stage = "verificación"; await this.checkVaults().catch(() => {}); }
        this.stage = "migración"; const m = (await this.exitList(ctx)) || (await this.migrate(ctx)) || (await this.depositOnce(ctx)) || (await this.stakeLooseOnce()) || (this.stage = "sniper", await this.snipeStep(ctx).catch(async (e) => { await this.diag(`sniper: error ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`); return false; }));
        this.stage = "extra"; const x = !m && (await this.extraDca(ctx));
        this.stage = "dca"; if (!m && !x) await this.dca(ctx);
        this.stage = "listo";
      } finally { this.busy = false; await this.save().catch(() => {}); }
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
      else if (this.kind === "beefy-clm-exit") { await exitClm(this, ctx); this.addClaimed(this.vaultId, Number(ethers.formatUnits(BigInt(this.run.claimedStable ?? "0"), this.net.stableDec)) * this.stableUsd()); }
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
