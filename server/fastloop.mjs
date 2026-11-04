// Bucle rápido con Flashblocks: lee el estado "pending" (sub-bloques de 200 ms) de los pools, re-evalúa solo las
// rutas cuyos pools cambiaron y ejecuta la Fase 1 contra ese estado sin esperar al bloque de 2 s.
// Requiere un RPC con Flashblocks (FLASH_RPC_URL; mainnet.base.org lo soporta con límite de peticiones).

import { ethers } from "ethers";
import * as core from "../src/core.js";

export function emptyFast() {
  return { enabled: false, rpc: null, loops: 0, reads: 0, changedPools: 0, evaluated: 0, profitable: 0, simulated: 0, sent: 0, lastChangeAt: null, lastError: null, avgMs: 0, pendingLag: null };
}

export class FastLoop {
  constructor({ url, executor, diag, intervalMs = 250 }) {
    this.url = url; this.executor = executor; this.diag = diag; this.intervalMs = intervalMs;
    this.provider = new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true, batchMaxCount: 1 });
    this.f = emptyFast(); this.f.enabled = true; this.f.rpc = new URL(url).host;
    this.running = false; this.ctx = null;
  }

  /** Nuevo universo (cada vez que el worker lo arma): clon de pools e índice pool → ciclos. */
  setUniverse(pools, cycles) {
    this.main = pools;
    this.pools = pools.map((p) => ({ ...p }));
    const byAddr = new Map(this.pools.map((p) => [p.address, p]));
    this.cycles = cycles.map((c) => ({ ...c, route: c.route.map((p) => byAddr.get(p.address)) }));
    this.index = new Map();
    this.cycles.forEach((c, i) => { for (const p of c.route) (this.index.get(p.address) ?? this.index.set(p.address, []).get(p.address)).push(i); });
  }

  /** Contexto del último bloque completo: gas, precio ETH, prestamistas. */
  setContext(ctx) { this.ctx = ctx; }

  start() { if (!this.running) { this.running = true; this.gen = (this.gen ?? 0) + 1; this.loop(this.gen).catch((e) => { this.f.lastError = e.message; this.running = false; }); } }
  stop() { this.running = false; }

  async loop(gen) {
    let lastWarn = 0;
    // `gen` evita que un bucle antiguo siga vivo tras stop()+start(): solo corre el de la generación actual
    while (this.running && gen === this.gen) {
      const t0 = Date.now();
      try {
        if (!this.pools?.length || !this.ctx) { await sleep(500); continue; }
        // ticks: comparte las tablas que mantiene el bucle principal
        for (const p of this.pools) { const m = this.main.find((q) => q.address === p.address); if (m?.ticks) { p.ticks = m.ticks; p.tickSpacing = m.tickSpacing; } }
        const before = this.pools.map((p) => [p.reserve0, p.reserve1, p.sqrtPriceX96, p.liquidity]);
        await core.refreshPools(ethers, this.provider, this.pools, "pending");
        this.f.reads++;
        const changed = [];
        this.pools.forEach((p, i) => { const b = before[i]; if (b[0] !== p.reserve0 || b[1] !== p.reserve1 || b[2] !== p.sqrtPriceX96 || b[3] !== p.liquidity) changed.push(p.address); });
        if (changed.length) {
          this.f.changedPools += changed.length; this.f.lastChangeAt = Date.now();
          const idx = new Set(); for (const a of changed) for (const i of this.index.get(a) ?? []) idx.add(i);
          const subset = [...idx].map((i) => this.cycles[i]);
          this.f.evaluated += subset.length;
          const { gas, ethUsd, lenders } = this.ctx;
          const results = core.evaluateAll({ pools: this.pools, cycles: subset, lenders, gas, ethUsd, maxOptimize: 60 });
          const winners = results.filter((r) => r.profitable && !r.suspicious);
          if (winners.length) {
            this.f.profitable += winners.length;
            // Fase 1 contra el estado pending: simula y envía en el mismo sub-bloque
            const r = await this.executor.onBlock({ block: "pending", ts: Math.floor(Date.now() / 1000), results, lenders, gas, ethUsd, pools: this.pools, fast: this.provider });
            if (r) { this.f.simulated++; if (/envío: 0x/.test(r)) this.f.sent++; }
          }
        }
      } catch (e) {
        this.f.lastError = (e.shortMessage || e.message).slice(0, 100);
        if (Date.now() - lastWarn > 300_000) { lastWarn = Date.now(); await this.diag(`flashblocks: ${this.f.lastError}`); }
        await sleep(2000);
      }
      this.f.loops++;
      const took = Date.now() - t0;
      this.f.avgMs = Math.round(this.f.avgMs * 0.95 + took * 0.05);
      await sleep(Math.max(0, this.intervalMs - took));
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
