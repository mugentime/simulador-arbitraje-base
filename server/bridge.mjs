// Consolidación de fondos (orden de Jose 2026-11-05 15:54: "solo tienes que hacer los bridges y swaps"):
// el gas nativo de esta cadena se puentea a USDC en Base con Relay (api.relay.link), dejando BRIDGE_KEEP_USD para gas.
// Ahí lo toma el depósito diario en Beefy (STRATEGY=beefy-clm-dca), que usa primero el USDC de la wallet.
// Una ejecución por etiqueta (BRIDGE_RUN=<etiqueta>). La tx de Relay se simula con eth_call y estimateGas antes de enviarse.
import { ethers } from "ethers";
import * as core from "../src/core.js";

const RELAY = process.env.RELAY_API || "https://api.relay.link";
export const BASE_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NATIVE = "0x0000000000000000000000000000000000000000";

/** Monto a puentear: saldo − reserva en nativo − colchón de gas (nunca negativo). */
export function bridgeAmount(balWei, keepUsd, nativeUsd, gasWei) {
  if (!(nativeUsd > 0)) return 0n;
  const keep = ethers.parseEther((keepUsd / nativeUsd).toFixed(18));
  const x = balWei - keep - gasWei;
  return x > 0n ? x : 0n;
}
/** Extrae la(s) transacción(es) de una cotización de Relay y el USD de entrada/salida. */
export function parseQuote(q) {
  const txs = [];
  for (const st of q?.steps ?? []) {
    if (st.kind !== "transaction") continue;
    for (const it of st.items ?? []) if (it?.data?.to) txs.push({ step: st.id, requestId: st.requestId ?? null, to: it.data.to, data: it.data.data ?? "0x", value: BigInt(it.data.value ?? 0), chainId: Number(it.data.chainId) });
  }
  const inUsd = Number(q?.details?.currencyIn?.amountUsd ?? NaN), outUsd = Number(q?.details?.currencyOut?.amountUsd ?? NaN);
  const out = q?.details?.currencyOut?.amount ?? null;
  return { txs, inUsd, outUsd, out, requestId: txs.find((t) => t.requestId)?.requestId ?? null };
}

export class Bridger {
  constructor({ executor, provider, store, diag }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag;
    this.label = process.env.BRIDGE_RUN || "";
    this.keepUsd = Number(process.env.BRIDGE_KEEP_USD ?? 1);
    this.minUsd = Number(process.env.BRIDGE_MIN_USD ?? 2);
    this.maxFeePct = Number(process.env.BRIDGE_MAX_FEE_PCT ?? 5);
    this.busy = false; this.done = false;
  }
  get wanted() { return !!this.label && core.CHAIN.id !== BASE_ID && this.x?.wallet && this.x.mode === "live"; }
  async init() { this.s = (await this.store.get("bridge")) ?? { runs: {} }; }
  async save() { await this.store.set("bridge", this.s); }

