// Back-run por mempool público (BSC, Polygon): escucha transacciones pendientes, decodifica los swaps de routers
// conocidos, aplica su efecto al modelo de pools (core.withSwap) y, si deja una ruta cíclica rentable, envía un
// bundle [tx de la víctima, nuestra tx] a los builders: nuestra tx va justo detrás de la suya en el mismo bloque.
// Si la ruta ya no es rentable al construir el bloque, el bundle no se incluye y no cuesta gas.

import { ethers } from "ethers";
import WebSocket from "ws";
import * as core from "../src/core.js";
import { buildUsdPrices, evaluateJit, emptyJit } from "./jit.mjs";

// Routers por cadena: nombre del DEX en el universo (p.dex) y tipo de calldata.
export const ROUTERS = {
  bsc: [
    { address: "0x10ED43C718714eb63d5aA57B78B54704E256024E", dex: "PancakeSwap v2", kind: "v2" },
    { address: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8", dex: "Biswap v2", kind: "v2" },
    { address: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", dex: "PancakeSwap v3", kind: "v3" }, // SmartRouter
  ],
  polygon: [
    { address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", dex: "QuickSwap v2", kind: "v2" },
    { address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", dex: "SushiSwap v2", kind: "v2" },
    { address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", dex: "Uniswap v3", kind: "v3" }, // SwapRouter02
  ],
};

const IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  // SwapRouter02 / SmartRouter (sin deadline en el struct)
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))",
  // SwapRouter v1 (con deadline)
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)",
  "function multicall(uint256 deadline,bytes[] data)",
  "function multicall(bytes[] data)",
  "function multicall(bytes32 previousBlockhash,bytes[] data)",
]);

/**
 * Decodifica el calldata de un router en una lista de swaps {kind, tokenIn, tokenOut, amountIn, fee?}.
 * Solo swaps de entrada exacta (la cantidad que entra es conocida). Devuelve [] si no reconoce el método.
 */
export function decodeSwaps(data, value = 0n, depth = 0) {
  let d;
  try { d = IFACE.parseTransaction({ data, value }); } catch { return []; }
  if (!d) return [];
  const n = d.name, a = d.args;
  if (n === "multicall") {
    if (depth > 2) return [];
    const inner = a[a.length - 1];
    return inner.flatMap((x) => decodeSwaps(x, 0n, depth + 1));
  }
  if (n.startsWith("swapExactTokensFor")) return pathSwaps(a.path, a.amountIn);
  if (n.startsWith("swapExactETHFor")) return pathSwaps(a.path, value);
  if (n === "exactInputSingle") {
    const p = a[0];
    return [{ kind: "v3", tokenIn: ethers.getAddress(p.tokenIn), tokenOut: ethers.getAddress(p.tokenOut), amountIn: BigInt(p.amountIn), fee: Number(p.fee) }];
  }
  return [];
}

function pathSwaps(path, amountIn) {
  // solo el primer salto tiene entrada conocida; los siguientes se encadenan con el modelo al aplicarlos
  const out = [];
  for (let i = 0; i + 1 < path.length; i++) out.push({ kind: "v2", tokenIn: ethers.getAddress(path[i]), tokenOut: ethers.getAddress(path[i + 1]), amountIn: i === 0 ? BigInt(amountIn) : null });
  return out;
}

/** Pool del universo para un swap decodificado (mismo DEX, mismos tokens; en v3 además la comisión). */
export function findPool(pools, router, s) {
  if (!s?.tokenIn || !s?.tokenOut) return null;
  const a = s.tokenIn.toLowerCase(), b = s.tokenOut.toLowerCase();
  return pools.find((p) => {
    if (!p.token0?.address || !p.token1?.address) return false;
    const t = [p.token0.address.toLowerCase(), p.token1.address.toLowerCase()];
    if (!(t.includes(a) && t.includes(b))) return false;
    if (!String(p.dex).startsWith(router.dex)) return false;
    if (s.kind === "v3") return p.kind === "v3" && (s.fee === undefined || Number(p.feePips) === s.fee);
    return p.kind === "v2";
  }) ?? null;
}

/**
 * Aplica los swaps de la víctima al modelo y devuelve {pools, touched} (copias; el original no se toca).
 */
