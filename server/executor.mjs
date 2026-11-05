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
import { sendBundle, MIN_BUNDLE_GAS_PRICE } from "./bundler.mjs";
import { bumpPairs } from "../src/pairs.js";

// Clave de agregación de motivos de revert: sin argumentos numéricos (InsufficientProfit(196,4126) → InsufficientProfit),
// para que el histograma del resumen no crezca con cada simulación. Panic(17) se conserva (un solo argumento).
export const reasonKey = (r) => String(r ?? "desconocido").replace(/\(\s*-?\d+(?:\s*,\s*-?\d+)+\s*\)$/, "");

const ART = JSON.parse(fs.readFileSync(new URL("./artifacts/ArbExecutor.json", import.meta.url)));
const QUOTER = JSON.parse(fs.readFileSync(new URL("./artifacts/Quoter.json", import.meta.url)));
const SOURCE = { "Morpho Blue": 0, "Balancer v3": 1, "Aave v3": 2 };
const ART_ID = (ART.version ?? "v1") + "-" + ethers.keccak256(ART.bytecode).slice(2, 10); // cambia cuando cambia el contrato
const MAX_RECENT = 80;
/** Gas perdido en reverts de la última hora a partir de p1.recent ("<hash> · revertida (gas $X)", ts del bloque en segundos). */
export const seedRevertGas = (recent = [], now = Date.now()) => (recent ?? []).flatMap((r) => {
  const m = typeof r?.sent === "string" && r.sent.match(/revertida \(gas \$([0-9.]+)\)/);
  const t = (r?.ts ?? 0) * 1000;
  return m && now - t < 3600e3 ? [{ t, usd: Number(m[1]) }] : [];
});
const LADDER_RETRY_RE = /transferFrom reverted|InsufficientProfit|IIA|STF|TRANSFER_FROM_FAILED|CurrencyNotSettled|insufficient|BalanceNotSettled/i; // motivos que justifican probar un monto menor
// RPCs para ENVIAR transacciones (eth_sendRawTransaction). Algunos nodos públicos de solo lectura devuelven 403 al enviar.
// Alchemy (cuenta de Jose, ALCHEMY_KEY en Railway): solo para ENVIAR transacciones (pocas llamadas, propagación rápida).
const ALCHEMY_SLUG = { base: "base-mainnet", arbitrum: "arb-mainnet", optimism: "opt-mainnet", polygon: "polygon-mainnet", bsc: "bnb-mainnet", robinhood: "robinhood-mainnet" };
const alchemyUrl = () => (process.env.ALCHEMY_KEY && ALCHEMY_SLUG[core.CHAIN.key] ? [`https://${ALCHEMY_SLUG[core.CHAIN.key]}.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`] : []);
const sendRpcs = () => (process.env.SEND_RPC ? [process.env.SEND_RPC] : []).concat(alchemyUrl()).concat(core.CHAIN.key === "base" ? ["https://mainnet.base.org", "https://base.llamarpc.com", "https://1rpc.io/base", "https://base-rpc.publicnode.com"]
  // publicnode rechaza eth_sendRawTransaction (403): va al final
  : [...(core.CHAIN.rpcs ?? [])].sort((a, b) => /publicnode/.test(a) - /publicnode/.test(b)));

// Envío directo al secuenciador (L2 con secuenciador central): se salta el balanceador de los RPC.
// Los endpoints de Arbitrum/Robinhood solo aceptan eth_sendRawTransaction, así que las lecturas siguen por el RPC normal.
const SEQUENCER_URL = {
  base: "https://mainnet-sequencer.base.org",
  optimism: "https://mainnet-sequencer.optimism.io",
  arbitrum: "https://arb1-sequencer.arbitrum.io/rpc",
  robinhood: "https://sequencer.mainnet.chain.robinhood.com",
};
export const sequencerUrl = (key) => (process.env.SEQUENCER_SEND === "0" ? null : process.env.SEQUENCER_URL || SEQUENCER_URL[key] || null);

/** Petición JSON-RPC SIN reintentos por 429: ethers reintenta hasta 12 veces con espera exponencial (minutos en el peor
 * caso) y con Alchemy en "Monthly capacity limit exceeded" cada envío de Base esperaba esos reintentos antes de pasar
 * al siguiente RPC (00:42 UTC del 2026-11-05: la ruta ya estaba cerrada al enviar). */
export function noRetryRequest(url, timeoutMs = 4000) {
  const req = new ethers.FetchRequest(url);
  req.setThrottleParams({ maxAttempts: 1 });
  req.timeout = timeoutMs;
  return req;
}
/** Errores de cuota/límite del nodo (no de la tx): el RPC se salta durante un rato. */
export const RATE_LIMIT_RE = /429|capacity limit|too many requests|exceeded maximum retry|rate limit|compute units/i;
/** Cuota MENSUAL agotada (Alchemy "Monthly capacity limit exceeded"): no se recupera en 30 min. Con el salto de 30 min
 *  cada envío de Base (uno cada ~hora) volvía a empezar por Alchemy: el primer intento difundía la tx por el secuenciador
 *  pero fallaba al leer (getBlockNumber en Alchemy) y se reenviaba por otro RPC → "enviada" ~500 ms después (01:42 UTC). */
export const QUOTA_RE = /monthly|capacity limit|compute units per month|quota/i;
/** Minutos que se salta un RPC de envío según el error (cuota mensual: SEND_RPC_QUOTA_BACKOFF_MIN, 720 por defecto). */
export function sendBackoffMin(msg, env = process.env) {
  if (!RATE_LIMIT_RE.test(msg ?? "")) return 0;
  return QUOTA_RE.test(msg) ? Number(env.SEND_RPC_QUOTA_BACKOFF_MIN ?? 720) : Number(env.SEND_RPC_BACKOFF_MIN ?? 30);
}

async function postRaw(url, raw, timeoutMs = 4000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }), signal: ctl.signal });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { throw Object.assign(new Error(`HTTP ${r.status}: ${txt.slice(0, 120)}`), { node: true }); }
    if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), { rpcError: j.error });
    return j.result;
  } finally { clearTimeout(t); }
}

/**
 * Proveedor que lee por `readUrl` y difunde cada tx firmada a la vez a todos los `fanout` (secuenciador primero).
 * Gana la primera respuesta válida; "already known"/"nonce too low" de los más lentos se ignoran.
 */
/** Recorre la ruta con el estado actual de los objetos de pool. Devuelve true si la salida supera al monto prestado,
 *  false si no, y null si el modelo no puede calcularla (en ese caso no se omite nada). */
export function modelStillOpen(route, startAddr, amount) {
  try {
    let a = amount, t = startAddr;
    for (const p of route) { a = core.swapOut(p, t, a); if (typeof a !== "bigint") return null; t = core.other(p, t).address; }
    return a > amount;
  } catch { return null; }
}

/** Prefetch de nonce/gasPrice/bloque para bundles: vale mientras no pase más de ~3 bloques (mín. 1.5 s) desde la lectura.
 *  Ahorra una ida y vuelta RPC (3 lecturas) justo antes de firmar el bundle; un nonce viejo solo hace que el builder
 *  lo rechace (sin costo). */
export function bundlePreFresh(pre, now, blockMs = 450) {
  if (!pre || typeof pre.nonce !== "number" || typeof pre.gasPrice !== "bigint" || typeof pre.head !== "number") return null;
  return now - pre.at <= Math.max(1500, 3 * blockMs) ? pre : null;
}

export class FanoutProvider extends ethers.JsonRpcProvider {
  constructor(readUrl, fanout, chainId) { super(typeof readUrl === "string" ? noRetryRequest(readUrl) : readUrl, chainId, { staticNetwork: true, batchMaxCount: 1 }); this.fanout = fanout; this.lastWinner = null; }
  async send(method, params) {
    if (method !== "eth_sendRawTransaction") return super.send(method, params);
    const raw = params[0];
    const hash = ethers.keccak256(raw);
    const tries = this.fanout.map((u) => postRaw(u, raw).then((res) => ({ u, res })));
    try {
      const t0 = Date.now();
      this.lastReport = Promise.allSettled(this.fanout.map((u, i) => tries[i].then(() => `${new URL(u).host} ok ${Date.now() - t0} ms`, (e) => `${new URL(u).host} error ${Date.now() - t0} ms (${String(e.message).slice(0, 80)})`)))
        .then((r) => r.map((x) => x.value).join(" · "));
      const { u, res } = await Promise.any(tries);
      this.lastWinner = new URL(u).host;
      return res ?? hash;
    } catch (agg) {
      const errs = agg.errors ?? [agg];
      // si alguno dice que ya la conoce, la tx está en camino
      if (errs.some((e) => /already known|known transaction/i.test(e.message))) { this.lastWinner = "ya conocida"; return hash; }
      const own = errs.find((e) => e.rpcError) ?? errs[0];
      const err = new Error(own.message); err.error = own.rpcError ?? { message: own.message }; err.shortMessage = own.message;
      throw err;
    }
  }
}

export function emptyPhase1() {
  return {
    version: 1, mode: null, wallet: null, executor: null, balanceEth: null, deployedAt: null, deployTx: null,
    simulated: 0, wouldSucceed: 0, wouldRevert: 0, byReason: {}, projectedNetUsd: 0, gasUsdSimulated: 0,
    sent: 0, confirmed: 0, reverted: 0, realizedUsd: 0, gasPaidUsd: 0, paused: false, pausedReason: null,
    recent: [], lastError: null, updatedAt: null,
  };
}

const routeKey = (r) => label(r);

/**
 * Último bloque válido de un bundle. El RPC público (y el bloque que procesa el worker, que salta bloques) pueden ir
 * varios bloques por detrás de la punta real; los builders rechazaban con "maxBlockNumber should not be less than
 * currentBlockNum". Se estima la punta también por tiempo: último bloque visto + tiempo transcurrido / blockMs.
 * `seen` ({ n, at }) se actualiza en sitio con el bloque más alto visto.
 */
