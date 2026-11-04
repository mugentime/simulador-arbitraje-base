// Bucle rápido con Flashblocks: lee el estado "pending" (sub-bloques de 200 ms) de los pools, re-evalúa solo las
// rutas cuyos pools cambiaron y ejecuta la Fase 1 contra ese estado sin esperar al bloque de 2 s.
// Requiere un RPC con Flashblocks (FLASH_RPC_URL; mainnet.base.org lo soporta con límite de peticiones).

import { ethers } from "ethers";
import * as core from "../src/core.js";

export function emptyFast() {
  return { enabled: false, rpc: null, loops: 0, reads: 0, changedPools: 0, evaluated: 0, profitable: 0, simulated: 0, sent: 0, lastChangeAt: null, lastError: null, avgMs: 0, readMs: 0, hotPools: 0, totalPools: 0, pendingLag: null };
}

export class FastLoop {
  constructor({ url, executor, diag, intervalMs = 250, parallel = Number(process.env.FAST_PARALLEL || 8), provider = null }) {
    this.url = url; this.executor = executor; this.diag = diag; this.intervalMs = intervalMs; this.parallel = parallel;
    this.provider = provider ?? new ethers.JsonRpcProvider(url, Number(core.CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
    this.f = emptyFast(); this.f.enabled = true; this.f.rpc = url ? new URL(url).host : "test";
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
    // Solo se leen en cada sub-bloque los pools que forman parte de algún ciclo: el resto no puede cambiar ninguna
    // ruta y solo alarga la lectura (en Base ~700 pools → >1 s por lectura).
    this.mainBy = new Map(pools.map((p) => [p.address, p]));
    this.hot = this.pools.filter((p) => this.index.has(p.address));
    this.f.hotPools = this.hot.length; this.f.totalPools = this.pools.length;
    // índice para el estado por eventos: dirección (o poolId v4) en minúsculas → pool en memoria
    this.byKey = new Map(this.hot.map((p) => [String(p.address).toLowerCase(), p]));
  }

  /**
   * Re-evalúa las rutas que tocan `changed` contra el estado en memoria y, si hay ganadoras, ejecuta la Fase 1.
   * Lo llaman el bucle de lectura y el feed de eventos; nunca dos a la vez (la segunda espera a la primera).
   */
  async evaluateChanged(changed, source = "poll") {
    if (!changed.length || !this.ctx || !this.cycles) return null;
    const prev = this.evalLock ?? Promise.resolve();
    const run = async () => {
      // ticks: comparte las tablas que mantiene el bucle principal
      for (const a of changed) { const p = this.byKey?.get(String(a).toLowerCase()); const m = p && this.mainBy.get(p.address); if (m?.ticks) { p.ticks = m.ticks; p.tickSpacing = m.tickSpacing; } }
      this.f.changedPools += changed.length; this.f.lastChangeAt = Date.now();
      const idx = new Set(); for (const a of changed) for (const i of this.index.get(a) ?? []) idx.add(i);
      if (!idx.size) return null;
      const subset = [...idx].map((i) => this.cycles[i]);
      this.f.evaluated += subset.length;
      const { gas, ethUsd, lenders } = this.ctx;
      const results = core.evaluateAll({ pools: this.pools, cycles: subset, lenders, gas, ethUsd, maxOptimize: 60 });
      const winners = results.filter((r) => r.profitable && !r.suspicious && !core.PHANTOM_ROUTES.has(core.routeId(r.route)));
      if (!winners.length) return { profitable: 0 };
      this.f.profitable += winners.length;
      if (source === "events") this.f.fromEvents = (this.f.fromEvents ?? 0) + winners.length;
      const r = await this.executor.onBlock({ block: "pending", ts: Math.floor(Date.now() / 1000), results, lenders, gas, ethUsd, pools: this.pools, fast: this.provider });
      const sent = !!(r && /envío: 0x/.test(r));
      if (r) { this.f.simulated++; if (sent) this.f.sent++; }
      return { profitable: winners.length, sent };
    };
    const p = prev.then(run, run);
    this.evalLock = p.catch(() => {});
    return p;
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
        const hot = this.hot;
        for (const p of hot) { const m = this.mainBy.get(p.address); if (m?.ticks) { p.ticks = m.ticks; p.tickSpacing = m.tickSpacing; } }
        const before = hot.map((p) => [p.reserve0, p.reserve1, p.sqrtPriceX96, p.liquidity]);
        const tr = Date.now();
        // todos los tramos del multicall a la vez (una sola ida y vuelta)
        await core.refreshPools(ethers, this.provider, hot, "pending", { parallel: this.parallel });
        this.f.readMs = Math.round(this.f.readMs * 0.95 + (Date.now() - tr) * 0.05);
        this.f.reads++;
        const changed = [];
        hot.forEach((p, i) => { const b = before[i]; if (b[0] !== p.reserve0 || b[1] !== p.reserve1 || b[2] !== p.sqrtPriceX96 || b[3] !== p.liquidity) changed.push(p.address); });
        if (changed.length) await this.evaluateChanged(changed, "poll");
      } catch (e) {
        this.f.lastError = (e.shortMessage || e.message).slice(0, 100);
        if (Date.now() - lastWarn > 300_000) { lastWarn = Date.now(); await this.diag(`flashblocks: ${this.f.lastError}`); }
        await sleep(2000);
      }
      this.f.loops++;
      const took = Date.now() - t0;
      this.f.avgMs = Math.round(this.f.avgMs * 0.95 + took * 0.05);
      await sleep(Math.max(0, (this.events?.e.connected ? Number(process.env.FAST_BACKUP_MS ?? 1000) : this.intervalMs) - took)); // con eventos, la lectura solo es respaldo
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
