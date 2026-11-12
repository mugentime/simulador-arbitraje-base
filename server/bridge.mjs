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
      // BRIDGE_TOKEN=<dirección de un estable de esta cadena>: puentea TODO ese token (no el nativo) a USDC en Base
      // (Jose 2026-11-10: concentrar el capital de BSC en Base). Relay puede pedir approve + depósito: se envían en orden.
      const tok = process.env.BRIDGE_TOKEN ? ethers.getAddress(process.env.BRIDGE_TOKEN) : null;
      let amount, usd, dec = 18, sym = core.CHAIN.native;
      if (tok) {
        const T = new ethers.Contract(tok, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"], this.provider);
        dec = Number(await T.decimals()); sym = await T.symbol().catch(() => "token");
        amount = await T.balanceOf(me); usd = Number(ethers.formatUnits(amount, dec));
      } else {
        amount = bridgeAmount(bal, this.keepUsd, ctx.ethUsd, gp * 400_000n);
        usd = Number(ethers.formatEther(amount)) * ctx.ethUsd;
      }
      if (usd < this.minUsd) { r.status = "omitido"; r.reason = `solo $${usd.toFixed(2)} disponibles (saldo ${tok ? ethers.formatUnits(amount, dec) + " " + sym : ethers.formatEther(bal) + " " + core.CHAIN.native})`; this.done = true; await this.diag(`bridge: ${r.reason}; nada que puentear`); return; }
      const body = { user: me, recipient: me, originChainId: core.CHAIN.id, destinationChainId: BASE_ID, originCurrency: tok ?? NATIVE, destinationCurrency: BASE_USDC, amount: amount.toString(), tradeType: "EXACT_INPUT" };
      const res = await fetch(`${RELAY}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      const q = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? JSON.stringify(q ?? {})).slice(0, 160)}`);
      const p = parseQuote(q);
      const okCount = tok ? p.txs.length >= 1 && p.txs.length <= 2 : p.txs.length === 1;
      if (!okCount || p.txs.some((t) => t.chainId !== core.CHAIN.id)) throw new Error(`cotización de Relay inesperada (${p.txs.length} tx)`);
      const feePct = Number.isFinite(p.inUsd) && Number.isFinite(p.outUsd) && p.inUsd > 0 ? (1 - p.outUsd / p.inUsd) * 100 : null;
      if (feePct !== null && feePct > this.maxFeePct) throw new Error(`comisión ${feePct.toFixed(1)} % > ${this.maxFeePct} %`);
      let sent = null;
      for (const t of p.txs) { // en orden (approve y luego depósito); cada una se simula justo antes de enviarse
        const tx = { from: me, to: t.to, data: t.data, value: t.value };
        await this.provider.call(tx);
        const gasLimit = (await this.provider.estimateGas(tx)) * 13n / 10n;
        if (tx.value + gasLimit * gp > (await this.provider.getBalance(me))) throw new Error("no alcanza para valor + gas");
        sent = await this.x.withSender((w) => w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit }));
        if (t !== p.txs[p.txs.length - 1]) { const rc = await this.provider.waitForTransaction(sent.hash, 1, 120_000); if (!rc || rc.status !== 1) throw new Error(`paso ${t.step} ${sent.hash} no confirmó`); await this.diag(`bridge: paso ${t.step} confirmado · tx ${sent.hash}`); }
      }
      Object.assign(r, { hash: sent.hash, requestId: p.requestId, amount: ethers.formatUnits(amount, dec), inUsd: p.inUsd, outUsd: p.outUsd, usdcOut: p.out ? ethers.formatUnits(p.out, 6) : null, feePct, sentAt: Date.now() });
      await this.diag(`bridge: ${ethers.formatUnits(amount, dec)} ${sym} ($${p.inUsd?.toFixed?.(2) ?? "?"}) → ~${r.usdcOut ?? "?"} USDC en Base vía Relay (comisión ${feePct?.toFixed?.(2) ?? "?"} %) · tx ${sent.hash} · reserva $${this.keepUsd} para gas`);
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
// recargas de menos de TOPUP_MIN_USD ($3) no se hacen: la comisión fija de Relay las vuelve caras (y el tope de comisión las rechaza)
/** TOPUP_ONCE="robinhood:35@r1" → { chainKey, usd, tag } (o null). */
export function parseTopupOnce(v) {
  const m = /^\s*([\w-]+)\s*:\s*([0-9]*\.?[0-9]+)\s*@\s*([\w.-]+)\s*$/.exec(v ?? "");
  return m && Number(m[2]) > 0 ? { chainKey: m[1], usd: Number(m[2]), tag: m[3] } : null;
}
export function topupNeed(haveUsd, targetUsd, minUsd = Number(process.env.TOPUP_MIN_USD ?? 3)) { const gap = targetUsd - haveUsd; return gap <= 0 || gap < minUsd ? 0 : +(gap * 1.02).toFixed(2); }

