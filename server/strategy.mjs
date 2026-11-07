// Estrategia activada por Jose (2026-11-05): depósito simple de USDC en el vault de préstamo de Revert Lend (Uniswap v3, Base),
// financiado con el ETH de la wallet del executor. Sin apalancamiento: no hay precio que liquide.
// Una sola ejecución por etiqueta (STRATEGY_RUN=<etiqueta>); el estado persiste en el volumen.
//   Entrada (STRATEGY=revert-usdc): swap ETH→USDC (Uniswap v3 0.05 %) → approve → vault.deposit. Reserva de gas ≥ STRATEGY_RESERVE_ETH.
//   Salida  (STRATEGY=revert-usdc-exit): vault.redeem(todas las participaciones) → swap USDC→WETH → unwrap a ETH.
// Cada transacción se simula con eth_call (y estimateGas) contra el estado actual antes de enviarse; si la simulación falla, se detiene.
import { ethers } from "ethers";
import { enterClm, exitClm, netOf, harvestProfit, claimForCompound } from "./beefyclm.mjs";
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

  /** Cobra las recompensas de `id` y las suma a lo retenido (estable que los depósitos no tocan). */
  async takeProfit(d, id, h, now, why = "") {
    const label = `${this.label}-profit-${id}-${now}`;
    this.run = this.s.runs[label] = { kind: "beefy-clm-profit", startedAt: now, txs: [], status: "pendiente" };
    this.vaultId = id;
    const r = await harvestProfit(this);
    this.run.status = "hecho"; this.run.stable = String(r.stable); this.run.other = r.other;
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
      if (!c.exit && this.rotate && id === d.target) {
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
        await exitClm(this, ctx); this.run.status = "hecho"; h.closed = new Date(now).toISOString(); h.exitWhy = c.why; if (d.target === id) d.target = null;
        if (this.redeployOnExit && this.run.usdcOut) { d.redeploy = String(BigInt(d.redeploy ?? "0") + BigInt(this.run.usdcOut)); d.redeployTag = now; d.target = pickTarget(elig.filter((x) => x.id !== id), null); }
        await this.diag(`estrategia auto: salida de ${id} (${c.why}) · ${this.run.usdcOut ? ethers.formatUnits(this.run.usdcOut, this.net.stableDec) : "?"} ${this.net.stableSym} de vuelta${this.redeployOnExit ? ` · se reinvierte en ${d.target ?? "(ninguno elegible; queda en la wallet)"}` : ""}`);
      }
      catch (e) { this.run.status = "error"; this.run.error = (e.shortMessage || e.message || String(e)).slice(0, 200); await this.diag(`estrategia auto: salida de ${id} falló · ${this.run.error}`); }
      return true;
    }
    // destino
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

  /** Depósito periódico: una corrida "<etiqueta>#n" por periodo; sin fondos → reintenta cada hora; error → espera al siguiente periodo. */
  async dca(ctx) {
    const now = Date.now();
    const d = ((this.s.dca ??= {})[this.label] ??= { n: 0, lastAt: 0, totalUsd: 0, deposits: [], vaultId: process.env.STRATEGY_VAULT_ID || null });
    if (this.retryAt && now < this.retryAt) return;
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
          const rl = `${this.label}-redeploy-${d.redeployTag ?? 0}`;
          this.run = this.s.runs[rl] ??= { kind: this.kind, startedAt: now, txs: [], status: "pendiente", redeploy: true };
          this.vaultId = d.target; this.dcaUsd = null; this.sweepStable = Number(ethers.formatUnits(d.redeploy, this.net.stableDec));
          try {
            await enterClm(this, ctx); this.run.status = "hecho"; d.redeploy = "0";
            const h = ((d.holdings ??= {})[d.target] ??= { since: new Date(now).toISOString(), entryApyPct: this.lastScan?.byId?.[d.target]?.apyPct ?? null, entryTvl: this.lastScan?.byId?.[d.target]?.tvl ?? null, usd: 0 });
            h.basis = String(BigInt(h.basis ?? "0") + BigInt(this.run.usdcIn ?? "0"));
            await this.diag(`estrategia dinámica: capital reinvertido en ${d.target} · ${ethers.formatUnits(this.run.usdcIn ?? "0", this.net.stableDec)} ${this.net.stableSym}`);
          } catch (e) { const msg = (e.shortMessage || e.message || String(e)).slice(0, 200); this.run.status = e.retry ? "pendiente" : "error"; this.run.error = msg; this.retryAt = now + 60_000; if (!e.retry) { (d.failed ??= {})[d.target] = now; d.target = null; d.redeployTag = now; this.autoAt = 0; } await this.diag(`estrategia dinámica: reinversión ${e.retry ? "reintenta" : "falló; se busca otro destino"} · ${msg}`); }
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
    try {
      await enterClm(this, ctx);
      this.run.status = "hecho"; this.run.endedAt = Date.now();
      d.n++; d.lastAt = now; d.totalUsd += this.dcaUsdCfg; d.deposits.push({ at: new Date(now).toISOString(), usd: this.dcaUsdCfg, txs: this.run.txs.map((t) => t.hash) }); if (d.deposits.length > 60) d.deposits.shift();
      d.nextAt = new Date(now + this.dcaEveryMs).toISOString(); this.retryAt = 0;
      if (this.vaultId) { const h = ((d.holdings ??= {})[this.vaultId] ??= { since: new Date(now).toISOString(), entryApyPct: this.lastScan?.byId?.[this.vaultId]?.apyPct ?? null, entryTvl: this.lastScan?.byId?.[this.vaultId]?.tvl ?? null, usd: 0 }); h.usd += this.dcaUsdCfg; h.basis = String(BigInt(h.basis ?? "0") + BigInt(this.run.usdcIn ?? "0")); }
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
