// Servicio 24/7 para Railway (o cualquier host con procesos continuos):
// corre el worker del protocolo sin parar y expone GET /api/stats para el panel de la página.
// No envía transacciones. Variables opcionales: RPC_URL, LT_HOURS (default 2), DATA_DIR, PORT.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { runWorker, isAlive } from "../src/worker.js";

const RPCS = [process.env.RPC_URL, "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://mainnet.base.org", "https://1rpc.io/base", "https://base.drpc.org"].filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.resolve("data"));
const LT_HOURS = Number(process.env.LT_HOURS ?? 2);
const PORT = Number(process.env.PORT || 8080);
const CHAIN_ID = BigInt(process.env.CHAIN_ID || 8453);
fs.mkdirSync(DATA_DIR, { recursive: true });
const VERSION = {
  commit: (process.env.RAILWAY_GIT_COMMIT_SHA || "local").slice(0, 7),
  message: (process.env.RAILWAY_GIT_COMMIT_MESSAGE || "").split("\n")[0].slice(0, 120),
  startedAt: Date.now(),
};

// ---------------------------------------------------------------- store en disco (JSON por clave, escritura atómica)
const cache = new Map();
const file = (k) => path.join(DATA_DIR, `${k}.json`);
const store = {
  async get(k) {
    if (cache.has(k)) return structuredClone(cache.get(k));
    try { const v = JSON.parse(fs.readFileSync(file(k), "utf8")); cache.set(k, v); return structuredClone(v); } catch { return null; }
  },
  async set(k, v) {
    cache.set(k, structuredClone(v));
    const tmp = file(k) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(v));
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

// ---------------------------------------------------------------- bucle infinito
let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      const { p, url } = await provider();
      await diag(`servidor: RPC ${new URL(url).host}`);
      // tandas de 1 h: el universo se refresca solo (lo guarda 30 min)
      const { stats } = await runWorker({ ethers, provider: p, store, deadlineMs: Date.now() + 3600_000, ltHours: LT_HOURS, log: (m) => diag(`worker: ${m}`) });
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
    const stats = await store.get("stats");
    const events = (await store.get("events")) ?? [];
    const diagLog = ((await store.get("diag")) ?? []).slice(-8).reverse();
    if (!stats) { res.writeHead(200, headers); return res.end(JSON.stringify({ ready: false, diag: diagLog, now: Date.now(), host: "railway", version: VERSION })); }
    const topRoutes = Object.values(stats.byRoute ?? {}).sort((a, b) => b.netUsd - a.netUsd).slice(0, 10);
    const vaults = (await store.get("vaults")) ?? null;
    if (vaults) {
      vaults.topManagers = Object.values(vaults.byManager ?? {}).sort((a, b) => b.events - a.events).slice(0, 12);
      delete vaults.byManager;
    }
    const { open, byRoute, ...rest } = stats;
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ ready: true, alive: isAlive(stats, Date.now()), now: Date.now(), host: "railway", ...rest, version: VERSION, openEpisodes: Object.keys(open ?? {}).length, topRoutes, recent: events.slice(-25).reverse(), diag: diagLog, vaults }));
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
      console.log(`${new Date().toISOString()} autocomprobación ${path}: HTTP ${r.status} · ${r.headers.get("content-type")} · ${body.length} bytes${path === "/" ? (body.includes("Worker 24/7") ? " · tablero OK" : " · ¡no es el tablero!") : ""}`);
    } catch (e) { console.log(`${new Date().toISOString()} autocomprobación ${path}: falló ${e.message}`); }
  }
}, 8_000);
// resumen periódico en los logs de Railway
setInterval(async () => {
  const st = await store.get("stats");
  if (st) console.log(`${new Date().toISOString()} resumen: bloque ${st.lastBlock} · ${st.blocksProcessed} bloques · ${st.totals.episodes} oportunidades · neto $${st.totals.netUsd.toFixed(2)} · fase ${st.phase}${st.lastError ? ` · error: ${st.lastError}` : ""}`);
}, 60_000);