export class Topup {
  constructor({ executor, provider, store, diag, cfg = null }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag;
    // cfg {chainKey, token ("native" = ETH/nativo de destino), targetUsd}; sin cfg: TOPUP_CHAIN/TOPUP_TOKEN/TOPUP_TARGET_USD
    this.chainKey = cfg?.chainKey ?? (process.env.TOPUP_CHAIN || "");
    this.token = cfg?.token ?? (process.env.TOPUP_TOKEN || "");
    this.targetUsd = cfg?.targetUsd ?? Number(process.env.TOPUP_TARGET_USD ?? 10);
    this.storeKey = cfg?.storeKey ?? "topup";
    this.native = this.token === "native";
    this.gasMinUsd = Number(process.env.TOPUP_GAS_MIN_USD ?? 0.5);
    this.gasUsd = Number(process.env.TOPUP_GAS_USD ?? 1);
    this.everyMs = Number(process.env.TOPUP_CHECK_MIN ?? 60) * 60_000;
    this.maxPerDay = Number(process.env.TOPUP_MAX_PER_DAY ?? Infinity); // sin tope por defecto (orden de Jose 2026-11-09)
    this.busy = false; this.nextAt = 0;
  }
  get wanted() { return !!this.chainKey && (this.native || ethers.isAddress(this.token)) && core.CHAIN.id === BASE_ID && this.x?.wallet && this.x.mode === "live"; }
  async init() { this.s = (await this.store.get(this.storeKey)) ?? { sends: [] }; }
  async save() { await this.store.set(this.storeKey, this.s); }

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
      const nat = await dp.getBalance(me);
      const natUsd = await this.nativeUsd();
      const natHaveUsd = natUsd ? Number(ethers.formatEther(nat)) * natUsd : null;
      let haveUsd;
      if (this.native) { if (natHaveUsd === null) throw new Error("sin precio del nativo"); haveUsd = natHaveUsd; }
      else {
        const [rawTok, rawDec] = await Promise.all([dp.call({ to: this.token, data: ERC20.encodeFunctionData("balanceOf", [me]) }), dp.call({ to: this.token, data: ERC20.encodeFunctionData("decimals") })]);
        const dec = Number(ERC20.decodeFunctionResult("decimals", rawDec)[0]);
        haveUsd = Number(ethers.formatUnits(ERC20.decodeFunctionResult("balanceOf", rawTok)[0], dec)); // estable ≈ $1
      }
      this.s.last = { at: new Date().toISOString(), tokenUsd: haveUsd, nativeUsd: natHaveUsd };
      // envío único (TOPUP_ONCE="<cadena>:<usd>@<etiqueta>"): manda exactamente <usd> desde el USDC de Base (nunca desde ETH);
      // espera a que haya USDC suficiente (p. ej. lo que dejan los cierres de EXIT_VAULTS). No cuenta para TOPUP_MAX_PER_DAY.
      const once = parseTopupOnce(process.env.TOPUP_ONCE);
      if (once && once.chainKey === this.chainKey && !(this.s.once ??= {})[once.tag]) {
        const usdcBal = BigInt(await this.provider.call({ to: BASE_USDC, data: ERC20.encodeFunctionData("balanceOf", [me]) }));
        if (usdcBal >= ethers.parseUnits(once.usd.toFixed(6), 6)) {
          const n = this.s.sends.length;
          await this.send({ kind: "único", usd: once.usd, currency: this.native ? NATIVE : this.token }, ctx);
          if (this.s.sends.length > n) this.s.once[once.tag] = new Date().toISOString();
        } else await this.diag(`recarga ${this.chainKey}: envío único ${once.tag} de $${once.usd} esperando USDC en Base (hay ${ethers.formatUnits(usdcBal, 6)})`);
      }
      const today = new Date().toISOString().slice(0, 10);
      const sentToday = this.s.sends.filter((x) => x.at.startsWith(today)).length;
      const jobs = [];
      if (!this.native && natHaveUsd !== null && natHaveUsd < this.gasMinUsd) jobs.push({ kind: "gas", usd: this.gasUsd, currency: NATIVE });
      // lo que la cadena destino pide para operar (sniper/cosecha sin fondos): GET <worker de esa cadena>/api/needs. Se suma al
      // objetivo y esos envíos no cuentan para el tope diario (orden de Jose: si faltan fondos en otra cadena, puentear desde Base).
      const demand = await this.remoteNeed();
      const need = topupNeed(haveUsd, this.targetUsd + demand);
      if (need > 0) jobs.push({ kind: demand > 0 ? "demanda" : "token", usd: need, currency: this.native ? NATIVE : this.token });
      for (const j of jobs) {
        if (sentToday + 1 > this.maxPerDay && j.kind !== "demanda") { await this.diag(`recarga ${this.chainKey}: tope de ${this.maxPerDay} envíos hoy; pendiente ${j.kind} $${j.usd}`); break; }
        await this.send(j, ctx);
      }
    } catch (e) { this.s.lastError = (e.shortMessage || e.message || String(e)).slice(0, 200); await this.diag(`recarga ${this.chainKey}: error ${this.s.lastError}`); }
    finally { this.busy = false; await this.save().catch(() => {}); }
  }

  /** $ que pide el worker de la cadena destino (0 si no responde). */
  async remoteNeed() {
    const host = process.env[`RAILWAY_SERVICE_WORKER_${this.chainKey.toUpperCase()}_URL`];
    if (!host) return 0;
    try { const r = await fetch(`https://${host.replace(/^https?:\/\//, "")}/api/needs`, { signal: AbortSignal.timeout(10_000) }); const j = await r.json(); const u = Number(j?.needUsd ?? 0); if (u > 0) await this.diag(`recarga ${this.chainKey}: la cadena pide $${u.toFixed(2)} (${j?.why ?? "sin detalle"})`); return u > 0 ? Math.min(u, Number(process.env.TOPUP_DEMAND_MAX_USD ?? 60)) : 0; } catch { return 0; }
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

/** Destinos de recarga: TOPUP_TARGETS="bsc:0x55d3…:20,robinhood:native:12"; si no, TOPUP_CHAIN/TOPUP_TOKEN/TOPUP_TARGET_USD. */
export function topupTargets(env = process.env) {
  // TOPUP_DISABLE="robinhood,bsc": cadenas a las que ya no se recarga desde Base (Jose 2026-11-12: sin recargas de gas a Robinhood)
  const off = new Set(String(env.TOPUP_DISABLE ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  return topupTargetsAll(env).filter((t) => !off.has(String(t.chainKey).toLowerCase()));
}
function topupTargetsAll(env) {
  if (env.TOPUP_TARGETS) return env.TOPUP_TARGETS.split(",").map((x) => x.trim()).filter(Boolean).map((x, i) => { const [chainKey, token, usd] = x.split(":"); return { chainKey, token, targetUsd: Number(usd), storeKey: i === 0 && chainKey === env.TOPUP_CHAIN ? "topup" : `topup-${chainKey}` }; });
  return env.TOPUP_CHAIN ? [{ chainKey: env.TOPUP_CHAIN, token: env.TOPUP_TOKEN || "", targetUsd: Number(env.TOPUP_TARGET_USD ?? 10), storeKey: "topup" }] : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Consolidación remota desde el worker de Base (orden de Jose 2026-11-08 22:32: "solo necesitas hacer los bridges necesarios").
// BRIDGE_REMOTE="optimism,monad@<etiqueta>": en cada cadena (con la misma llave) desenvuelve el WETH suelto y puentea el nativo
// (menos una reserva para gas) a USDC en Base con Relay. Una vez por cadena y etiqueta. Sirve aunque esa cadena no tenga worker.
const REMOTE = {
  monad: { id: 143, sym: "MON", rpcs: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz", "https://monad-mainnet.drpc.org"] },
};
const WETH_I = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)"]);
export function parseBridgeRemote(v) {
  const m = /^\s*(.+?)\s*@\s*([\w.-]+)\s*$/.exec(v ?? "");
  return m ? { chains: m[1].split(",").map((x) => x.trim()).filter(Boolean), tag: m[2] } : null;
}
export class RemoteBridge {
  constructor({ executor, store, diag }) { this.x = executor; this.store = store; this.diag = diag; this.busy = false; this.nextAt = 0; }
  get wanted() { return !!parseBridgeRemote(process.env.BRIDGE_REMOTE) && core.CHAIN.id === BASE_ID && this.x?.wallet && this.x.mode === "live"; }
  async init() { this.s = (await this.store.get("bridge-remote")) ?? {}; }
  async save() { await this.store.set("bridge-remote", this.s); }
  cfg(key) {
    if (REMOTE[key]) return REMOTE[key];
    const c = CHAINS[key]; if (!c) return null;
    return { id: c.id, sym: c.native ?? "ETH", rpcs: c.rpcs.filter((u) => !/publicnode/.test(u)), weth: c.tokens?.WETH?.address ?? null }; // publicnode responde 403 a varias lecturas
  }
  async onBlock() {
    if (!this.wanted || this.busy || Date.now() < this.nextAt) return;
    this.busy = true; this.nextAt = Date.now() + 5 * 60_000;
    const { chains, tag } = parseBridgeRemote(process.env.BRIDGE_REMOTE);
    const st = (this.s[tag] ??= {});
    try {
      for (const key of chains) {
        const r = (st[key] ??= { status: "pendiente" });
        if (r.status === "hecho" || r.status === "omitido" || r.status === "error") continue;
        const c = this.cfg(key);
        if (!c) { r.status = "error"; r.error = "cadena desconocida"; await this.diag(`puente remoto ${key}: cadena desconocida`); continue; }
        try {
          const p = new ethers.FallbackProvider(c.rpcs.slice(0, 3).map((u, i) => ({ provider: new ethers.JsonRpcProvider(u, c.id, { staticNetwork: true }), priority: i + 1, weight: 1, stallTimeout: 2500 })), c.id, { quorum: 1 });
          const w = this.x.wallet.connect(p), me = w.address;
          if (c.weth && !r.unwrapped) {
            const wb = WETH_I.decodeFunctionResult("balanceOf", await p.call({ to: c.weth, data: WETH_I.encodeFunctionData("balanceOf", [me]) }))[0];
            if (wb > 0n) { const tx = await w.sendTransaction({ to: c.weth, data: WETH_I.encodeFunctionData("withdraw", [wb]) }); await tx.wait(1, 120_000); await this.diag(`puente remoto ${key}: ${ethers.formatEther(wb)} WETH desenvuelto · tx ${tx.hash}`); }
            r.unwrapped = true; await this.save();
          }
          const bal = await p.getBalance(me), fee = await p.getFeeData(), gp = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
          const amount = bal - gp * 1_000_000n - bal / 50n; // reserva: gas de ~1M y 2 %
          if (amount <= 0n) { r.status = "omitido"; r.reason = `saldo ${ethers.formatEther(bal)} ${c.sym}`; await this.diag(`puente remoto ${key}: nada que puentear (${r.reason})`); continue; }
          const body = { user: me, recipient: me, originChainId: c.id, destinationChainId: BASE_ID, originCurrency: NATIVE, destinationCurrency: BASE_USDC, amount: amount.toString(), tradeType: "EXACT_INPUT" };
          const res = await fetch(`${RELAY}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
          const q = await res.json().catch(() => null);
          if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? JSON.stringify(q ?? {})).slice(0, 160)}`);
          const pq = parseQuote(q);
          if (!pq.txs.length || pq.txs.some((t) => t.chainId !== c.id)) throw new Error("cotización de Relay inesperada");
          if (pq.outUsd < Number(process.env.BRIDGE_MIN_USD ?? 2)) { r.status = "omitido"; r.reason = `solo ~$${pq.outUsd?.toFixed?.(2)} llegarían`; await this.diag(`puente remoto ${key}: ${r.reason}; no vale la comisión`); continue; }
          const feePct = Number.isFinite(pq.inUsd) && pq.inUsd > 0 ? (1 - pq.outUsd / pq.inUsd) * 100 : null;
          if (feePct !== null && feePct > Number(process.env.BRIDGE_MAX_FEE_PCT ?? 5)) throw new Error(`comisión ${feePct.toFixed(1)} %`);
          const hashes = [];
          for (const t of pq.txs) { const tx = await w.sendTransaction({ to: t.to, data: t.data, value: t.value }); const rc = await tx.wait(1, 180_000); if (!rc || rc.status !== 1) throw new Error(`tx ${tx.hash} revertida`); hashes.push(tx.hash); }
          Object.assign(r, { status: "hecho", at: new Date().toISOString(), amount: ethers.formatEther(amount), inUsd: pq.inUsd, outUsd: pq.outUsd, feePct, txs: hashes, requestId: pq.requestId });
          await this.diag(`puente remoto ${key}: ${ethers.formatEther(amount)} ${c.sym} ($${pq.inUsd?.toFixed?.(2) ?? "?"}) → ~$${pq.outUsd?.toFixed?.(2) ?? "?"} USDC en Base (comisión ${feePct?.toFixed?.(2) ?? "?"} %) · txs ${hashes.join(", ")}`);
        } catch (e) {
          const msg = (e.shortMessage || e.message || String(e)).slice(0, 220);
          if ((r.retries = (r.retries ?? 0) + 1) <= 5) { r.lastError = msg; await this.diag(`puente remoto ${key}: intento ${r.retries} falló · ${msg} · reintento en 5 min`); }
          else { r.status = "error"; r.error = msg; await this.diag(`puente remoto ${key}: detenido · ${msg}`); }
        }
        await this.save();
        break; // una cadena por vuelta
      }
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }
}
