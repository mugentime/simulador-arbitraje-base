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

// ---------------------------------------------------------------------------------------------------------------
// Recarga periódica de otra cadena desde Base (orden de Jose 2026-11-05 16:39: también $10 diarios en ZEC-USDT de BSC).
// Corre en el worker de Base. Cada TOPUP_CHECK_MIN minutos lee en la cadena destino el saldo del token (TOPUP_TOKEN) y del
// nativo; si el token está por debajo de TOPUP_TARGET_USD, puentea la diferencia (+2 %) desde el USDC de Base (o desde ETH si
// no alcanza); si el nativo vale menos de TOPUP_GAS_MIN_USD, puentea TOPUP_GAS_USD a nativo. Máximo TOPUP_MAX_PER_DAY envíos/día.
import { CHAINS } from "../src/chains.js";
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);

/** Cuánto hace falta en destino (unidades humanas) para llegar al objetivo, con 2 % de margen; 0 si ya alcanza. */
export function topupNeed(haveUsd, targetUsd) { return haveUsd >= targetUsd ? 0 : +((targetUsd - haveUsd) * 1.02).toFixed(2); }

export class Topup {
  constructor({ executor, provider, store, diag }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag;
    this.chainKey = process.env.TOPUP_CHAIN || "";
    this.token = process.env.TOPUP_TOKEN || "";
    this.targetUsd = Number(process.env.TOPUP_TARGET_USD ?? 10);
    this.gasMinUsd = Number(process.env.TOPUP_GAS_MIN_USD ?? 0.5);
    this.gasUsd = Number(process.env.TOPUP_GAS_USD ?? 1);
    this.everyMs = Number(process.env.TOPUP_CHECK_MIN ?? 60) * 60_000;
    this.maxPerDay = Number(process.env.TOPUP_MAX_PER_DAY ?? 3);
    this.busy = false; this.nextAt = 0;
  }
  get wanted() { return !!this.chainKey && ethers.isAddress(this.token) && core.CHAIN.id === BASE_ID && this.x?.wallet && this.x.mode === "live"; }
  async init() { this.s = (await this.store.get("topup")) ?? { sends: [] }; }
  async save() { await this.store.set("topup", this.s); }

  destProvider() {
    if (this.dp) return this.dp;
    const c = CHAINS[this.chainKey]; if (!c) throw new Error(`cadena ${this.chainKey} desconocida`);
    this.destId = c.id;
    this.dp = new ethers.FallbackProvider(c.rpcs.slice(0, 3).map((u, i) => ({ provider: new ethers.JsonRpcProvider(u, c.id, { staticNetwork: true }), priority: i + 1, weight: 1, stallTimeout: 2500 })), c.id, { quorum: 1 });
    return this.dp;
  }

  async onBlock(ctx) {
    if (!this.wanted || this.busy || Date.now() < this.nextAt) return;
    this.busy = true; this.nextAt = Date.now() + this.everyMs;
    try {
      const me = this.x.wallet.address, dp = this.destProvider();
      const [rawTok, rawDec, nat] = await Promise.all([dp.call({ to: this.token, data: ERC20.encodeFunctionData("balanceOf", [me]) }), dp.call({ to: this.token, data: ERC20.encodeFunctionData("decimals") }), dp.getBalance(me)]);
      const dec = Number(ERC20.decodeFunctionResult("decimals", rawDec)[0]);
      const haveUsd = Number(ethers.formatUnits(ERC20.decodeFunctionResult("balanceOf", rawTok)[0], dec)); // estable ≈ $1
      const natUsd = await this.nativeUsd();
      const natHaveUsd = natUsd ? Number(ethers.formatEther(nat)) * natUsd : null;
      this.s.last = { at: new Date().toISOString(), tokenUsd: haveUsd, nativeUsd: natHaveUsd };
      const today = new Date().toISOString().slice(0, 10);
      const sentToday = this.s.sends.filter((x) => x.at.startsWith(today)).length;
      const jobs = [];
      if (natHaveUsd !== null && natHaveUsd < this.gasMinUsd) jobs.push({ kind: "gas", usd: this.gasUsd, currency: NATIVE });
      const need = topupNeed(haveUsd, this.targetUsd);
      if (need > 0) jobs.push({ kind: "token", usd: need, currency: this.token });
      for (const j of jobs) {
        if (sentToday + 1 > this.maxPerDay) { await this.diag(`recarga ${this.chainKey}: tope de ${this.maxPerDay} envíos hoy; pendiente ${j.kind} $${j.usd}`); break; }
        await this.send(j, ctx);
      }
    } catch (e) { this.s.lastError = (e.shortMessage || e.message || String(e)).slice(0, 200); await this.diag(`recarga ${this.chainKey}: error ${this.s.lastError}`); }
    finally { this.busy = false; await this.save().catch(() => {}); }
  }