export function applySwaps(pools, router, swaps) {
  let cur = pools, touched = [], carry = null;
  for (const s of swaps) {
    const p = findPool(cur, router, s);
    const amt = s.amountIn ?? carry;
    if (!p || !amt || amt <= 0n) return null; // ruta que no conocemos: no se puede modelar
    carry = core.swapOut(p, s.tokenIn, amt);
    cur = core.withSwap(cur, p.address, s.tokenIn, amt);
    touched.push(p.address);
  }
  return touched.length ? { pools: cur, touched } : null;
}

/** Transacción firmada en crudo a partir del objeto de una tx pendiente (para meterla al bundle). */
export function rawFromPending(tx) {
  const t = {
    type: tx.type !== undefined && tx.type !== null ? Number(tx.type) : 0,
    chainId: tx.chainId !== undefined && tx.chainId !== null ? BigInt(tx.chainId) : core.CHAIN_ID,
    nonce: Number(tx.nonce), gasLimit: BigInt(tx.gas ?? tx.gasLimit), to: tx.to, value: BigInt(tx.value ?? 0), data: tx.input ?? tx.data,
    signature: { r: tx.r, s: tx.s, v: Number(tx.v) },
  };
  if (t.type === 2) { t.maxFeePerGas = BigInt(tx.maxFeePerGas); t.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas); t.accessList = tx.accessList ?? []; }
  else { t.gasPrice = BigInt(tx.gasPrice); if (t.type === 1) t.accessList = tx.accessList ?? []; }
  if (t.type === 0) {
    // legacy: el chainId sale del v (EIP-155: v = 35 + 2·chainId + paridad); v 27/28 = sin chainId
    const v = BigInt(tx.v);
    t.chainId = v >= 35n ? (v - 35n) / 2n : 0n;
  }
  const raw = ethers.Transaction.from(t).serialized;
  if (tx.hash && ethers.keccak256(raw).toLowerCase() !== String(tx.hash).toLowerCase()) throw new Error("hash de la tx reconstruida no coincide");
  return raw;
}

export function emptyMempool() {
  return { enabled: false, ws: null, connected: false, seen: 0, routerTxs: 0, decoded: 0, modeled: 0, profitable: 0, bundles: 0, lastError: null, lastOpp: null, jit: emptyJit() };
}

export class MempoolWatcher {
  constructor({ wsUrls, executor, diag, minUsd = Number(process.env.BACKRUN_MIN_USD ?? 0.01) }) {
    this.wsUrls = wsUrls; this.executor = executor; this.diag = diag; this.minUsd = minUsd;
    this.routers = new Map((ROUTERS[core.CHAIN.key] ?? []).map((r) => [r.address.toLowerCase(), r]));
    this.m = emptyMempool(); this.m.enabled = this.routers.size > 0;
    this.pools = null; this.cycles = null; this.index = null; this.ctx = null; this.busy = false; this.wsIdx = 0;
  }
  setUniverse(pools, cycles) {
    this.main = pools;
    this.pools = pools; this.cycles = cycles;
    this.index = new Map();
    cycles.forEach((c, i) => { for (const p of c.route) (this.index.get(p.address) ?? this.index.set(p.address, []).get(p.address)).push(i); });
  }
  setContext(ctx) { this.ctx = ctx; }

