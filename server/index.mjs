// Servicio 24/7 para Railway (o cualquier host con procesos continuos):
// corre el worker del protocolo sin parar y expone GET /api/stats para el panel de la página.
// No envía transacciones. Variables opcionales: RPC_URL, LT_HOURS (default 2), DATA_DIR, PORT.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import WebSocket from "ws";
import { runWorker, isAlive } from "../src/worker.js";
import { Executor } from "./executor.mjs";
import { Harvester } from "./harvester.mjs";
import { Liquidations } from "./liquidations.mjs";
import { Liquidator } from "./liquidator.mjs";
import { LpLending } from "./lplending.mjs";
import { RevertLend } from "./revertlend.mjs";
import { RevertLoan } from "./revertloan.mjs";
import { beefyWallet, beefyWalletLine, walletBalances, walletBalancesLine } from "./beefywallet.mjs";
import { beefyDashboard, beefyDashLine } from "./beefydash.mjs";
import { dcaCostReport } from "./dcacost.mjs";
import { RULES } from "./highapy.mjs";
import { auditWallet, auditLine } from "./walletaudit.mjs";
import { whitelist } from "./withdrawguard.mjs";
import { Strategy } from "./strategy.mjs";
import { Bridger, Topup, topupTargets, RemoteBridge } from "./bridge.mjs";
import { Sniper } from "./sniper.mjs";
import { EventFeed } from "./events.mjs";
import { FastLoop } from "./fastloop.mjs";
import { MempoolWatcher } from "./mempool.mjs";
import { addrCapFromError, callCapped } from "./logcap.mjs";
import * as core from "../src/core.js";
import { chainByKey, verifyChain } from "../src/chains.js";
import { pairTable, pairLine } from "../src/pairs.js";
import { beefyTop, beefyTopLine, beefyClmTokens, beefyClmVaults } from "./beefytop.mjs";
import { poolDepth, cashIn, publicRows } from "./depth.mjs";

// Histograma de motivos agrupado (los contadores persistidos traen claves antiguas con argumentos) y ordenado de mayor a menor.
function reasonsText(byReason) {
  const agg = {};
  for (const [k, n] of Object.entries(byReason || {})) { const kk = String(k).replace(/\(\s*-?\d+(?:\s*,\s*-?\d+)+\s*\)$/, ""); agg[kk] = (agg[kk] ?? 0) + n; }
  return Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(", ") || "—";
}

// Claves de proveedores (p. ej. NODEREAL_KEY) viven solo en variables de Railway: se tachan de todo lo que se escribe
// en los logs por si algún error de red incluye la URL completa.
const SECRETS = [process.env.NODEREAL_KEY, process.env.ALCHEMY_KEY].filter((x) => x && x.length >= 8);
const redact = (x) => (typeof x === "string" ? SECRETS.reduce((t, k) => t.split(k).join("***"), x) : x);
for (const fn of ["log", "warn", "error"]) { const orig = console[fn].bind(console); console[fn] = (...a) => orig(...a.map(redact)); }

// Cadena activa: CHAIN=base|polygon|bsc|arbitrum|optimism|robinhood (una instancia del servicio por cadena)
const CHAIN_CFG = chainByKey(process.env.CHAIN || "base");
// NodeReal (cuenta gratuita de Jose): solo el WebSocket de mempool (más rápido que los nodos públicos). Las lecturas
// de cada bloque siguen en los RPC públicos para no agotar los CU mensuales del plan gratuito.
const NODEREAL_SLUG = { bsc: "bsc-mainnet" }[CHAIN_CFG.key]; // polygon-mainnet.nodereal.io no resuelve (ENOTFOUND)
const NODEREAL_WS = process.env.NODEREAL_KEY && NODEREAL_SLUG ? `wss://${NODEREAL_SLUG}.nodereal.io/ws/v1/${process.env.NODEREAL_KEY}` : null;
core.applyChain(CHAIN_CFG);
const RPCS = [process.env.RPC_URL, ...CHAIN_CFG.rpcs].filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.resolve("data"));
const LT_HOURS = Number(process.env.LT_HOURS ?? 2);
const PORT = Number(process.env.PORT || 8080);
const CHAIN_ID = BigInt(CHAIN_CFG.id);
const EXECUTE_MODE = (process.env.EXECUTE_MODE || "simulate").toLowerCase() === "live" ? "live" : "simulate";
const AUTO_DEPLOY = process.env.AUTO_DEPLOY === "1";
// DCA_ONLY=1 (Jose, 2026-11-07): sin búsqueda de arbitraje, flashloans, liquidaciones, harvests, mempool ni eventos. Solo la
// estrategia de capital (DCA en Beefy), recargas entre cadenas y los reportes horarios; un ciclo liviano cada DCA_TICK_S (60 s).
const DCA_ONLY = process.env.DCA_ONLY === "1";
fs.mkdirSync(DATA_DIR, { recursive: true });
const VERSION = {
  commit: (process.env.RAILWAY_GIT_COMMIT_SHA || "local").slice(0, 7),
  message: (process.env.RAILWAY_GIT_COMMIT_MESSAGE || "").split("\n")[0].slice(0, 120),
  startedAt: Date.now(),
};

// ---------------------------------------------------------------- store en disco (JSON por clave, escritura atómica)
const cache = new Map();
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x)); // BigInt (p. ej. callReward de Beefy) → string
const file = (k) => path.join(DATA_DIR, `${k}.json`);
const store = {
  async get(k) {
    if (cache.has(k)) return structuredClone(cache.get(k));
    try { const v = JSON.parse(fs.readFileSync(file(k), "utf8")); cache.set(k, v); return structuredClone(v); } catch { return null; }
  },
  async set(k, v) {
    cache.set(k, structuredClone(v));
    const tmp = file(k) + ".tmp";
    fs.writeFileSync(tmp, J(v));
    fs.renameSync(tmp, file(k));
  },
};

async function diag(m) {
  m = redact(m);
  const list = (await store.get("diag")) ?? [];
  list.push({ t: Date.now(), m });
  await store.set("diag", list.slice(-30));
  console.log(new Date().toISOString(), m);
}