  async onBlock(ctx) {
    if (this.done || this.busy || !this.wanted) return;
    if (this.retryAt && Date.now() < this.retryAt) return;
    this.busy = true;
    const r = this.s.runs[this.label] ??= { startedAt: Date.now(), status: "pendiente" };
    try {
      if (r.status === "hecho" || r.status === "error" || r.status === "omitido") { this.done = true; return; }
      if (r.hash) return await this.poll(r);
      const me = this.x.wallet.address;
      const bal = await this.provider.getBalance(me);
      const fee = await this.provider.getFeeData();
      const gp = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      const amount = bridgeAmount(bal, this.keepUsd, ctx.ethUsd, gp * 400_000n);
      const usd = Number(ethers.formatEther(amount)) * ctx.ethUsd;
      if (usd < this.minUsd) { r.status = "omitido"; r.reason = `solo $${usd.toFixed(2)} disponibles (saldo ${ethers.formatEther(bal)} ${core.CHAIN.native})`; this.done = true; await this.diag(`bridge: ${r.reason}; nada que puentear`); return; }
      const body = { user: me, recipient: me, originChainId: core.CHAIN.id, destinationChainId: BASE_ID, originCurrency: NATIVE, destinationCurrency: BASE_USDC, amount: amount.toString(), tradeType: "EXACT_INPUT" };
      const res = await fetch(`${RELAY}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      const q = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? JSON.stringify(q ?? {})).slice(0, 160)}`);
      const p = parseQuote(q);
      if (p.txs.length !== 1 || p.txs[0].chainId !== core.CHAIN.id) throw new Error(`cotización de Relay inesperada (${p.txs.length} tx)`);
      const feePct = Number.isFinite(p.inUsd) && Number.isFinite(p.outUsd) && p.inUsd > 0 ? (1 - p.outUsd / p.inUsd) * 100 : null;
      if (feePct !== null && feePct > this.maxFeePct) throw new Error(`comisión ${feePct.toFixed(1)} % > ${this.maxFeePct} %`);
      const tx = { from: me, to: p.txs[0].to, data: p.txs[0].data, value: p.txs[0].value };
      await this.provider.call(tx);
      const gasLimit = (await this.provider.estimateGas(tx)) * 13n / 10n;
      if (tx.value + gasLimit * gp > bal) throw new Error("no alcanza para valor + gas");
      const sent = await this.x.withSender((w) => w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit }));
      Object.assign(r, { hash: sent.hash, requestId: p.requestId, amount: ethers.formatEther(amount), inUsd: p.inUsd, outUsd: p.outUsd, usdcOut: p.out ? ethers.formatUnits(p.out, 6) : null, feePct, sentAt: Date.now() });
      await this.diag(`bridge: ${ethers.formatEther(amount)} ${core.CHAIN.native} ($${p.inUsd?.toFixed?.(2) ?? "?"}) → ~${r.usdcOut ?? "?"} USDC en Base vía Relay (comisión ${feePct?.toFixed?.(2) ?? "?"} %) · tx ${sent.hash} · reserva $${this.keepUsd} para gas`);
      await this.save();
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 300);
      if ((r.retries = (r.retries ?? 0) + 1) <= 5) { this.retryAt = Date.now() + 10 * 60_000; r.lastError = msg; await this.diag(`bridge: intento ${r.retries} falló · ${msg} · reintento en 10 min`); }
      else { r.status = "error"; r.error = msg; this.done = true; await this.diag(`bridge: detenido · ${msg}`); }
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }

  async poll(r) {
    const rc = await this.provider.getTransactionReceipt(r.hash).catch(() => null);
    if (rc && rc.status !== 1) { r.status = "error"; r.error = "tx de origen revertida"; this.done = true; await this.diag(`bridge: tx ${r.hash} revertida`); return; }
    if (!r.requestId) { if (rc) { r.status = "hecho"; this.done = true; await this.diag(`bridge: tx ${r.hash} confirmada (sin requestId para seguir el destino)`); } return; }
    const j = await (await fetch(`${RELAY}/intents/status/v3?requestId=${r.requestId}`, { signal: AbortSignal.timeout(10_000) })).json().catch(() => null);
    const st = j?.status;
    if (st === "success") { r.status = "hecho"; r.destTx = j?.txHashes?.[0] ?? null; this.done = true; await this.diag(`bridge: llegó a Base · ${r.usdcOut ?? "?"} USDC · destino ${r.destTx ?? "?"}`); }
    else if (st === "failure" || st === "refund") { r.status = "error"; r.error = `Relay ${st}`; this.done = true; await this.diag(`bridge: Relay ${st} · ${r.hash}`); }
    else if (Date.now() - r.sentAt > 30 * 60_000) { r.status = "hecho"; r.note = `sin confirmación de destino tras 30 min (estado ${st ?? "?"})`; this.done = true; await this.diag(`bridge: ${r.note}`); }
  }
}
