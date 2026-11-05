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
wsLoop();
const live = {}; // referencias en memoria del worker en curso (stats, vstats, events) para que el panel vea cada bloque
let executor = null;
let harvester = null;
let liquidations = null;
let liquidator = null;
let lpLending = null;
let revertLend = null;
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
      const exec = new Executor({ provider: p, store, diag, mode: EXECUTE_MODE, autoDeploy: AUTO_DEPLOY });
      await exec.init();
      let nb = 0;
      executor = exec;
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

// ---------------------------------------------------------------- API para el panel
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
    return res.end(J({ ready: true, alive: isAlive(stats, Date.now()), now: Date.now(), host: "railway", chain: { key: core.CHAIN.key, name: core.CHAIN.name, id: core.CHAIN.id, native: core.CHAIN.native, publicMempool: core.CHAIN.publicMempool, tokens: Object.fromEntries(Object.entries(core.TOKENS).map(([k, t]) => [k, t.label])) }, ...rest, version: VERSION, openEpisodes: Object.keys(open ?? {}).length, topRoutes, recent: events.slice(-25).reverse(), diag: diagLog, vaults, phase1, harvest, liq, liqExec, lpLending: lpLending?.s ?? null, revertLend: revertLend?.s ?? null, fast: fastStats, disloc: live.disloc ? live.disloc() : null }));
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
  if (req.url === "/" || req.url.startsWith("/index.html") || req.url.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    // selector de cadenas: cada servicio de Railway expone su /api/stats; esta página los lee todos
    const urls = process.env.STATS_URLS || "base=https://worker-production-1950.up.railway.app/api/stats,polygon=https://worker-polygon-production.up.railway.app/api/stats,bsc=https://worker-bsc-production.up.railway.app/api/stats,arbitrum=https://worker-arbitrum-production.up.railway.app/api/stats,optimism=https://worker-optimism-production.up.railway.app/api/stats,robinhood=https://worker-robinhood-production.up.railway.app/api/stats";
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
      console.log(`${new Date().toISOString()} autocomprobación ${path}: HTTP ${r.status} · ${r.headers.get("content-type")} · ${body.length} bytes${path === "/" ? (body.includes("Protocolo de arbitraje con flashloan") ? " · tablero OK" : " · ¡no es el tablero!") : ""}`);
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
setTimeout(logCashIn, 6 * 60_000);
setInterval(logCashIn, 6 * 3600_000);
// resumen periódico en los logs de Railway
setInterval(async () => {
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
setTimeout(logPairs, 5 * 60_000);
setInterval(logPairs, 30 * 60_000);
