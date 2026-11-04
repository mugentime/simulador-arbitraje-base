// Estado por eventos: en vez de esperar la siguiente lectura por RPC (300–400 ms), se suscribe por WebSocket a los
// eventos Swap/Sync de los DEX vigilados, aplica cada uno al estado en memoria del bucle rápido (precio, liquidez,
// tick o reservas vienen en el propio evento) y re-evalúa al instante las rutas que tocan ese pool.
// En Base usa `pendingLogs` (Flashblocks, ~200 ms antes del bloque); en el resto, `logs` (bloque recién sellado).

import { ethers } from "ethers";
import WebSocket from "ws";
import * as core from "../src/core.js";

const T = {
  v3: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  pcs: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
  v4: ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  sync112: ethers.id("Sync(uint112,uint112)"),
  sync256: ethers.id("Sync(uint256,uint256)"),
};
export const EVENT_TOPICS = Object.values(T);
const MIN_SQRT = 4295128739n * 4n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n / 4n;

const word = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const int24 = (w) => Number(BigInt.asIntN(24, w));

/**
 * Aplica un log al pool correspondiente. Devuelve la dirección del pool cambiado o null.
 * `byAddr` = mapa dirección (o poolId v4) en minúsculas → pool.
 */
export function applyLog(byAddr, log) {
  const t0 = log.topics?.[0];
  if (!t0) return null;
  let p;
  if (t0 === T.v4) p = byAddr.get(String(log.topics[1]).toLowerCase());
  else p = byAddr.get(String(log.address).toLowerCase());
  if (!p) return null;
  const d = log.data;
  if (t0 === T.v3 || t0 === T.pcs || t0 === T.v4) {
    if (p.kind !== "v3" && p.kind !== "v4") return null;
    const sqrtP = word(d, 2), L = word(d, 3), tick = int24(word(d, 4));
    p.sqrtPriceX96 = sqrtP; p.liquidity = L; p.tick = tick;
    if (sqrtP <= MIN_SQRT || sqrtP >= MAX_SQRT) { p.reserve0 = p.reserve1 = 0n; }
    else [p.reserve0, p.reserve1] = core.v3VirtualReserves(sqrtP, L);
    return p.address;
  }
  if (t0 === T.sync112 || t0 === T.sync256) {
    if (p.kind === "v3" || p.kind === "v4") return null;
    p.reserve0 = word(d, 0); p.reserve1 = word(d, 1);
    return p.address;
  }
  return null;
}

export function emptyEvents() {
  return { enabled: false, ws: null, kind: null, connected: false, logs: 0, applied: 0, triggers: 0, profitable: 0, sent: 0, lagMs: null, lastError: null, reconnects: 0 };
}

const FAIL_SWITCH = Number(process.env.EVENTS_FAIL_SWITCH || 3);
const PRIMARY_RETRY_MS = Number(process.env.EVENTS_PRIMARY_RETRY_MIN || 30) * 60_000;

export class EventFeed {
  /** `fast` = FastLoop (comparte sus pools y su evaluación). */
  /** `fallbacks` = WebSockets públicos de la cadena: si el principal (Alchemy) rechaza con 429 o no abre
   *  `FAIL_SWITCH` veces seguidas, se pasa al siguiente; cada `PRIMARY_RETRY_MS` se vuelve a probar el principal. */
  constructor({ url, fast, diag, pending = false, fallbacks = [] }) {
    this.urls = [...new Set([url, ...fallbacks].filter(Boolean))]; this.idx = 0;
    this.url = this.urls[0] ?? null; this.fast = fast; this.diag = diag; this.pendingPref = pending; this.pending = pending;
    this.fails = 0; this.switchedAt = 0;
    this.e = emptyEvents(); this.e.enabled = !!this.url; this.e.ws = this.url ? new URL(this.url).host : null; this.e.kind = pending ? "pendingLogs" : "logs";
    this.queue = new Set(); this.flushing = false;
  }

  start() {
    if (this.url && !this.started) {
      this.started = true; this.connect();
      if (this.urls.length > 1) this.primaryTimer = setInterval(() => this.maybeReturnToPrimary(), 60_000).unref?.();
    }
  }

  connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.e.lastError = e.message; return this.retry(); }
    this.ws = ws;
    let opened = false;
    ws.on("open", () => {
      opened = true; this.fails = 0;
      this.e.connected = true;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: [this.pending ? "pendingLogs" : "logs", { topics: [EVENT_TOPICS] }] }));
    });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (m.id === 1 && m.error) {
        this.e.lastError = `suscripción: ${m.error.message}`;
        if (this.pending) { this.pending = false; this.e.kind = "logs"; ws.close(); } // el nodo no tiene pendingLogs: se cae a logs
        return;
      }
      const log = m.params?.result;
      if (!log || !log.topics) return;
      this.e.logs++;
      const byAddr = this.fast?.byKey;
      if (!byAddr) return;
      if (log.removed) return;
      const a = applyLog(byAddr, log);
      if (a) { this.e.applied++; this.queue.add(a); this.schedule(); }
    });
    ws.on("close", () => {
      this.e.connected = false;
      if (!opened) this.fails++;
      this.retry();
    });
    ws.on("error", (e) => {
      const msg = (e.message || String(e)).slice(0, 120);
      this.e.lastError = msg;
      if (/\b429\b/.test(msg)) this.fails = Math.max(this.fails, FAIL_SWITCH - 1); // cuota agotada: cambiar ya
    });
  }

  /** Elige la URL de la siguiente conexión: rota tras fallos seguidos y vuelve al principal cada cierto tiempo. */
  pickUrl(now = Date.now()) {
    if (this.urls.length < 2) return this.url;
    if (this.fails >= FAIL_SWITCH) {
      this.idx = (this.idx + 1) % this.urls.length; this.fails = 0; this.switchedAt = now;
      this.e.switches = (this.e.switches ?? 0) + 1;
    } else if (this.idx !== 0 && this.e.connected === false && now - this.switchedAt >= PRIMARY_RETRY_MS) {
      this.idx = 0; this.switchedAt = now; // probar de nuevo el principal
    }
    const url = this.urls[this.idx];
    if (url !== this.url) {
      this.url = url; this.e.ws = new URL(url).host;
      this.pending = this.idx === 0 ? this.pendingPref : false; // los públicos no dan pendingLogs
      this.e.kind = this.pending ? "pendingLogs" : "logs";
      Promise.resolve(this.diag?.(`eventos: WebSocket cambiado a ${this.e.ws} (${this.e.kind})`)).catch(() => {});
    }
    return url;
  }

  retry() {
    this.e.reconnects++;
    this.pickUrl();
    const delay = this.fails === 0 ? 1000 : Math.min(30_000, 1000 * 2 ** Math.min(this.fails, 5));
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Volver al principal mientras se está conectado a un público: cada PRIMARY_RETRY_MS se cierra y se reintenta. */
  maybeReturnToPrimary(now = Date.now()) {
    if (this.idx !== 0 && this.e.connected && now - this.switchedAt >= PRIMARY_RETRY_MS) {
      this.idx = 0; this.fails = 0; this.switchedAt = now; this.pickUrl(now); try { this.ws?.close(); } catch {}
      return true;
    }
    return false;
  }

  /** Agrupa los eventos que llegan juntos (mismo flashblock/bloque) y evalúa una sola vez. */
  schedule() {
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(async () => {
      try {
        while (this.queue.size) {
          const changed = [...this.queue]; this.queue.clear();
          this.e.triggers++;
          const t = Date.now();
          const r = await this.fast.evaluateChanged(changed, "events");
          if (r?.profitable) this.e.profitable += r.profitable;
          if (r?.sent) this.e.sent++;
          this.e.lagMs = Math.round((this.e.lagMs ?? 0) * 0.9 + (Date.now() - t) * 0.1);
        }
      } catch (e) { this.e.lastError = (e.shortMessage || e.message).slice(0, 120); }
      finally { this.flushing = false; if (this.queue.size) this.schedule(); }
    });
  }
}
