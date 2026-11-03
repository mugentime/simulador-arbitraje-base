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
import { FastLoop } from "./fastloop.mjs";

const RPCS = [process.env.RPC_URL, "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://mainnet.base.org", "https://1rpc.io/base", "https://base.drpc.org"].filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.resolve("data"));
const LT_HOURS = Number(process.env.LT_HOURS ?? 2);
const PORT = Number(process.env.PORT || 8080);
const CHAIN_ID = BigInt(process.env.CHAIN_ID || 8453);
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
      if (LT_HOURS > 0 && CHAIN_ID === 8453n) {
        const head = await p.getBlockNumber();
        await p.getLogs({ address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", fromBlock: head - 500, toBlock: head });
      }
      return { p, url };
    } catch (e) { console.warn("RPC falló", url, e.shortMessage || e.message); }
  }
  throw new Error("ningún RPC de Base respondió");
}

// ---------------------------------------------------------------- proveedor de eth_getLogs con respaldo
// Algunos nodos públicos (publicnode) devuelven 403 a eth_getLogs con muchas direcciones; se prueba otro.
function logsProviderFor(main, mainUrl) {
  const urls = [mainUrl, ...RPCS.filter((u) => u !== mainUrl)];
  const provs = new Map([[mainUrl, main]]);
  let idx = 0;
  const get = (u) => { if (!provs.has(u)) provs.set(u, new ethers.JsonRpcProvider(u, Number(CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 })); return provs.get(u); };
  return {
    async getLogs(filter) {
      let lastErr;
      for (let i = 0; i < urls.length; i++) {
        const u = urls[(idx + i) % urls.length];
        try {
          const r = await Promise.race([get(u).getLogs(filter), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 6 s")), 6000))]);
          if (i) { idx = (idx + i) % urls.length; await diag(`vaults: eth_getLogs ahora vía ${new URL(u).host}`); }
          return r;
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    },
  };
}

// ---------------------------------------------------------------- bloques nuevos por WebSocket (con respaldo por sondeo)
// Despierta al worker en cuanto el nodo anuncia un bloque, en vez de preguntar cada segundo.
const WS_RPCS = (process.env.WS_RPC_URL ? [process.env.WS_RPC_URL] : []).concat(["wss://base-rpc.publicnode.com", "wss://base.drpc.org", "wss://mainnet.base.org"]);
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
let fast = null;
const FLASH_RPC = process.env.FLASH_RPC_URL || "https://mainnet.base.org";
async function loop() {
  while (!stopping) {
    try {
      const { p, url } = await provider();
      await diag(`servidor: RPC ${new URL(url).host}`);
      const exec = new Executor({ provider: p, store, diag, mode: EXECUTE_MODE, autoDeploy: AUTO_DEPLOY });
      await exec.init();
      let nb = 0;
      executor = exec;
      const hv = new Harvester({ provider: p, store, diag, executor: exec, mode: EXECUTE_MODE });
      await hv.init();
      harvester = hv;
      const lq = new Liquidations({ provider: p, logsProvider: logsProviderFor(p, url), store, diag });
      await lq.init();
      liquidations = lq;
      const lx = new Liquidator({ provider: p, store, diag, executor: exec, liquidations: lq });
      await lx.init();
      liquidator = lx;
      lq.onCandidate = (cand, ctx) => lx.attempt(cand, ctx).catch(() => {});
      if (process.env.FLASHBLOCKS !== "0") { fast = new FastLoop({ url: FLASH_RPC, executor: exec, diag }); fast.start(); await diag(`flashblocks: bucle rápido cada 250 ms vía ${new URL(FLASH_RPC).host} (estado pending)`); }
      const onBlock = async (ctx) => {
        nb++; if (nb % 300 === 0) await exec.refreshBalance();
        if (fast) { if (fast.main !== ctx.pools) fast.setUniverse(ctx.pools, live.cycles ?? []); fast.setContext({ gas: ctx.gas, ethUsd: ctx.ethUsd, lenders: ctx.lenders }); }
        const text = await exec.onBlock(ctx);
        hv.onBlock(ctx).catch((e) => { hv.h.lastError = e.shortMessage || e.message; }); // en paralelo: no retrasa el siguiente bloque
        lq.onBlock(ctx).catch((e) => { lq.liq.aave.error = e.shortMessage || e.message; });
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
    const liq = liquidations?.liq ?? (await store.get("liq")) ?? null;
    const liqExec = liquidator?.x ?? (await store.get("liqExec")) ?? null;
    const fastStats = fast?.f ?? null;
    if (vaults) {
      vaults.topManagers = Object.values(vaults.byManager ?? {}).sort((a, b) => b.events - a.events).slice(0, 12);
      delete vaults.byManager;
    }
    const { open, byRoute, ...rest } = stats;
    res.writeHead(200, headers);
    return res.end(J({ ready: true, alive: isAlive(stats, Date.now()), now: Date.now(), host: "railway", ...rest, version: VERSION, openEpisodes: Object.keys(open ?? {}).length, topRoutes, recent: events.slice(-25).reverse(), diag: diagLog, vaults, phase1, harvest, liq, liqExec, fast: fastStats }));
  }
  if (req.url.startsWith("/health")) { res.writeHead(200, headers); return res.end(JSON.stringify({ ok: true })); }
  if (req.url === "/" || req.url.startsWith("/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(fs.readFileSync(new URL("./dashboard.html", import.meta.url)));
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
// resumen periódico en los logs de Railway
setInterval(async () => {
  const st = await store.get("stats");
  const p1 = executor?.p1;
  const vs = live.vstats;
  if (st) console.log(`${new Date().toISOString()} resumen: bloque ${st.lastBlock} · ${st.blocksProcessed} bloques · ${st.totals.episodes} oportunidades · neto $${st.totals.netUsd.toFixed(2)} · fase ${st.phase}${p1 ? ` · fase1 ${p1.mode}: ${p1.simulated} sim, ${p1.wouldSucceed} ok, ${p1.wouldRevert} rev (${Object.entries(p1.byReason || {}).map(([k, n]) => `${k}×${n}`).join(", ") || "—"}), neto sim $${p1.projectedNetUsd.toFixed(4)}, enviadas ${p1.sent} (${p1.confirmed} confirmadas, ${p1.reverted} revertidas, realizado $${p1.realizedUsd.toFixed(4)}, gas pagado $${p1.gasPaidUsd.toFixed(4)})${p1.paused ? " PAUSADA" : ""}` : ""}${vs ? ` · vaults ${(vs.events.rebalanceo + vs.events.zap + vs.events.salida)} eventos, ${vs.withOpp} con EV+, $${vs.netUsd.toFixed(2)}${vs.lastError ? ` (error: ${vs.lastError})` : ""}` : ""}${liquidations ? ` · liquidaciones: Aave ${liquidations.liq.aave.borrowers} prestatarios, ${liquidations.liq.aave.liquidatable} liquidables; Morpho ${liquidations.liq.morpho.liquidatable} liquidables (${liquidations.liq.morpho.apiPositions} en API); ${liquidations.liq.opportunities} episodios, est. $${liquidations.liq.estProfitUsd.toFixed(2)}; ajenas ${liquidations.liq.seen.aave}+${liquidations.liq.seen.morpho}${liquidator ? `; ejecución: ${liquidator.x.simulated} sim, ${liquidator.x.wouldSucceed} ok, ${liquidator.x.sent} enviadas (${liquidator.x.confirmed} conf, ${liquidator.x.reverted} rev), realizado $${liquidator.x.realizedUsd.toFixed(4)}` : ""}${liquidations.liq.aave.error ? ` (Aave: ${liquidations.liq.aave.error})` : ""}${liquidations.liq.morpho.error ? ` (Morpho: ${liquidations.liq.morpho.error})` : ""}` : ""}${fast ? ` · flashblocks ${fast.f.loops} lecturas, ${fast.f.changedPools} cambios, ${fast.f.evaluated} rutas, ${fast.f.profitable} rentables, ${fast.f.simulated} sim, ${fast.f.sent} env, ${fast.f.avgMs} ms${fast.f.lastError ? ` (error: ${fast.f.lastError})` : ""}` : ""}${harvester ? ` · harvest ${harvester.h.strategies} estrategias, ${harvester.h.worthNow} rentables ahora, ${harvester.h.sent} enviadas (${harvester.h.confirmed} ok, ${harvester.h.reverted} rev), realizado $${harvester.h.realizedUsd.toFixed(4)}${harvester.h.lastError ? ` (error: ${harvester.h.lastError})` : ""}` : ""}${st.lastError ? ` · error: ${st.lastError}` : ""}`);
}, 60_000);