export function bundleMaxBlock({ head = 0, lastChainBlock = 0, seen, now = Date.now(), blockMs = 750, blocks = 10 }) {
  const known = Math.max(Number(head) || 0, Number(lastChainBlock) || 0);
  if (seen && known > (seen.n ?? 0)) {
    // ritmo real de bloques medido (BSC bajó de 750 ms a ~450 ms por bloque; con 750 fijo la estimación se quedaba corta)
    if (seen.n && seen.at && now > seen.at) {
      const per = (now - seen.at) / (known - seen.n);
      if (per >= 50 && per <= 5000) seen.msPer = seen.msPer ? seen.msPer * 0.8 + per * 0.2 : per;
    }
    seen.n = known; seen.at = now;
  }
  const ms = Math.max(100, Math.min(blockMs, seen?.msPer ?? blockMs));
  const est = seen?.n ? seen.n + Math.floor(Math.max(0, now - (seen.at ?? now)) / ms) : 0;
  return Math.max(known, est) + blocks + Math.max(0, seen?.extra ?? 0);
}

/** ¿Los builders rechazaron solo porque el bundle ya venció (maxBlockNumber por detrás de su punta)? */
export function bundleBlockExpired(errors) {
  const v = Object.values(errors ?? {});
  return v.some((e) => /maxBlockNumber/i.test(String(e))) && v.every((e) => /maxBlockNumber|HTTP 429|rate|limit|timeout|abort/i.test(String(e)));
}

/** Ajusta el margen adaptativo: +10 bloques (tope 60) si venció; −1 si un builder lo aceptó. */
export function bundleMarginAdjust(seen, expired) {
  if (!seen) return 0;
  seen.extra = expired ? Math.min(60, (seen.extra ?? 0) + 10) : Math.max(0, (seen.extra ?? 0) - 1);
  return seen.extra;
}

/** ¿Todos los builders rechazaron porque la tx revierte en su simulación? (la ruta ya se cerró) */
export function bundleAllReverted(errors) {
  const v = Object.values(errors ?? {});
  return v.length > 0 && v.some((e) => /execution reverted|execution failed/i.test(String(e))) && v.every((e) => /execution reverted|execution failed|HTTP 429|rate|limit|timeout|abort/i.test(String(e)));
}

/**
 * Comisión de un back-run público: debe igualar la propina EFECTIVA de la víctima para quedar justo detrás de ella
 * (a igual propina, los nodos ordenan por orden de llegada). Antes se mandaba una tx legacy con gasPrice = maxFeePerGas
 * de la víctima: si la víctima es EIP-1559 con propina < maxFee − baseFee, nuestra propina efectiva era MAYOR y el
 * constructor del bloque nos ponía ANTES que ella, donde la ruta aún no existe → revert.
 */
export function backrunFee(victimTx, baseFee = 0n) {
  const big = (x) => (x == null ? null : BigInt(x));
  const maxFee = big(victimTx.maxFeePerGas), tip = big(victimTx.maxPriorityFeePerGas);
  if (maxFee != null && tip != null && maxFee > 0n) {
    const base = BigInt(baseFee ?? 0n);
    const effTip = maxFee - base < tip ? maxFee - base : tip;
    if (effTip < 0n) return null;
    return { fee: { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip }, effective: base + effTip, desc: `tipo 2, propina ${Number(tip) / 1e9} gwei, maxFee ${Number(maxFee) / 1e9} gwei` };
  }
  const gp = big(victimTx.gasPrice);
  if (gp == null || gp <= 0n) return null;
  return { fee: { gasPrice: gp, type: 0 }, effective: gp, desc: `legacy ${Number(gp) / 1e9} gwei` };
}

/** Valor de P1_RESUME a aplicar ahora, o null si no hay o ya se aplicó (estado.resumedWith). */
export function resumeTag(env, p1) {
  const tag = String(env ?? "").trim();
  if (!tag || tag === "0") return null;
  return p1?.resumedWith === tag ? null : tag;
}