  /** Liquidez JIT, solo observación: ¿cuánto habríamos ganado poniendo liquidez justo antes de este swap? */
  async observeJit(tx, router, swaps) {
    const now = Date.now();
    if (!this.jitPrices || this.jitPricesFor !== this.pools || now - this.jitPricesAt > 60_000) {
      this.jitPrices = buildUsdPrices(this.pools, core.TOKENS, this.ctx.ethUsd); this.jitPricesFor = this.pools; this.jitPricesAt = now;
    }
    const { gas, ethUsd } = this.ctx;
    const gasUsd = (Number(BigInt(process.env.JIT_GAS ?? 450000) * ((gas?.baseFee ?? 0n) + (gas?.priority ?? 0n))) / 1e18) * ethUsd;
    const j = (this.m.jit ??= emptyJit());
    for (const s of swaps) {
      if (s.kind !== "v3" || !s.amountIn) continue;
      const p = findPool(this.pools, router, s);
      if (!p) continue;
      const pair = [p.token0.address.toLowerCase(), p.token1.address.toLowerCase()].sort().join();
      const backFee = Math.min(...this.pools.filter((q) => q.reserve0 > 0n && q.token0?.address && [q.token0.address.toLowerCase(), q.token1.address.toLowerCase()].sort().join() === pair)
        .map((q) => (q.feePips !== undefined ? Number(q.feePips) / 1e6 : (q.feeBps ?? 30) / 1e4)));
      const r = evaluateJit(p, s.tokenIn, s.amountIn, { prices: this.jitPrices, gasUsd, backFee: isFinite(backFee) ? backFee : undefined, borrowBps: Number(process.env.JIT_BORROW_BPS ?? 5), maxNotionalUsd: Number(process.env.JIT_MAX_USD ?? 200000) });
      if (!r) continue;
      j.evaluated++;
      if (r.netUsd <= 0) continue;
      j.positive++; j.sumNetUsd += r.netUsd;
      const rec = { at: now, victim: tx.hash, pool: `${p.token0.sym}/${p.token1.sym} ${r.feePct}%`, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(4) : v])) };
      if (!j.best || r.netUsd > j.best.netUsd) j.best = rec;
      j.last = [rec, ...j.last].slice(0, 5);
      if (r.netUsd >= Number(process.env.JIT_LOG_USD ?? 0.05) && now - (this.jitLogAt ?? 0) > 15_000) {
        this.jitLogAt = now;
        await this.diag(`jit (observación): ${String(tx.hash).slice(0, 12)}… ${rec.pool} · swap $${r.swapUsd.toFixed(0)} · neto $${r.netUsd.toFixed(4)} (optimista $${r.netOptUsd.toFixed(4)}; comisión $${r.feeUsd.toFixed(4)} + inventario $${r.invUsd.toFixed(4)} − deshacer $${r.backUsd.toFixed(4)} − préstamo $${r.borrowUsd.toFixed(4)} − gas $${r.gasUsd.toFixed(4)}) · liquidez ${r.k}× la del pool (${(r.share * 100).toFixed(0)} %), nocional $${r.notionalUsd.toFixed(0)}, ${r.ticks} ticks`);
      }
    }
  }

  start() {
    if (!this.m.enabled || this.started) return;
    this.started = true;
    // todos los nodos a la vez: cada uno ve el mempool con distinto retraso; gana el primero que avisa
    this.dedup = new Set(); this.dedupQ = [];
    this.conns = {};
    this.wsUrls.forEach((u) => this.connect(u));
    this.m.ws = this.wsUrls.map((u) => new URL(u).host).join(", ");
  }

  firstSeen(h) {
    if (!h) return true;
    const k = String(h).toLowerCase();
    if (this.dedup.has(k)) return false;
    this.dedup.add(k); this.dedupQ.push(k);
    if (this.dedupQ.length > 20000) this.dedup.delete(this.dedupQ.shift());
    return true;
  }

  connect(url) {
    const host = new URL(url).host;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.m.lastError = e.message; return this.retry(url); }
    let fullTx = true;
    ws.on("open", () => { if (this.fails) this.fails[url] = 0; this.conns[host] = true; this.m.connected = Object.values(this.conns).some(Boolean); this.m.connections = Object.entries(this.conns).filter(([, v]) => v).map(([k]) => k); ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions", true] })); });
    ws.on("message", (buf) => {
      let j; try { j = JSON.parse(buf.toString()); } catch { return; }
      if (j.id === 1 && j.error) {
        // el nodo no admite tx completas: se suscribe a hashes
        fullTx = false;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newPendingTransactions"] }));
        return;
      }
      if (j.id === 2 && j.error) { this.m.lastError = `${host}: suscripción rechazada: ${j.error.message}`; ws.close(); return; }
      const r = j.params?.result;
      if (!r) return;
      if (typeof r === "string") {
        // nodo que solo da hashes: no consume el deduplicado (otro nodo puede traer la tx completa); se pide con ritmo limitado
        (this.m.hashesBy ??= {})[host] = (this.m.hashesBy[host] ?? 0) + 1;
        if (!fullTx && !this.dedup.has(r.toLowerCase())) this.onHash(r).catch(() => {});
        return;
      }
      if (!this.firstSeen(r.hash)) return;
      this.m.seen++;
      (this.m.firstBy ??= {})[host] = (this.m.firstBy[host] ?? 0) + 1;
      this.onTx(r).catch((e) => {
        this.m.errors = (this.m.errors ?? 0) + 1;
        this.m.lastError = (e.message || String(e)).slice(0, 120);
        // la primera vez se deja la traza completa en la bitácora para poder corregirlo
        if (!this.loggedStack) { this.loggedStack = true; this.diag(`mempool: error procesando ${r.hash} (to ${r.to}): ${(e.stack || "").split("\n").slice(0, 4).join(" | ")}`).catch(() => {}); }
      });
    });
    ws.on("error", (e) => { this.m.lastError = `${host}: ${(e.message || String(e)).slice(0, 100)}`; });
    ws.on("close", () => { this.conns[host] = false; this.m.connected = Object.values(this.conns).some(Boolean); this.retry(url); });
  }
  retry(url) { this.fails = this.fails ?? {}; const n = (this.fails[url] = (this.fails[url] ?? 0) + 1); setTimeout(() => this.connect(url), Math.min(120_000, 5000 * n)); }

  async onHash(h) {
    // sin tx completas habría que pedir cada una; solo se piden las que van a routers sería imposible saberlo antes,
    // así que se limita el ritmo para no saturar el RPC
    if ((this.hashBudget = (this.hashBudget ?? 0) + 1) % 4 !== 0) return;
    const tx = await this.executor.provider.send("eth_getTransactionByHash", [h]).catch(() => null);
    if (tx && this.firstSeen(tx.hash)) { this.m.seen++; await this.onTx(tx); }
  }

  async onTx(tx) {
    if (!tx.to || !this.pools || !this.ctx) return;
    const router = this.routers.get(String(tx.to).toLowerCase());
    if (!router) return;
    this.m.routerTxs++;
    const swaps = decodeSwaps(tx.input ?? tx.data, BigInt(tx.value ?? 0));
    if (!swaps.length) return;
    this.m.decoded++;
    if (process.env.JIT_OBSERVE !== "0") { try { await this.observeJit(tx, router, swaps); } catch (e) { this.m.lastError = `jit: ${e.message}`; } }
    const applied = applySwaps(this.pools, router, swaps);
    if (!applied) return;
    this.m.modeled++;
    const idx = new Set(); for (const a of applied.touched) for (const i of this.index.get(a) ?? []) idx.add(i);
    if (!idx.size) return;
    const byAddr = new Map(applied.pools.map((p) => [p.address, p]));
    const cycles = [...idx].map((i) => this.cycles[i]).map((c) => ({ ...c, route: c.route.map((p) => byAddr.get(p.address) ?? p) }));
    const { gas, ethUsd, lenders } = this.ctx;
    const res = core.evaluateAll({ pools: applied.pools, cycles, lenders, gas, ethUsd, maxOptimize: 40 });
    const best = res.find((r) => r.profitable && !r.suspicious && r.netUsd >= this.minUsd);
    if (!best) return;
    this.m.profitable++;
    this.m.lastOpp = { at: Date.now(), victim: tx.hash, router: router.dex, route: best.route.map((p) => p.dex).join(" → "), netUsd: best.netUsd };
    if (this.busy) return;
    this.busy = true;
    try {
      let raw;
      try { raw = rawFromPending(tx); } catch (e) { if (this.executor.limits.bundleSend) { this.m.lastError = `no se pudo reconstruir la tx ${tx.hash}: ${e.message}`; return; } raw = null; }
      const r = await this.executor.sendBackrun(raw, tx.hash, best, lenders, gas, ethUsd, tx);
      if (r) { this.m.bundles++; await this.diag(`mempool: back-run de ${String(tx.hash).slice(0, 12)}… (${router.dex}) · neto modelo $${best.netUsd.toFixed(4)} · ${r}`); }
    } finally { this.busy = false; }
  }
}