  async nativeUsd() {
    try { const r = await fetch(`https://api.beefy.finance/prices`, { signal: AbortSignal.timeout(15_000) }); const j = await r.json(); return Number(j[{ bsc: "BNB", polygon: "POL", arbitrum: "ETH", optimism: "ETH" }[this.chainKey] ?? "ETH"]) || null; } catch { return null; }
  }

  /** Puentea `usd` dólares desde Base (USDC; si no alcanza, ETH) hacia `currency` en la cadena destino. */
  async send(j, ctx) {
    const me = this.x.wallet.address;
    const usdcBal = BigInt(await this.provider.call({ to: BASE_USDC, data: ERC20.encodeFunctionData("balanceOf", [me]) }));
    const amtUsdc = ethers.parseUnits(j.usd.toFixed(6), 6);
    let originCurrency = BASE_USDC, amount = amtUsdc;
    if (usdcBal < amtUsdc) {
      const ethBal = await this.provider.getBalance(me);
      const reserve = ethers.parseEther(process.env.STRATEGY_RESERVE_ETH || "0.002");
      const need = ctx?.ethUsd ? ethers.parseEther((j.usd / ctx.ethUsd).toFixed(18)) : 0n;
      if (!need || ethBal - need < reserve) { await this.diag(`recarga ${this.chainKey}: sin fondos en Base para $${j.usd} (${ethers.formatUnits(usdcBal, 6)} USDC, ${ethers.formatEther(ethBal)} ETH)`); return; }
      originCurrency = NATIVE; amount = need;
    }
    const body = { user: me, recipient: me, originChainId: BASE_ID, destinationChainId: this.destId, originCurrency, destinationCurrency: j.currency, amount: amount.toString(), tradeType: "EXACT_INPUT" };
    const res = await fetch(`${RELAY}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const q = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? JSON.stringify(q ?? {})).slice(0, 160)}`);
    const p = parseQuote(q);
    if (!p.txs.length || p.txs.some((t) => t.chainId !== BASE_ID)) throw new Error("cotización de Relay inesperada");
    const feePct = Number.isFinite(p.inUsd) && Number.isFinite(p.outUsd) && p.inUsd > 0 ? (1 - p.outUsd / p.inUsd) * 100 : null;
    if (feePct !== null && feePct > Number(process.env.BRIDGE_MAX_FEE_PCT ?? 5)) throw new Error(`comisión ${feePct.toFixed(1)} %`);
    const hashes = [];
    for (const t of p.txs) { // p. ej. approve + depósito
      const tx = { from: me, to: t.to, data: t.data, value: t.value };
      await this.provider.call(tx);
      const gasLimit = (await this.provider.estimateGas(tx)) * 13n / 10n;
      const sent = await this.x.withSender((w) => w.sendTransaction({ to: t.to, data: t.data, value: t.value, gasLimit }));
      const rc = await this.provider.waitForTransaction(sent.hash, 1, 120_000);
      if (!rc || rc.status !== 1) throw new Error(`${t.step} ${sent.hash} ${rc ? "revertida" : "sin recibo"}`);
      hashes.push(sent.hash);
    }
    const rec = { at: new Date().toISOString(), kind: j.kind, usd: j.usd, from: originCurrency === NATIVE ? "ETH" : "USDC", outUsd: p.outUsd, feePct, requestId: p.requestId, txs: hashes };
    this.s.sends.push(rec); if (this.s.sends.length > 100) this.s.sends.shift();
    await this.diag(`recarga ${this.chainKey}: ${j.kind === "gas" ? "gas" : "token"} $${j.usd} desde ${rec.from} de Base → ~$${p.outUsd?.toFixed?.(2) ?? "?"} en ${this.chainKey} (comisión ${feePct?.toFixed?.(2) ?? "?"} %) · txs ${hashes.join(", ")}`);
  }
}