/** Back-run público: el beneficio bruto (tras comisión del préstamo) debe cubrir `margin` veces el gas; si revierte, se pierde el gas. */
export function backrunWorthIt(profitUsd, costUsd, margin = 2) {
  return profitUsd - costUsd > 0 && profitUsd >= margin * costUsd;
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
      minSendNetUsd: Number(process.env.MIN_SEND_NET_USD ?? 0.01),
      tipShare: Number(process.env.TIP_SHARE ?? 0.6), // fracción del neto simulado que se ofrece como propina (orden dentro del bloque)
      maxTipGwei: Number(process.env.MAX_TIP_GWEI ?? 2), // tope de cordura; el límite real es la fracción del neto
      bundleTipShare: Number(process.env.BUNDLE_TIP_SHARE ?? 0.8), // pago al builder en bundles (no cuesta si no se incluye)
      routeCooldownBlocks: Number(process.env.ROUTE_COOLDOWN_BLOCKS ?? 30), // tras un revert, esa ruta no se reenvía hasta pasados N bloques
      // Envío directo: sin eth_call ni estimateGas antes de enviar (ahorra 150–400 ms: la tx entra en el mismo bloque/flashblock
      // en que se vio la ineficiencia). El contrato revierte si no hay beneficio, así que el riesgo es solo el gas del revert,
      // limitado por un presupuesto por hora.
      directSend: process.env.DIRECT_SEND === "1",
      directMinModelUsd: Number(process.env.DIRECT_MIN_MODEL_USD ?? 0.02), // neto del modelo mínimo para enviar sin simular
      revertBudgetUsdPerHour: Number(process.env.REVERT_BUDGET_USD_PER_HOUR ?? 0.25),
      // Bundles a builders (BSC): si la tx revertiría, el builder no la incluye → un intento fallido no cuesta gas.
      bundleSend: process.env.BUNDLE_SEND === "1",
      bundleBlocks: Number(process.env.BUNDLE_BLOCKS ?? 10), // validez del bundle en bloques (BSC ~0.45–0.75 s/bloque: 3 y a veces 6 llegaban vencidos)
      backrunPublic: process.env.BACKRUN_PUBLIC === "1", // back-run sin bundles (mismo gas que la víctima)
    };
    this.inflight = false; this.lastSimBlock = 0; // sentTimes, revertGas y consecutiveReverts: en el estado persistente (getters abajo)
    this.routeCooldown = new Map(); // ruta -> bloque hasta el que no se reenvía
    this.lastChainBlock = 0;
    this.sendIdx = 0; this.sendRpcs = sendRpcs();
    this.sendBad = new Map(); // url -> ms hasta el que se salta (429 / cuota agotada)
  }

  /** Wallet conectada al RPC de envío actual; `rotateSender` pasa al siguiente si uno rechaza el envío. */
  sender() {
    // salta los RPC marcados por cuota agotada (si todos lo están, usa el actual)
    for (let k = 0; k < this.sendRpcs.length && (this.sendBad.get(this.sendRpcs[this.sendIdx % this.sendRpcs.length]) ?? 0) > Date.now(); k++) this.sendIdx++;
    const url = this.sendRpcs[this.sendIdx % this.sendRpcs.length];
    if (!this.sendProv || this.sendUrl !== url) {
      this.sendUrl = url;
      const seq = sequencerUrl(core.CHAIN.key);
      this.sendProv = seq ? new FanoutProvider(url, [seq, url], Number(core.CHAIN_ID)) : new ethers.JsonRpcProvider(noRetryRequest(url), Number(core.CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
      this.sendSigner = new ethers.NonceManager(this.wallet.connect(this.sendProv)); // nonces consecutivos aunque haya envíos seguidos
    }
    return this.sendSigner;
  }
  rotateSender() { this.sendIdx++; this.sendProv = null; return this.sender(); }

  /** Ejecuta `fn(firmante)` en serie (un envío a la vez) probando cada RPC de envío si el anterior rechaza. */
  async withSender(fn) {
    const run = async () => {
      let lastErr;
      for (let i = 0; i < this.sendRpcs.length; i++) {
        const w = this.sender();
        const t0 = Date.now();
        try { return await fn(w); } catch (e) {
          lastErr = e;
          const m = sendErrMsg(e);
          if (/nonce|replacement/i.test(m)) { this.sendSigner?.reset?.(); throw e; } // nonce desincronizado: se resincroniza y se reporta
          // errores propios de la tx (no del nodo): no tiene sentido probar otro RPC
          if (/insufficient funds|execution reverted|CALL_EXCEPTION|underpriced|already known|tip cap|fee cap|below minimum|exceeds block gas limit|intrinsic gas/i.test(m)) throw e;
          const backoffMin = sendBackoffMin(m + " " + String(e?.info?.responseBody ?? e?.error?.message ?? "")), limited = backoffMin > 0;
          if (limited) this.sendBad.set(this.sendUrl, Date.now() + backoffMin * 60e3);
          await this.diag(`fase 1: el RPC ${new URL(this.sendUrl).host} rechazó el envío en ${Date.now() - t0} ms (${m.slice(0, 160)})${limited ? `; se salta ${backoffMin} min` : ""}; probando otro`);
          this.rotateSender();
        }
      }
      throw lastErr;
    };
    const prev = this.sendLock ?? Promise.resolve();
    const p = prev.then(run, run);
    this.sendLock = p.catch(() => {});
    return p;
  }

  /** Historial de simulación por ruta: ≥5 reverts y 0 ok → fantasma (sale del acumulado y del bucle rápido). */
  markRoute(route, ok) {
    if (!route?.length) return;
    const id = core.routeId(route);
    const m = (this.p1.routeSim ??= {});
    const e = (m[id] ??= { ok: 0, rev: 0 });
    if (ok) { e.ok++; core.PHANTOM_ROUTES.delete(id); }
    else { e.rev++; if (e.ok === 0 && e.rev >= Number(process.env.PHANTOM_AFTER ?? 5)) core.PHANTOM_ROUTES.add(id); }
    const keys = Object.keys(m);
    if (keys.length > 5000) for (const k of keys.slice(0, 1000)) delete m[k];
  }

  /** Ruta fantasma (≥5 reverts, 0 ok): no se vuelve a simular en cada bloque; solo se re-comprueba cada
   *  PHANTOM_RECHECK_BLOCKS bloques (por defecto 600) por si el pool cambió. Evita cientos de eth_call por hora
   *  sobre la misma ruta imposible (p. ej. BSC WETH → jinhu → WETH, token con comisión: Pancake: K en cada bloque). */
  phantomSkip(r) {
    if (!r?.route?.length) return false;
    const id = core.routeId(r.route);
    if (!core.PHANTOM_ROUTES.has(id)) return false;
    const m = (this.phantomChecked ??= new Map());
    const blk = Number(this.lastChainBlock ?? 0);
    const last = m.get(id);
    const every = Number(process.env.PHANTOM_RECHECK_BLOCKS ?? 600);
    if (last !== undefined && blk - last < every) { this.p1.phantomSkipped = (this.p1.phantomSkipped ?? 0) + 1; return true; }
    m.set(id, blk);
    return false;
  }

  async init() {
    this.p1 = (await this.store.get("phase1")) ?? emptyPhase1();
    if (!this.p1.revertGas) this.p1.revertGas = seedRevertGas(this.p1.recent); // primera vez: reconstruye la última hora desde los envíos recientes
    for (const [id, e] of Object.entries(this.p1.routeSim ?? {})) if (e.ok === 0 && e.rev >= Number(process.env.PHANTOM_AFTER ?? 5)) core.PHANTOM_ROUTES.add(id);
    if (!this.p1.reconciledLegacy && process.env.RAILWAY_PROJECT_ID) {
      // migración única: los 3 envíos del 2026-11-03 cuyo recibo no quedó registrado (el wait expiró)
      if (core.CHAIN.key === "base") this.p1.pending = (this.p1.pending ?? []).concat([
        { hash: "0xdb84afff00000000000000000000000000000000000000000000000000000000", legacyPrefix: "0xdb84afff", sentAt: Date.now(), route: "envío anterior", startSym: "USDC", startDecimals: 6 },
        { hash: "0x7208509781ce93d17f9551af654f30492ae21e1017406fc98e1f0fe0752aa8c3", sentAt: Date.now(), route: "WETH → Aerodrome Slipstream → USDC → Uniswap v3 → WETH", startSym: "WETH", startDecimals: 18 },
        { hash: "0xd2cdf7f2a9d6fe7cdbb679541597ccc46a8b08b675f7e765938bb401f744f62d", sentAt: Date.now(), route: "USDC → Uniswap v4 → cbBTC → PancakeSwap v3 → USDC", startSym: "USDC", startDecimals: 6 },
      ].filter((t) => !t.legacyPrefix));
      if (core.CHAIN.key === "base") this.p1.sent = Math.max(this.p1.sent, 2);
      this.p1.reconciledLegacy = true;
    }
    if (this.p1.modelVersion !== 2) { // contadores de simulaciones del modelo/contrato anteriores: se reinician, se conserva el contrato
      const keep = { executor: this.p1.executor, artifact: this.p1.artifact, deployedAt: this.p1.deployedAt, deployTx: this.p1.deployTx, previousExecutor: this.p1.previousExecutor };
      this.p1 = { ...emptyPhase1(), ...keep, modelVersion: 2, resetAt: Date.now() };
      await this.diag("fase 1: contadores reiniciados (modelo v2, ticks exactos)");
    }
    // Reanudar fase 1 tras una pausa: P1_RESUME=<etiqueta>. Se consume una vez por valor (queda en el estado), así un
    // redeploy posterior con la misma variable no quita una pausa nueva.
    const resume = resumeTag(process.env.P1_RESUME, this.p1);
    if (resume) {
      const was = this.p1.paused ? this.p1.pausedReason : null;
      this.p1.paused = false; this.p1.pausedReason = null; this.p1.resumedWith = resume;
      this.p1.consecutiveReverts = 0; // si no, la racha vieja (p. ej. 7) vuelve a pausar con el primer revert tras reanudar
      await this.diag(`fase 1: reanudada (P1_RESUME=${resume}${was ? `; estaba pausada por ${was}` : "; no estaba pausada"})`);
    }
    if (!this.p1.executor && process.env.EXECUTOR_ADDRESS) this.p1.executor = process.env.EXECUTOR_ADDRESS; // respaldo si se perdiera el volumen
    this.p1.mode = this.wallet ? this.mode : "sin llave";
    this.p1.wallet = this.wallet?.address ?? null;
    if (!this.wallet) { await this.diag("fase 1: sin PRIVATE_KEY; solo observación"); await this.save(); return; }
    this.p1.balanceEth = Number(ethers.formatEther(await this.provider.getBalance(this.wallet.address)));
    let justDeployed = false;
    if (!this.p1.executor && this.autoDeploy) { await this.deploy(); justDeployed = !!this.p1.executor; }
    if (this.p1.executor && !justDeployed) {
      // un RPC atrasado puede devolver "0x" justo tras el despliegue: reintentar antes de redesplegar
      let code = "0x";
      for (let i = 0; i < 4 && code === "0x"; i++) { if (i) await new Promise((r) => setTimeout(r, 1500)); code = await this.provider.getCode(this.p1.executor).catch(() => "0x"); }
      if (code === "0x") { await this.diag(`fase 1: no hay contrato en ${this.p1.executor}; se redespliega`); this.p1.executor = null; if (this.autoDeploy) await this.deploy(); }
      else if (this.p1.artifact !== ART_ID) {
        await this.diag(`fase 1: el contrato en ${this.p1.executor} es de una versión anterior (${this.p1.artifact ?? "sin versión"} ≠ ${ART_ID})${this.autoDeploy ? "; se despliega la nueva" : "; pon AUTO_DEPLOY=1 para desplegar la nueva"}`);
        if (this.autoDeploy) { this.p1.previousExecutor = this.p1.executor; this.p1.executor = null; await this.deploy(); }
      }
    }
    await this.diag(`fase 1: modo ${this.p1.mode} · wallet ${this.wallet.address} · ${this.p1.balanceEth.toFixed(5)} ${core.CHAIN.native} · contrato ${this.p1.executor ?? "no desplegado"}`);
    await this.save();
    const seq = sequencerUrl(core.CHAIN.key);
    if (seq) {
      // sonda: tx vacía → el secuenciador debe contestar con un error JSON-RPC (prueba que está alcanzable y cuánto tarda)
      const t0 = Date.now();
      postRaw(seq, "0x").then(() => this.diag(`secuenciador ${new URL(seq).host}: responde (${Date.now() - t0} ms)`),
        (e) => this.diag(`secuenciador ${new URL(seq).host}: ${e.rpcError ? "alcanzable" : "NO alcanzable"} en ${Date.now() - t0} ms (${String(e.message).slice(0, 100)})`));
    }
    if (process.env.DEPLOY_QUOTER !== "0") await this.ensureQuoter();
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

  // Tope por hora (sentTimes), presupuesto de reverts por hora (revertGas [{t, usd}]) y racha de reverts: en this.p1, que se
  // guarda en el volumen. Antes vivían en memoria y cada redeploy (hubo varios por hora) los ponía a cero: Base gastó $0.51 en
  // 2 reverts en 10 min con REVERT_BUDGET_USD_PER_HOUR=0.25 porque entre uno y otro hubo un redeploy.
  get sentTimes() { return this.p1 ? (this.p1.sentTimes ??= []) : (this._sentTimes ??= []); }
  set sentTimes(v) { if (this.p1) this.p1.sentTimes = v; else this._sentTimes = v; }
  get revertGas() { return this.p1 ? (this.p1.revertGas ??= []) : (this._revertGas ??= []); }
  set revertGas(v) { if (this.p1) this.p1.revertGas = v; else this._revertGas = v; }
  get consecutiveReverts() { return this.p1 ? (this.p1.consecutiveReverts ?? 0) : (this._consecutiveReverts ?? 0); }
  set consecutiveReverts(v) { if (this.p1) this.p1.consecutiveReverts = v; else this._consecutiveReverts = v; }

  async save() { this.p1.updatedAt = Date.now(); await this.store.set("phase1", this.p1); }

  /** minProfit on-chain ≥ costo total de gas (con propina o pago al builder): si se gana el orden pero el beneficio real
   *  no cubre lo pagado, la tx revierte (en bundle: no se incluye y no cuesta). Devuelve el calldata re-codificado. */
  encodeWithCost(plan, costUsd, ethUsd) {
    const t = plan.meta.startTok;
    const units = t.sym === "WETH" ? costUsd / ethUsd : costUsd; // fuera de WETH los tokens de inicio son dólares
    const need = BigInt(Math.floor(units * 1.02 * 10 ** t.decimals));
    const minProfit = need > plan.minProfit ? need : plan.minProfit;
    return this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, minProfit, plan.hops]]);
  }

  buildPlan(r, lenders, ethUsd) {
    const lender = lenders.find((l) => l.name === r.lender);
    const source = lender?.source ?? SOURCE[r.lender];
    if (!lender || source === undefined) return null;
    if (r.route.some((p) => p.kind === "v4" && !p.tickSpacing)) return null; // v4 sin tickSpacing conocido (universo viejo): se reconstruye solo
    let tokenIn = r.startTok.address;
    const hops = [];
    for (const p of r.route) {
      const tokenOut = core.other(p, tokenIn).address;
      if (p.kind === "split") {
        // salto repartido: DexKind.SPLIT (5) con las partes y sus bps codificadas en `extra`
        if (p.parts.some((q) => q.kind === "v4" && !q.tickSpacing)) return null;
        const parts = p.parts.map((q) => hopTuple(q, tokenIn, tokenOut));
        hops.push([5, ethers.ZeroAddress, tokenIn, tokenOut, 0, 0, 0, ethers.AbiCoder.defaultAbiCoder().encode([`${HOP_T}[]`, "uint16[]"], [parts, p.bps])]);
      } else hops.push(hopTuple(p, tokenIn, tokenOut));
      tokenIn = tokenOut;
    }
    if (tokenIn !== r.startTok.address) return null;
    // beneficio mínimo on-chain = gas estimado del modelo, en unidades del token prestado
    const gasInToken = r.startTok.sym === "WETH" ? r.gasUsd / ethUsd : r.gasUsd; // tokens de inicio no-WETH = dólares (USDC/USDT/USDG)
    const minProfit = BigInt(Math.floor(gasInToken * 10 ** r.startTok.decimals));
    return { source, lender: lender.address, token: r.startTok.address, amount: r.amountIn, minProfit, hops, meta: r };
  }

  /** Llamado por el worker en cada bloque con los resultados ya evaluados. */
  async onBlock({ block, ts, results, lenders, gas, ethUsd, fast = null }) {
    if (this.limits.bundleSend && typeof block === "number" && this.wallet && this.mode === "live") this.refreshBundlePre(block);
    const sim = { sp: fast ?? this.provider, tag: fast ? "pending" : undefined };
    if (this.wallet && (this.p1.pending ?? []).length && !this.reconciling) { this.reconciling = true; try { await this.reconcile(ethUsd); } catch (e) { this.p1.lastError = `reconcile: ${e.shortMessage || e.message}`; } finally { this.reconciling = false; } }
    if (!this.wallet) return results.some((r) => r.profitable) ? "Fase 1 sin llave: solo observación" : null;
    if (!this.p1.executor) return results.some((r) => r.profitable) ? "Fase 1: contrato no desplegado" : null;
    if (typeof block === "number") this.lastChainBlock = block;
    if (typeof block === "number") this.checkShadow(block);
    if (this.inflight || (typeof block === "number" && block <= this.lastSimBlock)) return null;
    const cooled = (r) => (this.routeCooldown.get(routeKey(r)) ?? 0) > this.lastChainBlock;
    const cands = results.filter((r) => r.profitable && r.netUsd >= this.limits.minNetUsd && !r.suspicious && !cooled(r) && !this.phantomSkip(r)).slice(0, 3);
    if (!cands.length) return results.some((r) => r.profitable) ? `Oportunidad por debajo del mínimo de ${this.limits.minNetUsd} USD; no se simula` : null;
    this.inflight = true; if (typeof block === "number") this.lastSimBlock = block;
    let text = null;
    try {
      // envío directo (mismo bloque): la mejor ruta se envía sin simular; la simulación corre después solo como diagnóstico
      if (this.limits.directSend && this.mode === "live" && !this.p1.paused && fast) {
        const r = cands[0];
        if (r.netUsd >= this.limits.directMinModelUsd) {
          const plan = this.buildPlan(r, lenders, ethUsd);
          if (plan) {
            const rec = { block, ts, route: label(r), start: r.start, lender: r.lender, amountUsd: r.amountInUsd, modelNetUsd: r.netUsd, ok: true, direct: true, reason: null, profitUsd: r.grossUsd - r.flashFeeUsd, gasUsd: r.gasUsd, netUsd: r.netUsd, gasEst: Number(core.GAS_BASE + core.GAS_PER_HOP * BigInt(r.hops)) * 1.3, sent: null };
            this.p1.direct = (this.p1.direct ?? 0) + 1;
            await this.send(plan, rec, gas, ethUsd);
            this.p1.recent.unshift(rec); if (this.p1.recent.length > MAX_RECENT) this.p1.recent.length = MAX_RECENT;
            text = `Envío directo (sin simular, neto modelo $${r.netUsd.toFixed(4)}): ${rec.sent}`;
            await this.save();
            return text;
          }
        }
      }
      for (const r of cands) {
        const plan0 = this.buildPlan(r, lenders, ethUsd);
        if (!plan0) { text = `${label(r)}: ruta v4 sin tickSpacing en el universo guardado; se reintenta cuando se reconstruya`; continue; }
        // Re-chequeo local antes de gastar llamadas RPC: el estado de los pools pudo cambiar entre la evaluación y este punto
        // (bucle rápido/eventos actualizan los mismos objetos). Si con el estado actual el modelo ya no devuelve el préstamo,
        // la simulación revertiría seguro (`transferFrom reverted`/`InsufficientProfit`): se omite y se cuenta.
        if (process.env.PRESIM_RECHECK !== "0" && modelStillOpen(r.route, r.startTok.address, plan0.amount) === false) {
          this.p1.staleAtSim = (this.p1.staleAtSim ?? 0) + 1;
          text = `${label(r)}: cerrada en el modelo al simular; no se simula`;
          continue;
        }
        // El modelo de liquidez virtual (v3/v4) es exacto dentro del tick activo pero optimista si el swap cruza ticks:
        // si el contrato dice que con el monto óptimo no alcanza para devolver el préstamo, se prueba con montos menores.
        const { plan, rec } = await this.ladderSim(plan0, r, block, ts, gas, ethUsd, sim);
        if (rec.ok) text = `Simulado on-chain (eth_call contra ${this.p1.executor.slice(0, 8)}…): éxito con préstamo $${rec.amountUsd.toFixed(0)}${rec.sizeDiv > 1 ? ` (óptimo del modelo ÷${rec.sizeDiv})` : ""} · beneficio ${rec.profitUsd.toFixed(4)} USD − gas ${rec.gasUsd.toFixed(4)} = neto ${rec.netUsd.toFixed(4)} USD (modelo: ${rec.modelNetUsd.toFixed(4)})`;
        else text = `Simulado on-chain: revertiría (${rec.reason})`;
        if (rec.ok && this.mode === "live" && !this.p1.paused) { await this.send(plan, rec, gas, ethUsd); text += ` · envío: ${rec.sent}`; }
        if (rec.ok) this.armShadow(plan, rec, block, ethUsd);
        if (rec.ok) break; // una por bloque
      }
      await this.save();
    } catch (e) {
      this.p1.lastError = `bloque ${block}: ${e.shortMessage || e.message}`;
      text = `Error en Fase 1: ${this.p1.lastError}`;
    } finally { this.inflight = false; }
    return text;
  }

  /** Sombra: una simulación ok que NO se envió (pausa, tope por hora = 0, guardas) se re-simula una vez en el primer bloque
   *  posterior. Si la ruta sigue abierta un bloque después, enviarla probablemente habría confirmado; si ya se cerró, otro bot
   *  la tomó en ese bloque (lo que explica los `transferFrom reverted` al enviar). Da evidencia para reactivar envíos (regla 2)
   *  sin gastar gas: 1 eth_call por oportunidad, una a la vez. SHADOW_CHECK=0 lo apaga. */
  armShadow(plan, rec, block, ethUsd) {
    if (process.env.SHADOW_CHECK === "0" || typeof block !== "number" || this.shadow) return;
    if (typeof rec.sent === "string" && !rec.sent.startsWith("omitida")) return; // se envió: el resultado real lo dice
    this.shadow = { plan, block, route: rec.route, gasEst: rec.gasEst ?? 0, gasUsd: rec.gasUsd ?? 0, netUsd: rec.netUsd ?? 0, ethUsd, why: rec.sent ?? (this.p1.paused ? "pausada" : "sin envío") };
  }

  checkShadow(block) {
    const sh = this.shadow;
    if (!sh || block <= sh.block || this.shadowBusy) return;
    if (block > sh.block + 3) { this.shadow = null; return; } // demasiado tarde para medir el bloque siguiente
    this.shadowBusy = true; this.shadow = null;
    const st = (this.p1.shadow ??= { checked: 0, alive: 0, aliveNetUsd: 0, closed: 0, last: null });
    const plan = sh.plan, r = plan.meta;
    const data = this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
    this.provider.call({ to: this.p1.executor, from: this.wallet.address, data, blockTag: block })
      .then((ret) => {
        const profitUsd = core.tokenToUsd(r.startTok, sh.ethUsd)(this.iface.decodeFunctionResult("execute", ret)[0]);
        const net = profitUsd - sh.gasUsd;
        st.checked++; if (net > 0) { st.alive++; st.aliveNetUsd += net; } else st.closed++;
        st.last = `${sh.route} · b${sh.block}→b${block}: ${net > 0 ? `sigue abierta, neto $${net.toFixed(4)}` : `abierta pero neto $${net.toFixed(4)} ≤ 0`}`;
      })
      .catch((e) => { st.checked++; st.closed++; st.last = `${sh.route} · b${sh.block}→b${block}: cerrada (${decodeRevert(this.iface, e).slice(0, 60)})`; })
      .finally(() => { this.shadowBusy = false; });
  }

  countLadderOk(rec) {
    this.p1.wouldSucceed++; this.p1.projectedNetUsd += rec.netUsd; this.p1.gasUsdSimulated += rec.gasUsd; this.p1.simulated++;
    bumpPairs((this.p1.byPair ??= {}), rec.route, "ok");
    this.p1.recent.unshift(rec); if (this.p1.recent.length > MAX_RECENT) this.p1.recent.length = MAX_RECENT;
  }

  /** Escalera de montos (óptimo del modelo ÷1…÷32). El modelo v3/v4 es optimista si el swap cruza ticks, así que se prueban montos menores.
   *  Antes era secuencial (hasta 6 idas y vueltas de eth_call+estimateGas, ~0.1–0.2 s cada una): para cuando se encontraba un monto válido,
   *  otro bot ya había cerrado la ruta. Ahora los 6 escalones van en paralelo (1 ida y vuelta) y se toma el mayor que funcione.
   *  LADDER_PARALLEL=0 vuelve al modo secuencial. */
  async ladderSim(plan0, r, block, ts, gas, ethUsd, sim) {
    const ladder = [1n, 2n, 4n, 8n, 16n, 32n];
    const plans = ladder.map((div) => ({ ...plan0, amount: plan0.amount / div, meta: { ...r, amountIn: r.amountIn / div, amountInUsd: r.amountInUsd / Number(div) } }));
    const retry = (reason) => LADDER_RETRY_RE.test(reason ?? "");
    if (process.env.LADDER_PARALLEL === "0") {
      let plan = plans[0], rec = null;
      for (let i = 0; i < plans.length; i++) {
        plan = plans[i];
        rec = await this.simulate(plan, block, ts, gas, ethUsd, i === plans.length - 1 ? true : "tentative", sim);
        if (rec.ok) { rec.sizeDiv = Number(ladder[i]); break; }
        if (!retry(rec.reason)) break;
      }
      if (!rec.ok && rec.tentative) rec = await this.simulate(plan, block, ts, gas, ethUsd, true, sim);
      return { plan, rec };
    }
    const t0 = Date.now();
    const recs = await Promise.all(plans.map((p) => this.simulate(p, block, ts, gas, ethUsd, "quiet", sim)));
    this.p1.ladderMs = Date.now() - t0;
    const i = recs.findIndex((x) => x.ok);
    if (i >= 0) { const rec = recs[i]; delete rec.tentative; rec.sizeDiv = Number(ladder[i]); this.countLadderOk(rec); return { plan: plans[i], rec }; }
    // ninguno funciona: diagnóstico completo (contabiliza el revert) en el escalón que habría usado la versión secuencial
    let k = 0; while (k < plans.length - 1 && retry(recs[k].reason)) k++;
    return { plan: plans[k], rec: await this.simulate(plans[k], block, ts, gas, ethUsd, true, sim) };
  }

  async simulate(plan, block, ts, gas, ethUsd, mode = true, sim = null) {
    const data = this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
    const tx = { to: this.p1.executor, from: this.wallet.address, data };
    const r = plan.meta;
    const rec = { block, ts, route: label(r), start: r.start, lender: r.lender, amountUsd: r.amountInUsd, modelNetUsd: r.netUsd, ok: false, reason: null, profitUsd: null, gasUsd: null, netUsd: null, sent: null };
    if (mode === "tentative" || mode === "quiet") { // intento de la escalera de montos: no se contabiliza salvo que tenga éxito ("quiet": ni eso; lo contabiliza ladderSim)
      try {
        const sp2 = sim?.sp ?? this.provider, tag2 = sim?.tag;
        const [ret, gasEst] = await Promise.all([sp2.call(tag2 ? { ...tx, blockTag: tag2 } : tx), sp2.estimateGas(tag2 ? { ...tx, blockTag: tag2 } : tx)]);
        const profit = this.iface.decodeFunctionResult("execute", ret)[0];
        const toUsd = core.tokenToUsd(r.startTok, ethUsd);
        rec.ok = true; rec.profitUsd = toUsd(profit); rec.gasEst = Number(gasEst);
        rec.gasUsd = (Number(gasEst * (gas.baseFee + gas.priority) + gas.l1Fee) / 1e18) * ethUsd;
        rec.netUsd = rec.profitUsd - rec.gasUsd;
        if (mode === "tentative") this.countLadderOk(rec);
      } catch (e) { rec.reason = decodeRevert(this.iface, e); rec.tentative = true; }
      return rec;
    }
    const toUsd = core.tokenToUsd(r.startTok, ethUsd);
    // en paralelo: misma ruta en el bloque que vio el modelo (diagnóstico) y en "latest" + estimación de gas (decisión)
    const sp = sim?.sp ?? this.provider, tag = sim?.tag;
    const atBlock = typeof block === "number" ? this.provider.call({ ...tx, blockTag: block }).then((retB) => { rec.profitAtBlockUsd = toUsd(this.iface.decodeFunctionResult("execute", retB)[0]); }).catch((e) => { rec.profitAtBlockUsd = null; rec.reasonAtBlock = decodeRevert(this.iface, e); }) : Promise.resolve();
    rec.fast = !!tag;
    try {
      const [ret, gasEst] = await Promise.all([sp.call(tag ? { ...tx, blockTag: tag } : tx), sp.estimateGas(tag ? { ...tx, blockTag: tag } : tx)]);
      atBlock.catch(() => {});
      const profit = this.iface.decodeFunctionResult("execute", ret)[0];
      rec.ok = true; rec.profitUsd = toUsd(profit); rec.gasEst = Number(gasEst);
      rec.gasUsd = (Number(gasEst * (gas.baseFee + gas.priority) + gas.l1Fee) / 1e18) * ethUsd;
      rec.netUsd = rec.profitUsd - rec.gasUsd;
      this.p1.wouldSucceed++; this.p1.projectedNetUsd += rec.netUsd; this.p1.gasUsdSimulated += rec.gasUsd;
      bumpPairs((this.p1.byPair ??= {}), rec.route, "ok");
      this.markRoute(r.route, true);
    } catch (e) {
      rec.reason = decodeRevert(this.iface, e);
      this.markRoute(r.route, false);
      this.p1.wouldRevert++; { const k = reasonKey(rec.reason); this.p1.byReason[k] = (this.p1.byReason[k] ?? 0) + 1; }
      bumpPairs((this.p1.byPair ??= {}), rec.route, "rev");
      await atBlock;
      if ((rec.reasonAtBlock || tag) && Date.now() - (this.lastBreakdown ?? 0) > 20_000) { // el modelo se equivocó con el mismo estado: desglose por salto, modelo vs cotizador on-chain
        this.lastBreakdown = Date.now();
        let a = plan.amount, t = r.startTok.address;
        const parts = [];
        for (const p of r.route) {
          const o = core.swapOut(p, t, a);
          let chain = "?";
          try { chain = String(await this.quote(p, t, a, sp, tag)); } catch (e) { chain = "cotizador: " + (e.shortMessage || e.message).slice(0, 40); }
          parts.push(`${p.dex} ${p.kind}${p.kind !== "v2" ? ` ticks=${p.ticks ? p.ticks.length : "sin tabla"} ts=${p.tickSpacing} tick=${p.tick} L=${p.liquidity}` : ""} fee=${p.feePips}pips${p.protocolFee ? `+proto ${p.protocolFee}` : ""}: ${a} → modelo ${o} / cadena ${chain}`);
          a = o; t = core.other(p, t).address;
        }
        await this.diag(`fase 1 desglose: ${parts.join(" | ")}`);
      }
      await this.diag(`fase 1: revertiría (${rec.reason}) · en el bloque ${block} del modelo: ${rec.profitAtBlockUsd !== null && rec.profitAtBlockUsd !== undefined ? "bruto on-chain $" + rec.profitAtBlockUsd.toFixed(4) : (rec.reasonAtBlock ?? "sin dato (bloque " + block + ")")} vs modelo bruto $${(r.grossUsd ?? 0).toFixed(4)} · ${rec.route} · préstamo $${rec.amountUsd.toFixed(0)} · pools ${r.route.map((p) => `${p.dex}:${p.address.slice(0, 10)}${p.kind === "v3" ? ` √P=${p.sqrtPriceX96}` : ""}`).join(" → ")}`);
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
    const MINP1 = 4295128740n, MAXM1 = 1461446703485210103287273052203988822378723970341n;
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
    rec.route ??= label(plan.meta);
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
    if (this.sentTimes.length >= this.limits.maxTxPerHour) { rec.sent = "omitida: tope por hora"; return; }
    if (rec.gasUsd > this.limits.maxGasUsd) { rec.sent = `omitida: gas ${rec.gasUsd.toFixed(3)} > tope`; return; }
    if (rec.netUsd <= 0) { rec.sent = "omitida: neto simulado ≤ 0"; return; }
    // Una tx que revierte cuesta ~1 gas completo; solo compensa enviar si el neto simulado cubre varias fallas.
    if (rec.netUsd < this.limits.minSendNetUsd) { rec.sent = `omitida: neto simulado $${rec.netUsd.toFixed(4)} < mínimo de envío $${this.limits.minSendNetUsd}`; return; }
    // valor esperado: con probabilidad de ganar p, enviar compensa si neto·p > gas·(1−p). Con p desconocida y baja,
    // se exige neto ≥ EV_MULT × gas del intento (en bundle un intento perdido no cuesta: no aplica)
    const evMult = Number(process.env.EV_MULT ?? 3);
    if (!this.limits.bundleSend && rec.gasUsd > 0 && rec.netUsd < evMult * rec.gasUsd) { rec.sent = `omitida: neto $${rec.netUsd.toFixed(4)} < ${evMult}× gas $${rec.gasUsd.toFixed(4)} (valor esperado negativo)`; return; }
    // una sola transacción en vuelo: si la anterior aún no tiene recibo, no se envía otra (evita nonces repetidos y
    // reenviar una oportunidad que ya se tomó otro en el mismo bloque)
    if ((this.p1.pending ?? []).length) { rec.sent = `omitida: ${this.p1.pending.length} tx en vuelo sin recibo`; return; }
    // presupuesto de pérdidas por hora: aplica a TODO envío (directo o simulado), no solo al directo.
    // Con bundles no hay pérdida por revert (no se incluyen), así que no aplica.
    let spentHour = 0;
    if (!this.limits.bundleSend) {
      this.revertGas = this.revertGas.filter((x) => now - x.t < 3600e3);
      spentHour = this.revertGas.reduce((a, x) => a + x.usd, 0);
      if (spentHour >= this.limits.revertBudgetUsdPerHour) { rec.sent = `omitida: presupuesto de reverts agotado ($${spentHour.toFixed(3)}/h)`; return; }
    }
    if (this.sending) { rec.sent = "omitida: envío en curso"; return; }
    this.sending = true;
    try {
      const data = this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
      if (this.limits.bundleSend) { await this.sendAsBundle(plan, rec, gas, ethUsd, data, now); return; }
      // Propina: Base ordena por propina dentro de cada flashblock; con la mínima vamos al final y otro bot se lleva
      // la ruta antes. Se ofrece una fracción del neto simulado, con tope.
      // Back-run público (Polygon): comisión fijada para igualar la propina EFECTIVA de la víctima (ver sendBackrunPublic)
      const forced = this.forcedFee;
      // FCFS (Robinhood): el secuenciador ordena por llegada, la propina no adelanta nada → sin propina extra
      // La propina también se pierde si revierte: con propina = 60 % del neto, un intento de neto $0.34 arriesgaba $0.20
      // para ganar $0.14 (23:08 UTC). Se limita para que, tras la propina, el neto siga ≥ EV_MULT × lo que se pierde al
      // revertir: (N − T) ≥ m·(G + T) → T ≤ (N − m·G)/(1 + m).
      const basePrio = gas.priority > core.MIN_PRIORITY_WEI ? gas.priority : core.MIN_PRIORITY_WEI;
      const gasBaseUsd = (Number((gas.baseFee + basePrio) * BigInt(Math.ceil(rec.gasEst ?? 0)) + (gas.l1Fee ?? 0n)) / 1e18) * ethUsd;
      const evTipCap = Math.max(0, (rec.netUsd - evMult * gasBaseUsd) / (1 + evMult));
      const tipUsd = forced || core.CHAIN.fcfs ? 0 : Math.min(rec.netUsd * this.limits.tipShare, evTipCap);
      const tipWei = BigInt(Math.floor((tipUsd / ethUsd) * 1e18 / Math.max(1, rec.gasEst)));
      const capWei = BigInt(Math.floor(this.limits.maxTipGwei * 1e9));
      let prio = gas.priority > core.MIN_PRIORITY_WEI ? gas.priority : core.MIN_PRIORITY_WEI;
      if (!forced && tipWei > prio) prio = tipWei < capWei ? tipWei : capWei;
      if (!forced) rec.netUsd -= (Number(prio - (gas.priority > core.MIN_PRIORITY_WEI ? gas.priority : core.MIN_PRIORITY_WEI)) * rec.gasEst / 1e18) * ethUsd; // neto esperado tras la propina
      if (rec.netUsd <= 0) { rec.sent = "omitida: la propina necesaria se come el neto"; return; }
      // lo que costaría si revierte (gas completo con la propina ofrecida): no puede pasar del presupuesto que queda en la hora.
      // Antes solo se miraba lo ya gastado: a las 15:56 un intento con propina de 0.31 gwei perdió $0.38 con presupuesto de $0.25/h.
      if (!this.limits.bundleSend) {
        const priceWei = forced ? BigInt(forced.maxFeePerGas ?? forced.gasPrice ?? 0n) : gas.baseFee + prio;
        const riskUsd = (Number(priceWei * BigInt(Math.ceil(rec.gasEst ?? 0)) + (gas.l1Fee ?? 0n)) / 1e18) * ethUsd;
        if (!forced && rec.netUsd < evMult * riskUsd * 0.999) { rec.sent = `omitida: neto tras propina $${rec.netUsd.toFixed(4)} < ${evMult}× lo que perdería si revierte $${riskUsd.toFixed(4)}`; return; }
        if (spentHour + riskUsd > this.limits.revertBudgetUsdPerHour) { rec.sent = `omitida: si revierte perdería $${riskUsd.toFixed(3)} y quedan $${Math.max(0, this.limits.revertBudgetUsdPerHour - spentHour).toFixed(3)} del presupuesto de la hora`; return; }
      }
      let maxFee = gas.baseFee * 3n + prio; // margen para 2–3 bloques de subida de base fee
      const txData = forced ? data : this.encodeWithCost(plan, (Number((gas.baseFee + prio) * BigInt(rec.gasEst) + (gas.l1Fee ?? 0n)) / 1e18) * ethUsd, ethUsd);
      const fee = forced ?? { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
      if (forced) { prio = forced.maxPriorityFeePerGas ?? forced.gasPrice; maxFee = forced.maxFeePerGas ?? forced.gasPrice; }
      // Nonce explícito desde "latest" del proveedor de lectura: solo hay una tx en vuelo (ver arriba), así que "latest" es exacto.
      // El NonceManager tomaba "pending" del RPC de envío y polygon.drpc.org devolvió 22 cuando el siguiente era 14 (15:12 UTC):
      // la tx quedó con hueco de nonce, sin minarse. NONCE_LATEST=0 vuelve al NonceManager.
      const nonce = process.env.NONCE_LATEST === "0" ? undefined : await this.provider.getTransactionCount(this.wallet.address, "latest");
      const tx = await this.withSender((w) => (nonce === undefined ? w : (w.signer ?? w)).sendTransaction({ to: this.p1.executor, data: txData, gasLimit: BigInt(Math.floor(rec.gasEst * 1.25)), ...fee, ...(nonce === undefined ? {} : { nonce }) }));
      this.sentTimes.push(now); this.p1.sent++; rec.sent = tx.hash;
      await this.diag(`fase 1: enviada ${tx.hash} (${rec.route}, neto simulado $${rec.netUsd.toFixed(4)}, nonce ${tx.nonce}, propina ${Number(prio) / 1e9} gwei, maxFee ${Number(maxFee) / 1e9} gwei, vía ${this.sendProv?.lastWinner ?? new URL(this.sendUrl).host})`);
      this.sendProv?.lastReport?.then((r) => this.diag(`fase 1: difusión ${tx.hash.slice(0, 10)}: ${r}`)).catch(() => {});
      (this.p1.pending ??= []).push({ hash: tx.hash, sentAt: now, route: rec.route, startSym: plan.meta.startTok.sym, startDecimals: plan.meta.startTok.decimals, netSimUsd: rec.netUsd, victim: rec.backrun ?? null });
      await this.save();
    } catch (e) { rec.sent = `error al enviar: ${sendErrMsg(e).slice(0, 200)}`; this.p1.lastError = rec.sent; await this.diag(`fase 1: ${rec.sent}`); }
    finally { this.sending = false; }
  }

  /**
   * Back-run: bundle [tx de la víctima, nuestra tx]. Nuestra tx solo se ejecuta si va justo detrás de la suya; si la
   * ruta deja de ser rentable el bundle no se incluye (sin costo). Devuelve un texto de estado o null si no se envió.
   */
  async sendBackrun(victimRaw, victimHash, r, lenders, gas, ethUsd, victimTx = null) {
    if (!this.wallet || !this.p1.executor || this.mode !== "live" || this.p1.paused) return null;
    // sin bundles (Polygon): envío público con el MISMO precio de gas que la víctima → los nodos ordenan por precio y
    // luego por llegada, así que quedamos justo detrás. Si revierte se paga gas (cuenta para el presupuesto por hora).
    if (!this.limits.bundleSend) return this.limits.backrunPublic ? this.sendBackrunPublic(victimTx, r, lenders, gas, ethUsd) : null;
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
    if (this.sentTimes.length >= this.limits.maxTxPerHour) return null;
    if ((this.p1.pending ?? []).length && !this.reconciling) { this.reconciling = true; try { await this.reconcile(ethUsd); } catch { /* red */ } finally { this.reconciling = false; } }
    if ((this.p1.pending ?? []).length || this.sending) return null;
    const plan = this.buildPlan(r, lenders, ethUsd);
    if (!plan) return null;
    this.sending = true;
    try {
      let data = this.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
      const w = this.wallet.connect(this.provider);
      const [nonce, netGp, head] = await Promise.all([
        this.provider.getTransactionCount(this.wallet.address, "latest"),
        this.provider.send("eth_gasPrice", []).then(BigInt).catch(() => MIN_BUNDLE_GAS_PRICE),
        this.provider.getBlockNumber(),
      ]);
      const gasEst = Number(core.GAS_BASE + core.GAS_PER_HOP * BigInt(r.hops)) * 1.3;
      const gasLimit = BigInt(Math.floor(gasEst * 1.4));
      const tipWei = BigInt(Math.floor(((r.netUsd * this.limits.bundleTipShare) / ethUsd) * 1e18 / Math.max(1, gasEst)));
      let gasPrice = (netGp > MIN_BUNDLE_GAS_PRICE ? netGp : MIN_BUNDLE_GAS_PRICE) + tipWei;
      const cap = BigInt(Math.floor(this.limits.maxTipGwei * 1e9)) + MIN_BUNDLE_GAS_PRICE;
      if (gasPrice > cap) gasPrice = cap;
      data = this.encodeWithCost(plan, (Number(gasPrice * BigInt(Math.floor(gasEst))) / 1e18) * ethUsd, ethUsd);
      const raw = await w.signTransaction({ type: 0, chainId: core.CHAIN_ID, to: this.p1.executor, data, nonce, gasLimit, gasPrice });
      const hash = ethers.keccak256(raw);
      // el RPC público puede ir unos bloques por detrás (BSC ~0.75 s/bloque): se toma el bloque más alto conocido y
      // se da margen (BlockSec rechazaba con "maxBlockNumber should be larger than currentBlockNum")
      const maxBlockNumber = bundleMaxBlock({ head, lastChainBlock: this.lastChainBlock, seen: (this.headSeen ??= { n: 0, at: 0 }), now: Date.now(), blockMs: core.CHAIN.blockMs, blocks: this.limits.bundleBlocks });
      // Dos bundles a la vez con la MISMA tx nuestra (mismo nonce: solo uno puede entrar):
      //  (a) [víctima, nosotros] — back-run en el mismo bloque;
      //  (b) [nosotros] — si la víctima ya se minó (lo vimos tarde), el desajuste que dejó sigue ahí y se captura igual.
      const [ra, rb] = await Promise.all([sendBundle([victimRaw, raw], { maxBlockNumber }), sendBundle([raw], { maxBlockNumber })]);
      const accepted = [...new Set([...ra.accepted.map((x) => x + " (tras víctima)"), ...rb.accepted.map((x) => x + " (sola)")])];
      const errors = Object.fromEntries([...Object.entries(ra.errors).map(([k, v]) => [k + " (tras víctima)", v]), ...Object.entries(rb.errors).map(([k, v]) => [k + " (sola)", v])]);
      this.p1.bundles = (this.p1.bundles ?? 0) + 1; this.p1.backruns = (this.p1.backruns ?? 0) + 1;
      const errTxt = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(" · ");
      const route = label(r);
      if (!accepted.length && (bundleBlockExpired(ra.errors) || bundleBlockExpired(rb.errors))) bundleMarginAdjust(this.headSeen, true);
      else if (accepted.length) bundleMarginAdjust(this.headSeen, false);
      if (!accepted.length) { this.p1.lastError = `back-run rechazado por todos los builders (${errTxt.slice(0, 160)})`; return `rechazado (${errTxt.slice(0, 160)})`; }
      this.sentTimes.push(now); this.p1.sent++;
      const rec = { block: head, ts: Math.floor(now / 1000), route, start: r.start, lender: r.lender, amountUsd: r.amountInUsd, modelNetUsd: r.netUsd, ok: true, direct: true, backrun: victimHash, reason: null, profitUsd: r.grossUsd - r.flashFeeUsd, gasUsd: r.gasUsd, netUsd: r.netUsd, gasEst, sent: hash };
      this.p1.recent.unshift(rec); if (this.p1.recent.length > MAX_RECENT) this.p1.recent.length = MAX_RECENT;
      (this.p1.pending ??= []).push({ hash, sentAt: now, route, startSym: plan.meta.startTok.sym, startDecimals: plan.meta.startTok.decimals, netSimUsd: r.netUsd, bundle: true, maxBlock: maxBlockNumber });
      await this.save();
      return `bundle ${hash.slice(0, 12)}… enviado a ${accepted.join(", ")} (hasta el bloque ${maxBlockNumber})${errTxt ? ` · rechazos: ${errTxt.slice(0, 120)}` : ""}`;
    } finally { this.sending = false; }
  }

  async sendBackrunPublic(victimTx, r, lenders, gas, ethUsd) {
    if (!victimTx) return null;
    // Polygon 2026-11-05: 7/7 back-runs públicos revertidos; el último cayó un bloque DESPUÉS de la víctima (la vimos
    // tarde y otro bot cerró el desajuste). Si la víctima ya está minada, el back-run público no tiene ventaja de orden:
    // no se envía (la ruta normal por bloque la evalúa con el estado real).
    if (victimTx.blockNumber != null) { this.p1.backrunLate = (this.p1.backrunLate ?? 0) + 1; return "omitido: víctima ya minada al recibirla"; }
    try {
      const vr = await this.provider.getTransactionReceipt(victimTx.hash);
      if (vr) { this.p1.backrunLate = (this.p1.backrunLate ?? 0) + 1; return `omitido: víctima ya minada (bloque ${vr.blockNumber})`; }
    } catch { /* red: se sigue */ }
    const plan = this.buildPlan(r, lenders, ethUsd);
    if (!plan) return null;
    const fx = backrunFee(victimTx, gas.baseFee);
    if (!fx) return null;
    const gp = fx.effective;
    const gasEst = Number(core.GAS_BASE + core.GAS_PER_HOP * BigInt(r.hops)) * 1.3;
    const costUsd = (Number(gp) * gasEst / 1e18) * ethUsd;
    const rec = { block: this.lastChainBlock, ts: Math.floor(Date.now() / 1000), route: label(r), start: r.start, lender: r.lender, amountUsd: r.amountInUsd, modelNetUsd: r.netUsd, ok: true, direct: true, backrun: victimTx.hash, reason: null, profitUsd: r.grossUsd - r.flashFeeUsd, gasUsd: costUsd, netUsd: r.grossUsd - r.flashFeeUsd - costUsd, gasEst, sent: null };
    if (rec.netUsd <= 0) return `omitido: gas al precio de la víctima $${costUsd.toFixed(4)} ≥ beneficio`;
    const margin = Number(process.env.BACKRUN_MIN_MARGIN ?? 2);
    if (!backrunWorthIt(rec.profitUsd, costUsd, margin)) return `omitido: beneficio $${rec.profitUsd.toFixed(4)} < ${margin}× gas $${costUsd.toFixed(4)}`;
    // send() aplica topes, presupuesto de reverts y una sola tx en vuelo; se fija el precio exacto de la víctima
    this.forcedFee = fx.fee;
    try { await this.send(plan, rec, { ...gas, baseFee: 0n, priority: 0n }, ethUsd); } finally { this.forcedFee = null; }
    this.p1.recent.unshift(rec); if (this.p1.recent.length > MAX_RECENT) this.p1.recent.length = MAX_RECENT;
    if (/^0x/.test(String(rec.sent))) this.p1.backruns = (this.p1.backruns ?? 0) + 1;
    return `envío público con la propina efectiva de la víctima (${fx.desc}): ${rec.sent}`;
  }

  /**
   * Envío como bundle de una transacción a varios builders. La tx se firma con el nonce actual ("latest": un bundle
   * no incluido no consume nonce) y un gasPrice ≥ 0.05 gwei + una parte del neto como pago al builder.
   */
  /** Lee en segundo plano (una vez por bloque) nonce, gasPrice y bloque para que el envío del bundle no espere al RPC. */
  refreshBundlePre(block) {
    if (this.bundlePreBusy || (this.bundlePre && this.bundlePre.block >= block)) return;
    this.bundlePreBusy = true;
    Promise.all([
      this.provider.getTransactionCount(this.wallet.address, "latest"),
      this.provider.send("eth_gasPrice", []).then(BigInt).catch(() => MIN_BUNDLE_GAS_PRICE),
    ]).then(([nonce, gasPrice]) => { this.bundlePre = { block, head: block, nonce, gasPrice, at: Date.now() }; })
      .catch(() => {}).finally(() => { this.bundlePreBusy = false; });
  }

  async sendAsBundle(plan, rec, gas, ethUsd, data, now) {
    const w = this.wallet.connect(this.provider);
    const pre = process.env.BUNDLE_PREFETCH === "0" ? null : bundlePreFresh(this.bundlePre, Date.now(), core.CHAIN.blockMs);
    const [nonce, netGp, head] = pre ? [pre.nonce, pre.gasPrice, Math.max(pre.head, this.lastChainBlock || 0)] : await Promise.all([
      this.provider.getTransactionCount(this.wallet.address, "latest"),
      this.provider.send("eth_gasPrice", []).then(BigInt).catch(() => MIN_BUNDLE_GAS_PRICE),
      this.provider.getBlockNumber(),
    ]);
    if (pre) this.p1.bundlesPrefetched = (this.p1.bundlesPrefetched ?? 0) + 1;
    const gasLimit = BigInt(Math.floor(rec.gasEst * 1.25));
    // pago al builder: hasta tipShare del neto simulado, repartido en el gas de la tx
    // el builder ordena por lo que le pagamos (gasPrice × gas): se ofrece bundleTipShare del neto; si el bundle no entra no cuesta
    const tipWei = BigInt(Math.floor(((rec.netUsd * this.limits.bundleTipShare) / ethUsd) * 1e18 / Math.max(1, rec.gasEst)));
    let gasPrice = (netGp > MIN_BUNDLE_GAS_PRICE ? netGp : MIN_BUNDLE_GAS_PRICE) + tipWei;
    const cap = BigInt(Math.floor(this.limits.maxTipGwei * 1e9)) + MIN_BUNDLE_GAS_PRICE;
    if (gasPrice > cap) gasPrice = cap;
    const costUsd = (Number(gasPrice * BigInt(rec.gasEst)) / 1e18) * ethUsd;
    if (rec.profitUsd !== null && rec.profitUsd !== undefined && costUsd >= rec.profitUsd) { rec.sent = `omitida: gas del bundle $${costUsd.toFixed(4)} ≥ beneficio $${rec.profitUsd.toFixed(4)}`; return; }
    data = this.encodeWithCost(plan, costUsd, ethUsd); // si el beneficio real no cubre lo pagado al builder, revierte → no se incluye
    const raw = await w.signTransaction({ type: 0, chainId: core.CHAIN_ID, to: this.p1.executor, data, nonce, gasLimit, gasPrice });
    const hash = ethers.keccak256(raw);
    const seen = (this.headSeen ??= { n: 0, at: 0 });
    let maxBlockNumber = bundleMaxBlock({ head, lastChainBlock: this.lastChainBlock, seen, now: Date.now(), blockMs: core.CHAIN.blockMs, blocks: this.limits.bundleBlocks }); // ver bundleMaxBlock
    let { accepted, errors } = await sendBundle(raw, { maxBlockNumber });
    if (!accepted.length && bundleBlockExpired(errors)) {
      // vencido al llegar: se amplía el margen y se reenvía una vez la MISMA tx (un bundle no incluido no cuesta)
      bundleMarginAdjust(seen, true); this.p1.bundlesExpired = (this.p1.bundlesExpired ?? 0) + 1;
      maxBlockNumber = bundleMaxBlock({ head, lastChainBlock: this.lastChainBlock, seen, now: Date.now(), blockMs: core.CHAIN.blockMs, blocks: this.limits.bundleBlocks });
      ({ accepted, errors } = await sendBundle(raw, { maxBlockNumber }));
    } else if (accepted.length) bundleMarginAdjust(seen, false);
    this.p1.bundles = (this.p1.bundles ?? 0) + 1;
    const errTxt = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(" · ");
    if (!accepted.length) {
      rec.sent = `bundle rechazado por todos los builders (${errTxt.slice(0, 200)})`;
      this.p1.lastError = rec.sent;
      // la tx revierte en la simulación de los builders: la ruta ya se cerró; no se reenvía la misma en los próximos bloques
      if (bundleAllReverted(errors)) { this.routeCooldown.set(rec.route, Math.max(head, this.lastChainBlock || 0) + 3); this.p1.bundlesReverted = (this.p1.bundlesReverted ?? 0) + 1; }
      await this.diag(`fase 1: ${rec.sent}`);
      return;
    }
    this.sentTimes.push(now); this.p1.sent++; rec.sent = hash;
    await this.diag(`fase 1: bundle ${hash} enviado a ${accepted.join(", ")} (${rec.route}, neto simulado $${rec.netUsd.toFixed(4)}, gasPrice ${Number(gasPrice) / 1e9} gwei, válido hasta el bloque ${maxBlockNumber}, nonce ${nonce})${errTxt ? ` · rechazos: ${errTxt.slice(0, 200)}` : ""}`);
    (this.p1.pending ??= []).push({ hash, sentAt: now, route: rec.route, startSym: plan.meta.startTok.sym, startDecimals: plan.meta.startTok.decimals, netSimUsd: rec.netUsd, bundle: true, maxBlock: maxBlockNumber });
    await this.save();
  }

  /** Resuelve el resultado de las transacciones enviadas (recibo), aunque el proceso se haya reiniciado. */
  async reconcile(ethUsd) {
    const pend = this.p1.pending ?? [];
    if (!pend.length) return;
    const keep = [];
    for (const t of pend) {
      let rcpt = null;
      try { rcpt = await this.provider.getTransactionReceipt(t.hash); } catch { /* red */ }
      if (!rcpt) {
        if (t.bundle) {
          // bundle no incluido: si ya pasó su último bloque válido, se descarta sin costo
          let head = this.lastChainBlock;
          try { head = await this.provider.getBlockNumber(); } catch { /* red */ }
          if (head > t.maxBlock + 1) {
            this.p1.bundlesMissed = (this.p1.bundlesMissed ?? 0) + 1; this.p1.sent = Math.max(0, this.p1.sent - 1);
            this.routeCooldown.set(t.route, head + 3);
            const rec = this.p1.recent.find((r) => typeof r.sent === "string" && r.sent.startsWith(t.hash));
            if (rec) rec.sent = `${t.hash} · bundle no incluido (sin costo)`;
            await this.diag(`fase 1: bundle ${t.hash.slice(0, 12)}… no incluido hasta el bloque ${t.maxBlock} (sin costo) · ${t.route}`);
          } else keep.push(t);
          continue;
        }
        if (Date.now() - t.sentAt > 15 * 60_000) { await this.diag(`fase 1: ${t.hash} no fue minada en 15 min (descartada por la red; sin costo)`); this.p1.dropped = (this.p1.dropped ?? 0) + 1; }
        else keep.push(t);
        continue;
      }
      const paid = (Number(rcpt.gasUsed * (rcpt.gasPrice ?? 0n)) / 1e18) * ethUsd;
      this.p1.gasPaidUsd += paid;
      const rec = this.p1.recent.find((r) => typeof r.sent === "string" && r.sent.startsWith(t.hash));
      if (rcpt.status === 1) {
        this.p1.confirmed++; this.consecutiveReverts = 0;
        bumpPairs((this.p1.byPair ??= {}), t.route, "conf");
        const ev = rcpt.logs.map((l) => { try { return this.iface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Executed");
        const realized = ev ? core.tokenToUsd({ sym: t.startSym, decimals: t.startDecimals }, ethUsd)(ev.args.profit) : 0;
        this.p1.realizedUsd += realized - paid;
        if (rec) rec.sent = `${t.hash} · confirmada · +$${(realized - paid).toFixed(4)}`;
        await this.diag(`fase 1: confirmada ${t.hash} · bruto $${realized.toFixed(4)} − gas $${paid.toFixed(4)} = ${realized - paid >= 0 ? "+" : ""}$${(realized - paid).toFixed(4)} · bloque ${rcpt.blockNumber} · ${t.route}`);
      } else {
        this.p1.reverted++; this.consecutiveReverts++;
        bumpPairs((this.p1.byPair ??= {}), t.route, "sentRev");
        this.revertGas.push({ t: Date.now(), usd: paid });
        this.routeCooldown.set(t.route, (rcpt.blockNumber ?? this.lastChainBlock) + this.limits.routeCooldownBlocks);
        if (rec) rec.sent = `${t.hash} · revertida (gas $${paid.toFixed(4)})`;
        await this.diag(`fase 1: revertida ${t.hash} · gas perdido $${paid.toFixed(4)} · bloque ${rcpt.blockNumber} · ${t.route}${t.victim ? " · " + await this.backrunOrder(t.victim, rcpt) : ""}`);
        if (this.consecutiveReverts >= this.limits.pauseAfterReverts * (this.limits.directSend ? 4 : 1)) { this.p1.paused = true; // en envío directo manda el presupuesto por hora, no la racha
           this.p1.pausedReason = `${this.consecutiveReverts} reverts seguidos`; await this.diag(`fase 1: PAUSADA · ${this.p1.pausedReason}`); }
      }
    }
    if (keep.length !== pend.length) this.bundlePre = null; // una tx propia se resolvió: el nonce pudo cambiar
    this.p1.pending = keep;
    await this.save();
  }

  /** Diagnóstico de un back-run revertido: ¿quedamos antes o después de la víctima, y en qué bloque? */
  async backrunOrder(victimHash, rcpt) {
    try {
      const v = await this.provider.getTransactionReceipt(victimHash);
      if (!v) return `víctima ${victimHash.slice(0, 12)}… sin minar (nosotros idx ${rcpt.index ?? "?"})`;
      const where = v.blockNumber !== rcpt.blockNumber ? `víctima en otro bloque (${v.blockNumber})`
        : (v.index < rcpt.index ? `tras la víctima (idx ${v.index} → ${rcpt.index}, ${rcpt.index - v.index - 1} tx entre medio)` : `ANTES de la víctima (idx ${rcpt.index} < ${v.index})`);
      return `back-run: ${where}`;
    } catch (e) { return `back-run: sin recibo de la víctima (${String(e.message ?? e).slice(0, 60)})`; }
  }

  /** Cotización exacta on-chain de un salto (v2 por reservas; v3/v4 por el contrato Quoter sin tokens). */
  async quote(p, tokenIn, amountIn, sp = this.provider, tag = undefined) {
    if (p.kind === "split") {
      // salto repartido entre varios pools del mismo par: misma asignación que el contrato (la última parte, el resto)
      let left = amountIn, out = 0n;
      for (let i = 0; i < p.parts.length; i++) {
        const a = i === p.parts.length - 1 ? left : (amountIn * BigInt(p.bps[i])) / 10000n; left -= a;
        out += await this.quote(p.parts[i], tokenIn, a, sp, tag);
      }
      return out;
    }
    const tokenOut = core.other(p, tokenIn).address;
    const zfo = BigInt(tokenIn) < BigInt(tokenOut);
    if (p.kind === "v2") {
      const r = new ethers.Interface(["function getReserves() view returns (uint112,uint112,uint32)"]);
      const raw = await sp.call({ to: p.address, data: r.encodeFunctionData("getReserves"), ...(tag ? { blockTag: tag } : {}) });
      const [r0, r1] = r.decodeFunctionResult("getReserves", raw);
      const [ri, ro] = zfo ? [r0, r1] : [r1, r0];
      return core.amountOut(amountIn, ri, ro, p.feePips);
    }
    if (!this.p1.quoter) throw new Error("sin Quoter desplegado");
    const q = new ethers.Interface(QUOTER.abi);
    const data = p.kind === "v3" ? q.encodeFunctionData("quoteV3", [p.address, zfo, amountIn])
      : q.encodeFunctionData("quoteV4", [p.manager, [p.native ? ethers.ZeroAddress : zfo ? tokenIn : tokenOut, zfo ? tokenOut : tokenIn, Number(p.feePips), p.tickSpacing, ethers.ZeroAddress], zfo, amountIn]); // ETH nativo: currency0 = address(0)
    const raw = await sp.call({ to: this.p1.quoter, data, ...(tag ? { blockTag: tag } : {}) });
    return q.decodeFunctionResult(p.kind === "v3" ? "quoteV3" : "quoteV4", raw)[0];
  }

  /** Despliega el Quoter una vez (contrato sin estado; ~$0.01 de gas). */
  async ensureQuoter() {
    if (this.p1.quoter) { try { if ((await this.provider.getCode(this.p1.quoter)) !== "0x") return; } catch { return; } }
    if (!this.wallet) return;
    try {
      const c = await this.withSender(async (w) => { const f = new ethers.ContractFactory(QUOTER.abi, QUOTER.bytecode, w); return f.deploy(); });
      await c.deploymentTransaction().wait();
      this.p1.quoter = await c.getAddress();
      await this.diag(`fase 1: Quoter desplegado en ${this.p1.quoter}`);
      await this.save();
    } catch (e) { await this.diag(`fase 1: no se pudo desplegar el Quoter: ${e.shortMessage || e.message}`); }
  }

  async refreshBalance() {
    if (this.wallet) { try { this.p1.balanceEth = Number(ethers.formatEther(await this.provider.getBalance(this.wallet.address))); } catch { /* red */ } }
  }
}

const HOP_T = "tuple(uint8,address,address,address,uint16,uint24,int24,bytes)";
function hopTuple(p, tokenIn, tokenOut) {
  if (p.kind === "v4") return [2, p.manager, tokenIn, tokenOut, 0, Number(p.feePips), p.tickSpacing, p.native ? ethers.AbiCoder.defaultAbiCoder().encode(["address"], [core.TOKENS.WETH.address]) : "0x"];
  return [p.kind === "v3" ? 1 : 0, p.address, tokenIn, tokenOut, p.kind === "v3" ? 0 : Math.min(65535, Math.round(p.feeBps)), 0, 0, "0x"];
}

function label(r) {
  let t = r.start; const parts = [t];
  for (const p of r.route) { const n = p.token0.sym === t ? p.token1.sym : p.token0.sym; parts.push(`${p.dex} → ${n}`); t = n; }
  return parts.join(" → ");
}

/**
 * Mensaje útil de un error de envío. ethers v6 envuelve los errores JSON-RPC que no sabe clasificar como
 * "could not coalesce error" y deja el mensaje real del nodo en e.error / e.info.error (p. ej. "gas tip cap … below
 * minimum" en Polygon): sin esto el log solo decía "could not coalesce error" y se probaban todos los RPC en vano.
 */
export function sendErrMsg(e) {
  const inner = e?.error?.message ?? e?.info?.error?.message ?? e?.info?.payload?.error?.message;
  const base = `${e?.shortMessage || e?.message || e}`;
  return inner && !base.includes(inner) ? `${base}: ${inner}` : base;
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