async function provider() {
  for (const url of RPCS) {
    try {
      const req = new ethers.FetchRequest(url);
      req.timeout = 15_000;
      const p = new ethers.JsonRpcProvider(req, Number(CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
      const id = BigInt(await p.send("eth_chainId", []));
      if (id !== CHAIN_ID) throw new Error(`chainId ${id}`);
      // el long tail necesita eth_getLogs: se descarta el RPC que no lo responde a tiempo
      if (LT_HOURS > 0) {
        const head = await p.getBlockNumber();
        await p.getLogs({ address: CHAIN_CFG.factories[0].address, fromBlock: head - 9, toBlock: head }); // 10 bloques: Alchemy limita el rango de eth_getLogs (400 con 500)
      }
      return { p, url };
    } catch (e) { console.warn("RPC falló", url, e.shortMessage || e.message); }
  }
  throw new Error(`ningún RPC de ${CHAIN_CFG.name} respondió`);
}

// ---------------------------------------------------------------- proveedor de eth_getLogs con respaldo
// Algunos nodos públicos (publicnode) devuelven 403 a eth_getLogs con muchas direcciones; se prueba otro.
function logsProviderFor(main, mainUrl) {
  const urls = [mainUrl, ...RPCS.filter((u) => u !== mainUrl)];
  const provs = new Map([[mainUrl, main]]);
  let idx = 0;
  const get = (u) => { if (!provs.has(u)) provs.set(u, new ethers.JsonRpcProvider(u, Number(CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 })); return provs.get(u); };
  const addrCap = new Map(); // url -> máximo de direcciones por eth_getLogs que acepta ese nodo (aprendido del error)
  return {
    async getLogs(filter, { timeoutMs = 6000 } = {}) {
      const errs = [];
      for (let i = 0; i < urls.length; i++) {
        const u = urls[(idx + i) % urls.length];
        try {
          const call = (f) => Promise.race([get(u).getLogs(f), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${Math.round(timeoutMs / 1000)} s`)), timeoutMs))]);
          const once = async () => {
            try { return await callCapped(call, filter, addrCap.get(u)); }
            catch (e) {
              const cap = addrCapFromError(e);
              if (!cap || addrCap.has(u) || !Array.isArray(filter.address) || filter.address.length <= cap) throw e;
              addrCap.set(u, cap); // reintenta en el mismo nodo respetando su límite
              return await callCapped(call, filter, cap);
            }
          };
          const r = await once();
          if (i) { idx = (idx + i) % urls.length; await diag(`vaults: eth_getLogs ahora vía ${new URL(u).host}`); }
          return r;
        } catch (e) {
          const body = e.info?.responseBody ?? e.error?.message ?? "";
          errs.push(`${new URL(u).host}: ${(e.shortMessage || e.message).slice(0, 40)}${body ? ` [${String(body).replace(/\s+/g, " ").slice(0, 90)}]` : ""}`);
        }
      }
      const err = new Error(errs.join(" · ")); err.shortMessage = errs.join(" · "); throw err;
    },
  };
}

// ---------------------------------------------------------------- bloques nuevos por WebSocket (con respaldo por sondeo)
// Despierta al worker en cuanto el nodo anuncia un bloque, en vez de preguntar cada segundo.
const WS_RPCS = (process.env.WS_RPC_URL ? [process.env.WS_RPC_URL] : []).concat(CHAIN_CFG.ws ?? []);
let wsWaiters = [];
let wsBlock = 0, wsAlive = false;
function blockWaiter(fallbackMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wsWaiters = wsWaiters.filter((w) => w !== resolve); resolve(); }, wsAlive ? Math.max(fallbackMs, 2500) : fallbackMs);
    wsWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}
async function wsLoop() {
  let i = 0, failures = 0;
  while (!stopping) {
    const url = WS_RPCS[i % WS_RPCS.length];
    try {
      // JSON-RPC crudo sobre el socket: eth_subscribe newHeads. Sin capas que puedan quedarse colgadas.
      const sock = new WebSocket(url);
      sock.on("error", () => {});
      await new Promise((res, rej) => { sock.once("open", res); sock.once("close", () => rej(new Error("cerrado al conectar"))); setTimeout(() => rej(new Error("tiempo de conexión")), 8000); });
      const subId = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("sin respuesta a eth_subscribe")), 8000);
        sock.once("message", (m) => { clearTimeout(t); try { const j = JSON.parse(m.toString()); j.result ? res(j.result) : rej(new Error(JSON.stringify(j.error ?? j).slice(0, 80))); } catch (e) { rej(e); } });
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      });
      wsAlive = true; failures = 0;
      await diag(`bloques: suscrito por WebSocket a ${new URL(url).host} (${subId.slice(0, 10)})`);
      await new Promise((resolve) => {
        let lastMsg = Date.now();
        sock.on("message", (m) => {
          lastMsg = Date.now();
          try { const j = JSON.parse(m.toString()); const h = j?.params?.result; if (h?.number) { wsBlock = Number(h.number); const w = wsWaiters; wsWaiters = []; for (const f of w) f(); } } catch { /* */ }
        });
        sock.on("close", resolve); sock.on("error", resolve);
        const watchdog = setInterval(() => { if (Date.now() - lastMsg > 30_000) { clearInterval(watchdog); try { sock.terminate(); } catch { /* */ } resolve(); } }, 5000); // sin bloques en 30 s: reconectar
        setTimeout(() => { clearInterval(watchdog); try { sock.close(); } catch { /* */ } resolve(); }, 6 * 3600_000);
      });
      await diag(`bloques: WebSocket ${new URL(url).host} cerrado; reconectando`);
    } catch (e) {
      failures++;
      if (failures <= WS_RPCS.length || failures % 20 === 0) await diag(`bloques: WebSocket ${new URL(url).host} falló (${(e.shortMessage || e.message).slice(0, 60)}); ${failures >= WS_RPCS.length ? "sondeo cada 1 s mientras tanto" : "siguiente"}`);
      i++;
    }
    wsAlive = false;
    await new Promise((r) => setTimeout(r, failures >= WS_RPCS.length ? 60_000 : 3000));
  }
}
// ---------------------------------------------------------------- bucle infinito
let stopping = false;
process.on("uncaughtException", (e) => { console.error("excepción no capturada:", e); diag(`servidor: excepción ${(e?.message || String(e)).slice(0, 100)}`).catch(() => {}); });
process.on("unhandledRejection", (e) => { console.error("promesa rechazada:", e); diag(`servidor: rechazo ${(e?.message || String(e)).slice(0, 100)}`).catch(() => {}); });
if (!DCA_ONLY) wsLoop();
const live = {}; // referencias en memoria del worker en curso (stats, vstats, events) para que el panel vea cada bloque
let executor = null;
let harvester = null;
let liquidations = null;
let liquidator = null;
let lpLending = null;
let revertLend = null;
let revertLoan = null; // préstamo propio en Revert Lend (RVL_LOAN_OPEN / RVL_LOAN_TOKENID), monitor cada minuto
let topups = []; // TOPUP_TARGETS / TOPUP_CHAIN: mantiene fondeadas otras cadenas desde Base (Relay)
let bridger = null; // BRIDGE_RUN: gas nativo de esta cadena → USDC en Base (Relay)
let remoteBridge = null; // BRIDGE_REMOTE: consolida en Base el nativo de otras cadenas (corre en el worker de Base)
let sniper = null; // radar de éxodos de TVL (doc 22); SNIPER=0 lo apaga
let strategy = null; // estrategia de capital (STRATEGY + STRATEGY_RUN), una ejecución por etiqueta
let fast = null;
let events = null;
// WebSocket para el estado por eventos: WS_EVENTS_URL, o el de Alchemy de la cadena (Base: pendingLogs de Flashblocks)
const ALCHEMY_WS_SLUG = { base: "base-mainnet", arbitrum: "arb-mainnet", optimism: "opt-mainnet", polygon: "polygon-mainnet", bsc: "bnb-mainnet", robinhood: "robinhood-mainnet" }[CHAIN_CFG.key];
const EVENTS_WS = process.env.WS_EVENTS_URL || (process.env.ALCHEMY_KEY && ALCHEMY_WS_SLUG ? `wss://${ALCHEMY_WS_SLUG}.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}` : process.env.WS_RPC_URL || CHAIN_CFG.ws?.[0] || null); // sin Alchemy: el primer WS público de la cadena
let mempool = null;
const FLASH_RPC = process.env.FLASH_RPC_URL || CHAIN_CFG.fastRpc || CHAIN_CFG.rpcs[0];
let chainVerified = false;
async function loop() {
  while (!stopping) {
    try {
      const { p, url } = await provider();
      await diag(`servidor: cadena ${CHAIN_CFG.name} (${CHAIN_CFG.id}) · RPC ${new URL(url).host}`);
      if (!chainVerified) {
        // verificación on-chain de las direcciones configuradas: lo que no responde se desactiva
        const { cfg, disabled } = await verifyChain(ethers, p, CHAIN_CFG);
        core.applyChain(cfg); chainVerified = true;
        await diag(`cadena: ${Object.keys(cfg.tokens).length} tokens, ${cfg.factories.length} factories, ${cfg.lenders.length} prestamistas verificados${disabled.length ? ` · desactivado: ${disabled.join(" · ")}` : ""}`);
      }
      const exec = new Executor({ provider: p, store, diag, mode: EXECUTE_MODE, autoDeploy: DCA_ONLY ? false : AUTO_DEPLOY });
      await exec.init();
      let nb = 0;
      executor = exec;
      if (DCA_ONLY) { await dcaOnlyLoop(exec, p); continue; }
      const hv = new Harvester({ provider: p, store, diag, executor: exec, mode: EXECUTE_MODE, logsProvider: logsProviderFor(p, url) });
      await hv.init();
      harvester = hv;
      const lq = new Liquidations({ provider: p, logsProvider: logsProviderFor(p, url), store, diag });
      await lq.init();
      liquidations = lq;
      const lx = new Liquidator({ provider: p, store, diag, executor: exec, liquidations: lq });
      await lx.init();
      liquidator = lx;
      lq.onCandidate = (cand, ctx) => lx.attempt(cand, ctx).catch(() => {});
      // préstamos con LP como colateral (Lista en BSC, Extra Finance en OP/Base): solo observación; una instancia para todas las tandas
      if (!lpLending) { lpLending = new LpLending({ provider: p, logsProvider: logsProviderFor(p, url), store, diag, ourAddress: () => executor?.p1?.executor ?? null }); await lpLending.init(); }
      else { lpLending.provider = p; lpLending.logs = logsProviderFor(p, url); }
      if (!revertLend) { revertLend = new RevertLend({ provider: p, logsProvider: logsProviderFor(p, url), store, diag }); await revertLend.init(); }
      else { revertLend.provider = p; revertLend.logs = logsProviderFor(p, url); }
      await ensureRevertLoan(exec, p).catch((e) => diag(`revert-préstamo: no arrancó · ${e.message}`));
      if (process.env.STRATEGY && process.env.STRATEGY_RUN) {
        if (!strategy) { strategy = new Strategy({ executor: exec, provider: p, store, diag }); await strategy.init(); }
        else { strategy.x = exec; strategy.provider = p; }
      }
      if (!topups.length) { for (const cfg of topupTargets()) { const t = new Topup({ executor: exec, provider: p, store, diag, cfg }); await t.init(); topups.push(t); } }
      else for (const t of topups) { t.x = exec; t.provider = p; }
      if (process.env.BRIDGE_RUN) {
        if (!bridger) { bridger = new Bridger({ executor: exec, provider: p, store, diag }); await bridger.init(); }
        else { bridger.x = exec; bridger.provider = p; }
      }
      if (process.env.FLASHBLOCKS !== "0") {
        // un solo bucle rápido: el de la tanda anterior se detiene (si no, se acumulan bucles con ejecutores y nonces propios)
        if (fast) { fast.stop(); fast.executor = exec; fast.start(); }
        else { fast = new FastLoop({ url: FLASH_RPC, executor: exec, diag }); fast.start(); await diag(`flashblocks: bucle rápido cada 250 ms vía ${new URL(FLASH_RPC).host} (estado pending)`); }
        if (!events && EVENTS_WS && process.env.EVENTS !== "0") {
          events = new EventFeed({ url: EVENTS_WS, fast, diag, pending: CHAIN_CFG.key === "base", fallbacks: (CHAIN_CFG.ws ?? []).filter((u) => u !== EVENTS_WS) });
          fast.events = events; events.start();
          await diag(`eventos: estado por WebSocket (${events.e.kind}) vía ${events.e.ws}; la lectura por RPC queda de respaldo`);
        }
      }
      if (CHAIN_CFG.publicMempool && process.env.MEMPOOL !== "0") {
        if (!mempool) { mempool = new MempoolWatcher({ wsUrls: [NODEREAL_WS, ...(CHAIN_CFG.ws ?? [])].filter(Boolean), executor: exec, diag }); mempool.start(); await diag(`mempool: escuchando transacciones pendientes vía ${mempool.m.ws ?? "—"} (${mempool.routers.size} routers)`); }
        else mempool.executor = exec;
      }
      const onBlock = async (ctx) => {
        nb++; if (nb % 300 === 0) await exec.refreshBalance();
        if (fast) { if (fast.main !== ctx.pools) fast.setUniverse(ctx.pools, live.cycles ?? []); fast.setContext({ gas: ctx.gas, ethUsd: ctx.ethUsd, lenders: ctx.lenders }); }
        if (mempool) { if (mempool.main !== ctx.pools) mempool.setUniverse(ctx.pools, live.cycles ?? []); mempool.setContext({ gas: ctx.gas, ethUsd: ctx.ethUsd, lenders: ctx.lenders }); }
        const text = await exec.onBlock(ctx);
        hv.onBlock(ctx).catch((e) => { hv.h.lastError = e.shortMessage || e.message; }); // en paralelo: no retrasa el siguiente bloque
        lq.onBlock(ctx).catch((e) => { lq.liq.aave.error = e.shortMessage || e.message; });
        if (process.env.LP_LENDING !== "0") lpLending?.onBlock(ctx).catch(() => {});
        revertLend?.onBlock(ctx).catch(() => {});
        strategy?.onBlock(ctx).catch(() => {});
        bridger?.onBlock(ctx).catch(() => {});
        for (const t of topups) t.onBlock(ctx).catch(() => {});
        if (lx.x.pending.length) lx.reconcile(ctx.ethUsd).catch(() => {});
        return text;
      };
      // tandas de 1 h: el universo se refresca solo (lo guarda 30 min)
      const { stats } = await runWorker({ ethers, provider: p, store, deadlineMs: Date.now() + 3600_000, ltHours: LT_HOURS, log: (m) => diag(`worker: ${m}`), onBlock, live, logsProvider: logsProviderFor(p, url), waitBlock: blockWaiter });
      await diag(`servidor: tanda terminada · ${stats.blocksProcessed} bloques · ${stats.totals.episodes} oportunidades`);
    } catch (e) {
      await diag(`servidor: error ${e.shortMessage || e.message}; reintento en 20 s`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}

/** Modo solo DCA: estrategia, puentes y recargas con un ctx mínimo ({ethUsd} del nativo vía api.beefy.finance), una tanda de 1 h. */
const NATIVE_ORACLE = { bsc: "BNB", polygon: "POL" };
let nativeUsdCache = { at: 0, v: null };
async function nativeUsd() {
  if (Date.now() - nativeUsdCache.at < 5 * 60_000 && nativeUsdCache.v) return nativeUsdCache.v;
  try {
    const j = await (await fetch("https://api.beefy.finance/prices", { signal: AbortSignal.timeout(15_000) })).json();
    const k = NATIVE_ORACLE[CHAIN_CFG.key] ?? "ETH"; const v = Number(j[k] ?? j["W" + k] ?? NaN);
    if (Number.isFinite(v) && v > 0) nativeUsdCache = { at: Date.now(), v };
  } catch {}
  return nativeUsdCache.v;
}
async function ensureRevertLoan(exec, p) {
  if (CHAIN_CFG.key !== "base" || process.env.RVL_LOAN === "0") return;
  if (!revertLoan) {
    if (!process.env.RVL_LOAN_OPEN && !process.env.RVL_LOAN_TOKENID && !(await store.get("rvloan"))?.tokenId) return;
    revertLoan = new RevertLoan({ executor: exec, provider: p, store, diag }); await revertLoan.init(); revertLoan.start();
    await diag(`revert-préstamo: activo · ${revertLoan.s.tokenId ? `vigila #${revertLoan.s.tokenId}` : `apertura ${revertLoan.cfg.tag} (~$${revertLoan.cfg.usd})`} · cada ${revertLoan.cfg.everyS} s`);
  } else { revertLoan.x = exec; revertLoan.provider = p; }
}
async function dcaOnlyLoop(exec, p) {
  if (process.env.STRATEGY && process.env.STRATEGY_RUN) {
    if (!strategy) { strategy = new Strategy({ executor: exec, provider: p, store, diag }); await strategy.init(); }
    else { strategy.x = exec; strategy.provider = p; }
  }
  if (!topups.length) { for (const cfg of topupTargets()) { const t = new Topup({ executor: exec, provider: p, store, diag, cfg }); await t.init(); topups.push(t); } }
  else for (const t of topups) { t.x = exec; t.provider = p; }
  if (process.env.BRIDGE_RUN) {
    if (!bridger) { bridger = new Bridger({ executor: exec, provider: p, store, diag }); await bridger.init(); }
    else { bridger.x = exec; bridger.provider = p; }
  }
  if (process.env.BRIDGE_REMOTE) { if (!remoteBridge) { remoteBridge = new RemoteBridge({ executor: exec, store, diag }); await remoteBridge.init(); } else remoteBridge.x = exec; }
  if (!sniper) { sniper = new Sniper({ provider: p, store, diag, chainKey: CHAIN_CFG.key }); await sniper.init(); }
  else sniper.p = p;
  if (strategy) strategy.sniper = sniper; // F1–F3: la estrategia ejecuta lo que detecta el radar (SNIPER_TRADE=1)
  await ensureRevertLoan(exec, p).catch((e) => diag(`revert-préstamo: no arrancó · ${e.message}`));
  await diag(`servidor: modo solo DCA (sin arbitraje, flashloans, liquidaciones, harvests, mempool ni eventos) · estrategia ${strategy ? `${strategy.kind} ${process.env.STRATEGY_VAULT_ID ?? ""}` : "—"}${process.env.DCA_EXTRA ? ` + extra ${process.env.DCA_EXTRA}` : ""} · recargas ${topups.length} · puente ${bridger ? "sí" : "no"}`);
  const until = Date.now() + 3600_000, tick = Math.max(15, Number(process.env.DCA_TICK_S ?? 60)) * 1000;
  let n = 0, lastTickErr = null;
  while (!stopping && Date.now() < until) {
    const ethUsd = await nativeUsd();
    const ctx = { ethUsd, dcaOnly: true };
    if (++n % 60 === 0) await exec.refreshBalance().catch(() => {});
    const rs = await Promise.allSettled([strategy?.onBlock(ctx), bridger?.onBlock(ctx), ...topups.map((t) => t.onBlock(ctx))].filter(Boolean));
    sniper?.onBlock(ctx).catch(() => {}); // en paralelo: el radar no frena el DCA
    remoteBridge?.onBlock().catch(() => {});
    for (const x of rs) if (x.status === "rejected") { const m = String(x.reason?.shortMessage || x.reason?.message || x.reason).slice(0, 200); if (m !== lastTickErr) { lastTickErr = m; await diag(`ciclo DCA: error no controlado · ${m}`); } }
    await new Promise((r) => setTimeout(r, tick));
  }
}

// ---------------------------------------------------------------- API para el panel
const DEFAULT_STATS_URLS = "base=https://worker-production-1950.up.railway.app/api/stats,polygon=https://worker-polygon-production.up.railway.app/api/stats,bsc=https://worker-bsc-production.up.railway.app/api/stats,arbitrum=https://worker-arbitrum-production.up.railway.app/api/stats,optimism=https://worker-optimism-production.up.railway.app/api/stats,robinhood=https://worker-robinhood-production.up.railway.app/api/stats";
const server = http.createServer(async (req, res) => {
  const headers = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (req.url.startsWith("/api/stats")) {
    const stats = live.stats ?? (await store.get("stats"));
    const events = live.events ? live.events() : ((await store.get("events")) ?? []);
    const diagLog = ((await store.get("diag")) ?? []).slice(-8).reverse();
    if (!stats) { res.writeHead(200, headers); return res.end(JSON.stringify({ ready: false, diag: diagLog, now: Date.now(), host: "railway", version: VERSION })); }
    const topRoutes = Object.values(stats.byRoute ?? {}).sort((a, b) => b.netUsd - a.netUsd).slice(0, 10);
    const vaults = live.vstats ? JSON.parse(J(live.vstats)) : ((await store.get("vaults")) ?? null);
    const phase1 = executor?.p1 ?? (await store.get("phase1")) ?? null;
    const harvest = harvester?.h ?? (await store.get("harvest")) ?? null;
    if (harvest && harvester?.hist) {
      const xs = Object.values(harvester.hist.strats).filter((x) => x.n >= 2);
      harvest.history = { days: harvester.hist.days, withData: xs.length, intervalMedH: xs.length ? [...xs.map((x) => x.intervalMed)].sort((a, b) => a - b)[Math.floor(xs.length / 2)] / 3600 : null,
        top: xs.map((x) => ({ id: x.id, n: x.n, intervalH: x.intervalMed / 3600, callFeeMedUsd: x.callFeeMedWei !== null ? x.callFeeMedWei / 1e18 : null, topHarvester: x.topHarvester, harvesters: x.harvesters })).sort((a, b) => (b.callFeeMedUsd ?? 0) - (a.callFeeMedUsd ?? 0)).slice(0, 15) };
    }
    const liq = liquidations?.liq ?? (await store.get("liq")) ?? null;
    const liqExec = liquidator?.x ?? (await store.get("liqExec")) ?? null;
    const fastStats = fast?.f ?? null;
    if (vaults) {
      vaults.topManagers = Object.values(vaults.byManager ?? {}).sort((a, b) => b.events - a.events).slice(0, 12);
      delete vaults.byManager;
    }
    const { open, byRoute, ...rest } = stats;
    res.writeHead(200, headers);
    return res.end(J({ ready: true, alive: isAlive(stats, Date.now()), now: Date.now(), host: "railway", chain: { key: core.CHAIN.key, name: core.CHAIN.name, id: core.CHAIN.id, native: core.CHAIN.native, publicMempool: core.CHAIN.publicMempool, tokens: Object.fromEntries(Object.entries(core.TOKENS).map(([k, t]) => [k, t.label])) }, ...rest, version: VERSION, openEpisodes: Object.keys(open ?? {}).length, topRoutes, recent: events.slice(-25).reverse(), diag: diagLog, vaults, phase1, harvest, liq, liqExec, lpLending: lpLending?.s ?? null, revertLend: revertLend?.s ?? null, strategy: strategy?.s ?? null, bridge: bridger?.s ?? null, topup: topups[0]?.s ?? null, topups: Object.fromEntries(topups.map((t) => [t.chainKey, t.s])), fast: fastStats, disloc: live.disloc ? live.disloc() : null }));
  }
  if (req.url.startsWith("/api/depth") || req.url.startsWith("/api/cashin")) {
    try {
      if (!live.pools) { res.writeHead(503, headers); return res.end(JSON.stringify({ error: "universo no listo" })); }
      const ethUsd = core.referenceEthUsd(live.pools);
      const rows = poolDepth(live.pools, ethUsd);
      if (req.url.startsWith("/api/depth")) { res.writeHead(200, headers); return res.end(JSON.stringify({ chain: CHAIN_CFG.key, ethUsd, pools: publicRows(rows).sort((a, b) => b.sellUsd["2%"] - a.sellUsd["2%"]) })); }
      const q = new URL(req.url, "http://x").searchParams;
      const minTvl = q.has("minTvl") ? Number(q.get("minTvl")) : 20_000;
      const vaults = (await beefyClmVaults(CHAIN_CFG.key)).filter((v) => v.tvlUsd >= minTvl);
      res.writeHead(200, headers); return res.end(JSON.stringify({ chain: CHAIN_CFG.key, ethUsd, minTvl, vaults: cashIn(vaults, rows) }));
    } catch (e) { res.writeHead(500, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/api/lp-lending")) {
    const s = lpLending?.s ?? (await store.get("lpl")) ?? null;
    const r = revertLend?.s ?? (await store.get("rvl")) ?? null;
    res.writeHead(200, headers); return res.end(J({ chain: CHAIN_CFG.key, line: lpLending?.line() ?? null, revertLine: revertLend?.active ? revertLend.line() : null, ...(s ?? {}), revertLend: r }));
  }
  if (req.url.startsWith("/api/dca-report")) {
    const h = (await store.get("beefyWalletHist")) ?? [];
    const st = strategy?.s ?? (await store.get("strategy")) ?? null;
    const sc = strategy?.lastScan;
    const auto = process.env.STRATEGY_VAULT_ID === "auto" && strategy ? { rules: RULES(), dynamic: strategy.dynamic, compound: strategy.compound,
      candidates: (sc?.eligible ?? []).slice(0, 8).map((x) => ({ id: x.id, apyPct: x.apyPct, tvl: x.tvl })), scannedAt: sc?.at ?? null,
      byId: sc ? Object.fromEntries(Object.entries(sc.byId ?? {}).filter(([id]) => Object.values(st?.dca ?? {}).some((d) => d?.holdings?.[id])).map(([id, v]) => [id, { apyPct: v.apyPct, tvl: v.tvl }])) : {} } : null;
    const runs = Object.entries(st?.runs ?? {}).map(([label, r]) => ({ label, kind: r.kind, status: r.status, startedAt: r.startedAt, error: r.error ?? null, vault: r.vaultId ?? r.id ?? null,
      usdcIn: r.usdcIn ?? null, usdcOut: r.usdcOut ?? null, txs: (r.txs ?? []).map((t) => (typeof t === "string" ? { hash: t } : { step: t.step ?? t.name ?? null, hash: t.hash ?? null })) })).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 30);
    res.writeHead(200, headers); return res.end(J({ chain: CHAIN_CFG.key, explorer: CHAIN_CFG.explorer ?? null, strategy: strategy ? { kind: strategy.kind, label: strategy.label, vaultId: process.env.STRATEGY_VAULT_ID ?? null, dcaUsd: strategy.dcaUsdCfg ?? null, everyH: Number(process.env.DCA_EVERY_H ?? 24), stableSym: strategy.net?.stableSym ?? null, stableDec: strategy.net?.stableDec ?? null } : null, auto, runs, dca: st?.dca ?? null, topup: topups[0]?.s ?? (await store.get("topup")) ?? null, topups: Object.fromEntries(topups.map((t) => [t.chainKey, t.s])), snapshots: h.slice(-24 * 7),
      cost: strategy?.lastCost ?? null, pnl: strategy?.lastStrategy ?? null, pnlHist: ((await store.get("dcaStrategyHist").catch(() => null)) ?? []).slice(-24 * 30) }));
  }
  if (req.url.startsWith("/api/withdraw-audit")) {
    const addr = (process.env.BEEFY_WALLETS || executor?.p1?.wallet || "").split(",")[0];
    try { res.writeHead(200, headers); return res.end(J({ guard: { whitelist: whitelist(), blocked: executor?.guard?.blocked ?? [] }, audit: lastAudit ?? (lastAudit = await auditWallet(addr, { whitelist: whitelist(), provider: executor?.provider })) })); }
    catch (e) { res.writeHead(502, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/api/wallet-balances")) {
    const addr = new URL(req.url, "http://x").searchParams.get("address") || (process.env.BEEFY_WALLETS || executor?.p1?.wallet || "").split(",")[0];
    try { res.writeHead(200, headers); return res.end(J(await walletBalances(addr, { provider: executor?.provider }))); }
    catch (e) { res.writeHead(502, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/api/portfolio")) {
    const since = Number(new URL(req.url, "http://x").searchParams.get("since")) || 0;
    try {
      const p = await portfolioNow();
      const series = ((await store.get("portfolioSeries")) ?? []).filter((x) => x.t > since);
      res.writeHead(200, headers); return res.end(J({ ...p, series, hourly: since ? [] : ((await store.get("beefyWalletHist")) ?? []).slice(-24 * 30).map((x) => ({ t: new Date(x.at).getTime(), total: x.totalUsd, pos: Object.fromEntries((x.positions ?? []).map((q) => [q.id, q.valueUsd])), apy: Object.fromEntries((x.positions ?? []).map((q) => [q.id, q.apyPct])) })) }));
    } catch (e) { res.writeHead(502, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/posiciones") || req.url === "/" || req.url.startsWith("/index.html") || req.url.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    const urls = process.env.STATS_URLS || DEFAULT_STATS_URLS;
    return res.end(fs.readFileSync(new URL("./portfolio.html", import.meta.url), "utf8").replace('<meta name="viewport"', `<meta name="stats-urls" content="${urls}">\n<meta name="viewport"`));
  }
  if (req.url.startsWith("/posiciones-v1")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    const urls = process.env.STATS_URLS || DEFAULT_STATS_URLS;
    return res.end(fs.readFileSync(new URL("./positions.html", import.meta.url), "utf8").replace('<meta name="viewport"', `<meta name="stats-urls" content="${urls}">\n<meta name="viewport"`));
  }
  if (req.url.startsWith("/api/beefy-dashboard")) {
    // espejo del dashboard de Beefy; caché de 2 min por dirección
    const q = new URL(req.url, "http://x").searchParams;
    const addr = (q.get("address") || (process.env.BEEFY_WALLETS || executor?.p1?.wallet || "").split(",")[0]).toLowerCase();
    try {
      const c = beefyDashCache.get(addr);
      const d = c && Date.now() - c.at < 120_000 && !q.has("fresh") ? c.d : await beefyDashboard(addr, { provider: executor?.provider });
      if (!c || c.d !== d) beefyDashCache.set(addr, { at: Date.now(), d });
      res.writeHead(200, headers); return res.end(J(d));
    } catch (e) { res.writeHead(502, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/api/beefy-wallet")) {
    const q = new URL(req.url, "http://x").searchParams;
    const addr = q.get("address") || executor?.p1?.wallet;
    try { res.writeHead(200, headers); return res.end(J(await beefyWallet(addr, { provider: executor?.provider }))); }
    catch (e) { res.writeHead(502, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/api/needs")) {
    res.writeHead(200, headers); return res.end(JSON.stringify(strategy?.fundingNeed?.() ?? { needUsd: 0 }));
  }
  if (req.url.startsWith("/api/revert-loan")) {
    res.writeHead(200, headers); return res.end(J(revertLoan ? revertLoan.view() : { ready: false }));
  }
  if (req.url.startsWith("/api/sniper")) {
    res.writeHead(200, headers); return res.end(JSON.stringify(sniper ? sniper.view() : { ready: false }));
  }
  if (req.url.startsWith("/api/beefy-tokens")) {
    const q = new URL(req.url, "http://x").searchParams;
    try { res.writeHead(200, headers); return res.end(JSON.stringify(await beefyClmTokens(q.get("chain") || "robinhood"))); }
    catch (e) { res.writeHead(502, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/api/beefy-top")) {
    const q = new URL(req.url, "http://x").searchParams;
    try {
      const r = await beefyTop({ n: Math.min(100, Number(q.get("n")) || 10), minTvl: q.has("minTvl") ? Number(q.get("minTvl")) : 50_000, chain: q.get("chain") || null, includeEol: q.get("includeEol") === "1" });
      res.writeHead(200, headers); return res.end(JSON.stringify(r));
    } catch (e) { res.writeHead(502, headers); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (req.url.startsWith("/health")) { res.writeHead(200, headers); return res.end(JSON.stringify({ ok: true })); }
  if (req.url.startsWith("/arbitraje")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    // tablero anterior de arbitraje con flashloan (sustituido en / por el panel de posiciones); selector de cadenas: cada servicio de Railway expone su /api/stats; esta página los lee todos
    const urls = process.env.STATS_URLS || DEFAULT_STATS_URLS;
    const html = fs.readFileSync(new URL("./dashboard.html", import.meta.url), "utf8").replace('<meta name="viewport"', `<meta name="stats-urls" content="${urls}">\n<meta name="viewport"`);
    return res.end(html);
  }
  res.writeHead(404, headers); res.end("{}");
});
server.listen(PORT, () => console.log(`API en :${PORT}, datos en ${DATA_DIR}`));
process.on("SIGTERM", () => { stopping = true; server.close(); setTimeout(() => process.exit(0), 2000); });
loop();
// autocomprobación del frontend público: deja constancia en los logs de que / y /api/stats responden
const PUBLIC = process.env.RAILWAY_PUBLIC_DOMAIN;
if (PUBLIC) setTimeout(async () => {
  for (const path of ["/", "/api/stats"]) {
    try {
      const r = await fetch(`https://${PUBLIC}${path}`, { signal: AbortSignal.timeout(10_000) });
      const body = await r.text();
      console.log(`${new Date().toISOString()} autocomprobación ${path}: HTTP ${r.status} · ${r.headers.get("content-type")} · ${body.length} bytes${path === "/" ? (body.includes("Panel de posiciones") ? " · panel OK" : " · ¡no es el panel!") : ""}`);
    } catch (e) { console.log(`${new Date().toISOString()} autocomprobación ${path}: falló ${e.message}`); }
  }
}, 8_000);
// top de vaults de Beefy por APY en los logs (al arrancar y cada 6 h), solo en el servicio de Base
if (CHAIN_CFG.key === "base") {
  const logBeefy = async () => {
    for (const minTvl of [50_000, 0]) {
      try { const r = await beefyTop({ n: 10, minTvl }); console.log(`${new Date().toISOString()} beefy top APY (TVL ≥ $${minTvl}, ${r.eligible} elegibles): ${beefyTopLine(r)}`); }
      catch (e) { console.log(`${new Date().toISOString()} beefy top APY: error ${e.message}`); }
    }
    try {
      const toks = await beefyClmTokens("robinhood");
      console.log(`${new Date().toISOString()} beefy tokens CLM robinhood (${toks.length}): ${toks.map((t) => `${t.symbol} ${t.address} [${t.vaults.filter((v) => v.status === "active").map((v) => `${v.name} ${v.apyPct}% $${v.tvlUsd}`).join("; ")}]`).join(" | ")}`);
    } catch (e) { console.log(`${new Date().toISOString()} beefy tokens: error ${e.message}`); }
  };
  setTimeout(logBeefy, 15_000); setInterval(logBeefy, 6 * 3600_000);
}
// profundidad y cash in de los CLM de Beefy de esta cadena (a los 6 min del arranque y cada 6 h)
async function logCashIn() {
  try {
    if (!live.pools) return;
    const ethUsd = core.referenceEthUsd(live.pools);
    const rows = poolDepth(live.pools, ethUsd);
    const vs = cashIn((await beefyClmVaults(CHAIN_CFG.key)).filter((v) => v.tvlUsd >= 20_000), rows);
    const f = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
    console.log(`${new Date().toISOString()} cashin ${CHAIN_CFG.key} (CLM Beefy TVL ≥ $20k: ${vs.length}; prof. venta 1/2/5 % en USD; por depósito $1k/$5k/$25k: costo entrada+salida, $/día, días para recuperar): ` +
      vs.map((v) => v.watched ? `${v.vault} ${v.apyPct}% TVL ${f(v.tvlUsd)} [${v.dex} ${v.feeBps}bps, ${v.poolsOfPair} pools] prof ${f(v.sellDepthUsd["1%"])}/${f(v.sellDepthUsd["2%"])}/${f(v.sellDepthUsd["5%"])} · ${v.bySize.map((s) => `$${f(s.depositUsd)}: ${(s.entryCostUsd + s.exitCostUsd).toFixed(0)}/${s.dailyUsd}/${s.breakevenDays}d (APY ${s.effectiveApyPct}%)`).join(" ")}` : `${v.vault} ${v.apyPct}% TVL ${f(v.tvlUsd)} [par no vigilado]`).join(" | "));
  } catch (e) { console.log(`${new Date().toISOString()} cashin: error ${e.message}`); }
}
if (!DCA_ONLY) setTimeout(logCashIn, 6 * 60_000);
// posiciones de la(s) wallet(s) en Beefy: a los 2 min y cada BEEFY_WALLET_EVERY_MIN (60) minutos (solo Base);
// guarda la serie (30 días) para seguir el depósito diario: /api/dca-report
let lastAudit = null;
const beefyDashCache = new Map();
async function logBeefyWallets() {
  if (CHAIN_CFG.key !== "base") return;
  const list = (process.env.BEEFY_WALLETS || executor?.p1?.wallet || "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const a of list) {
    try {
      try { console.log(`${new Date().toISOString()} ${walletBalancesLine(await walletBalances(a, { provider: executor?.provider }))}`); } catch (e) { console.log(`${new Date().toISOString()} saldos wallet ${a}: error ${e.message}`); }
      try { lastAudit = await auditWallet(a, { whitelist: whitelist(), provider: executor?.provider }); console.log(`${new Date().toISOString()} ${auditLine(lastAudit)} · lista blanca: ${whitelist().join(", ") || "(vacía: solo la propia wallet)"}`); } catch (e) { console.log(`${new Date().toISOString()} auditoría retiros ${a}: error ${e.message}`); }
      const r = await beefyWallet(a, { provider: executor?.provider });
      console.log(`${new Date().toISOString()} ${beefyWalletLine(r)}`);
      try { const d = await beefyDashboard(a, { provider: executor?.provider }); beefyDashCache.set(a.toLowerCase(), { at: Date.now(), d }); console.log(`${new Date().toISOString()} ${beefyDashLine(d)}`); }
      catch (e) { console.log(`${new Date().toISOString()} beefy dashboard ${a}: error ${e.message}`); }
      if (r.recent?.length) console.log(`${new Date().toISOString()} beefy movimientos 72 h ${a}: ` + r.recent.map((e) => `${e.at} [${e.chain}] ${e.id} ${e.action ?? ""} ${Number.isFinite(e.usd) ? (e.usd >= 0 ? "+" : "") + e.usd.toFixed(2) + " USD" : ""} tx ${e.tx ?? "?"}`).join(" | "));
      const h = (await store.get("beefyWalletHist")) ?? [];
      h.push({ at: r.at, address: r.address, totalUsd: r.totalUsd, prices: r.prices, positions: r.positions.map((p) => ({ id: p.id, chain: p.chain, valueUsd: p.valueUsd !== null ? +p.valueUsd.toFixed(4) : null, apyPct: p.apyPct, tvlUsd: p.tvlUsd })) });
      while (h.length > 24 * 30) h.shift();
      await store.set("beefyWalletHist", h);
    } catch (e) { console.log(`${new Date().toISOString()} beefy wallet ${a}: error ${e.message}`); }
  }
}
// panel de posiciones: posiciones de Beefy + saldos libres en caché (a lo más una lectura por PORTFOLIO_TTL_S, 60 s, con visitas;
// sin visitas, una cada PORTFOLIO_EVERY_MIN, 5 min) y serie de 5 min de 7 días para las gráficas: /api/portfolio
const PORTFOLIO_TTL = Math.max(20, Number(process.env.PORTFOLIO_TTL_S ?? 60)) * 1000;
const pf = { data: null, at: 0, busy: null, lastSaved: 0 };
async function refreshPortfolio() {
  const a = (process.env.BEEFY_WALLETS || executor?.p1?.wallet || executor?.wallet?.address || "").split(",").map((x) => x.trim()).filter(Boolean)[0];
  if (!a) throw new Error("sin wallet configurada");
  const [wallet, balances] = await Promise.all([beefyWallet(a, { provider: executor?.provider }), walletBalances(a, { provider: executor?.provider }).catch((e) => ({ error: e.message }))]);
  pf.data = { at: wallet.at, address: wallet.address, wallet, balances, ttlS: PORTFOLIO_TTL / 1000 }; pf.at = Date.now();
  if (pf.at - pf.lastSaved >= 4.5 * 60_000) {
    pf.lastSaved = pf.at;
    const ser = (await store.get("portfolioSeries")) ?? [];
    ser.push({ t: pf.at, total: wallet.totalUsd, free: balances?.totalUsd ?? null, pos: Object.fromEntries(wallet.positions.map((q) => [q.id, q.valueUsd !== null ? +q.valueUsd.toFixed(4) : null])), apy: Object.fromEntries(wallet.positions.map((q) => [q.id, q.apyPct])) });
    while (ser.length > 12 * 24 * 7) ser.shift();
    await store.set("portfolioSeries", ser);
  }
  return pf.data;
}
async function portfolioNow() {
  if (pf.data && Date.now() - pf.at < PORTFOLIO_TTL) return pf.data;
  const job = pf.busy ??= refreshPortfolio().finally(() => { pf.busy = null; });
  if (pf.data) { job.catch(() => {}); return pf.data; } // responde con lo último y actualiza en segundo plano
  return job;
}
if (CHAIN_CFG.key === "base") { setTimeout(() => portfolioNow().catch(() => {}), 3 * 60_000); setInterval(() => { if (Date.now() - pf.at >= Number(process.env.PORTFOLIO_EVERY_MIN ?? 5) * 60_000) portfolioNow().catch((e) => console.log(`${new Date().toISOString()} portafolio: error ${e.message}`)); }, 60_000); }
// costo del DCA (precio promedio de entrada y PnL = precio + comisiones + rango/IL): cada hora en el worker que hace el DCA
async function logDcaCost() {
  if (!strategy || strategy.kind !== "beefy-clm-dca" || !strategy.x?.wallet) return;
  try { for (const l of await dcaCostReport(strategy, { ethUsd: strategy.lastCtx?.ethUsd ?? null })) console.log(`${new Date().toISOString()} ${l}`); }
  catch (e) { console.log(`${new Date().toISOString()} dca costo: error ${e.message}`); }
}
setTimeout(logDcaCost, 4 * 60_000);
setInterval(logDcaCost, 60 * 60_000);
setTimeout(logBeefyWallets, 2 * 60_000);
setInterval(logBeefyWallets, Number(process.env.BEEFY_WALLET_EVERY_MIN ?? 60) * 60_000);
if (!DCA_ONLY) setInterval(logCashIn, 6 * 3600_000);
// resumen periódico en los logs de Railway (no en modo solo DCA: no hay arbitraje que resumir)
setInterval(async () => {
  if (DCA_ONLY) return;
  const st = await store.get("stats");
  const p1 = executor?.p1;
  const vs = live.vstats;
  let dxText = "";
  if (mempool) { const m = mempool.m; dxText += ` · mempool ${m.connected ? "conectado" : "desconectado"} (${m.ws}): ${m.seen} vistas, ${m.routerTxs} a routers, ${m.decoded} decodificadas, ${m.modeled} modeladas, ${m.profitable} con back-run rentable, ${m.bundles} bundles${m.badSkipped ? `, ${m.badSkipped} víctimas descartadas (${Object.entries(m.badVictims ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}${m.jit ? `; jit (obs.): ${m.jit.evaluated} evaluados, ${m.jit.positive} con neto>0, suma $${m.jit.sumNetUsd.toFixed(2)}${m.jit.best ? `, mejor $${m.jit.best.netUsd} (${m.jit.best.pool}, swap $${m.jit.best.swapUsd})` : ""}` : ""}${m.unknownTo ? `; destinos no decodificados: ${Object.entries(m.unknownTo).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, n]) => `${a.slice(0, 10)}… ${n}`).join(", ")}` : ""}${m.firstBy ? `; primero en avisar: ${Object.entries(m.firstBy).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}${m.hashesBy ? `; solo hashes: ${Object.entries(m.hashesBy).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}${m.lastError ? ` (${m.errors ?? 0} errores; último: ${m.lastError})` : ""}`; }
  if (live.disloc) {
    const x = live.disloc();
    const top = x.top.slice(0, 4).map((r) => r.pair + " " + r.episodes + "ep/" + (r.share * 100).toFixed(0) + "%/med " + r.medianDur + "b/pico " + r.peakExcess + "bps/rentables " + r.captured).join(", ");
    dxText += " · desajustes: " + x.pairsTracked + " pares, " + x.episodes + " episodios, " + x.persistent + " persistentes, " + x.moves + " saltos, " + x.open.length + " abiertos" + (top ? "; top " + top : "");
  }
  if (st) console.log(`${new Date().toISOString()} resumen: bloque ${st.lastBlock} · ${st.blocksProcessed} bloques · ${st.totals.episodes} oportunidades · neto modelo $${st.totals.netUsd.toFixed(2)} (${core.PHANTOM_ROUTES.size} rutas fantasma excluidas${p1?.phantomSkipped ? `, ${p1.phantomSkipped} sims evitadas` : ""}${p1?.staleAtSim ? `, ${p1.staleAtSim} cerradas al simular` : ""}) · fase ${st.phase}${p1 ? ` · fase1 ${p1.mode}: ${p1.simulated} sim, ${p1.wouldSucceed} ok, ${p1.wouldRevert} rev (${reasonsText(p1.byReason)}), neto sim $${p1.projectedNetUsd.toFixed(4)}, enviadas ${p1.sent} (${p1.confirmed} confirmadas, ${p1.reverted} revertidas${p1.bundles ? `, ${p1.bundles} bundles/${p1.bundlesMissed ?? 0} no incluidos${p1.bundlesReverted ? `/${p1.bundlesReverted} revierten en builders` : ""}${p1.bundlesExpired ? `/${p1.bundlesExpired} vencidos reenviados` : ""}${p1.direct ? `/${p1.direct} directos (sin simular)` : ""}` : ""}, realizado $${p1.realizedUsd.toFixed(4)}, gas pagado $${p1.gasPaidUsd.toFixed(4)}${p1.lostWhy ? `, reverts: ${p1.lostWhy.sameBlock} mismo bloque/${p1.lostWhy.late} tarde${p1.lostWhy.unknown ? `/${p1.lostWhy.unknown} sin dato` : ""}` : ""})${p1.skips && Object.keys(p1.skips).length ? `, omitidas: ${Object.entries(p1.skips).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("/")}` : ""}${p1.ladderMs ? `, escalera ${p1.ladderMs} ms` : ""}${p1.paused ? " PAUSADA" : ""}${p1.shadow?.checked ? ` · sombra ${p1.shadow.checked} ok sin enviar re-simuladas al bloque siguiente: ${p1.shadow.alive} seguían abiertas ($${p1.shadow.aliveNetUsd.toFixed(2)}), ${p1.shadow.closed} cerradas` : ""}` : ""}${vs ? ` · vaults ${(vs.events.rebalanceo + vs.events.zap + vs.events.salida)} eventos, ${vs.withOpp} con EV+, $${vs.netUsd.toFixed(2)}${vs.lastError ? ` (error: ${vs.lastError})` : ""}` : ""}${liquidations ? ` · liquidaciones: Aave ${liquidations.liq.aave.borrowers} prestatarios, ${liquidations.liq.aave.liquidatable} liquidables; Morpho ${liquidations.liq.morpho.liquidatable} liquidables (${liquidations.liq.morpho.apiPositions} en API); ${liquidations.liq.opportunities} episodios, est. $${liquidations.liq.estProfitUsd.toFixed(2)}; ajenas ${liquidations.liq.seen.aave}+${liquidations.liq.seen.morpho}${liquidator ? `; ejecución: ${liquidator.x.simulated} sim, ${liquidator.x.wouldSucceed} ok${liquidator.x.noMarket ? `, ${liquidator.x.noMarket} sin margen` : ""}${liquidator.x.dust ? `, ${liquidator.x.dust} polvo` : ""}${liquidator.x.coolNeg ? `, ${liquidator.x.coolNeg} enfriadas (neto<0)` : ""}, ${liquidator.x.sent} enviadas (${liquidator.x.confirmed} conf, ${liquidator.x.reverted} rev), realizado $${liquidator.x.realizedUsd.toFixed(4)}` : ""}${liquidations.liq.aave.error ? ` (Aave: ${liquidations.liq.aave.error})` : ""}${liquidations.liq.morpho.error ? ` (Morpho: ${liquidations.liq.morpho.error})` : ""}` : ""}${fast ? ` · flashblocks ${fast.f.loops} lecturas, ${fast.f.changedPools} cambios, ${fast.f.evaluated} rutas, ${fast.f.profitable} rentables, ${fast.f.simulated} sim, ${fast.f.sent} env, ${fast.f.avgMs} ms (lectura ${fast.f.readMs} ms, ${fast.f.hotPools}/${fast.f.totalPools} pools)${fast.f.lastError ? ` (error: ${fast.f.lastError})` : ""}` : ""}${events ? ` · eventos ${events.e.kind} ${events.e.connected ? "conectado" : "desconectado"} (${events.e.ws}${events.e.switches ? `, ${events.e.switches} cambios de WS` : ""}): ${events.e.logs} logs, ${events.e.applied} aplicados, ${events.e.triggers} evaluaciones, ${events.e.profitable} rentables, ${events.e.sent} envíos, ${events.e.lagMs ?? "—"} ms por evaluación${events.e.lastError ? ` (último error: ${events.e.lastError})` : ""}` : ""}${harvester ? ` · harvest ${harvester.h.strategies} estrategias, ${harvester.h.worthNow} rentables ahora, ${harvester.h.sent} enviadas (${harvester.h.confirmed} ok, ${harvester.h.reverted} rev), realizado $${harvester.h.realizedUsd.toFixed(4)}${harvester.h.lastError ? ` (error: ${harvester.h.lastError})` : ""}` : ""}${dxText}${st.lastError ? ` · error: ${st.lastError}` : ""}`);
}, 60_000);

// métricas por par (para el ranking de la revisión horaria): a los 5 min del arranque y luego cada 30 min
async function logPairs() {
  try {
    const st = live.stats ?? (await store.get("stats"));
    if (!live.pools || !st) return;
    const seen = (await store.get("pairsSeen")) ?? {};
    const rows = pairTable({ pools: live.pools, disloc: live.dislocRaw ? live.dislocRaw() : null, byRoute: st.byRoute, p1ByPair: executor?.p1?.byPair ?? {}, firstSeen: seen });
    let changed = false;
    for (const r of rows) if (!seen[r.pair]) { seen[r.pair] = Date.now(); changed = true; }
    if (changed) await store.set("pairsSeen", seen);
    console.log(`${new Date().toISOString()} pares: ${rows.length} vigilados (${CHAIN_CFG.key}; p=pools, e=episodios/% bloques desajustado, pico bps, r=rutas rentables/episodios, ok/rv=simulaciones, s=puntuación; mejor→peor) · ${pairLine(rows)}`);
  } catch (e) { console.log(`${new Date().toISOString()} pares: error ${e.message}`); }
}
if (!DCA_ONLY) { setTimeout(logPairs, 5 * 60_000); setInterval(logPairs, 30 * 60_000); }
