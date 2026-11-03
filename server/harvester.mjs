// Protocolo 2 · ejecución: harvest de estrategias Beefy en Base.
//
// Cualquiera puede llamar harvest() en una estrategia de Beefy; la estrategia cobra las recompensas acumuladas,
// las reinvierte y paga al que llamó una comisión (callReward, en WETH). No hay préstamo, no hay carrera por
// un desfase de precio: solo hay que llamar cuando callReward > gas y antes que el bot de Beefy.
// Descubrimiento: lista pública de vaults de Beefy (api.beefy.finance) filtrada por chain=base.

import { ethers } from "ethers";
import * as core from "../src/core.js";

const BEEFY_API = "https://api.beefy.finance/vaults";
const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  "function callReward() view returns (uint256)",
  "function lastHarvest() view returns (uint256)",
  "function paused() view returns (bool)",
  "function harvest(address callFeeRecipient)",
  "function harvest()",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const MAX_RECENT = 60;
const TOPICS = {
  stratHarvest: "0x9bc239f1724cacfb88cb1d66a2dc437467699b68a8c90d7b63110cf4b6f92410", // StratHarvest(address harvester, uint256 wantHarvested, uint256 tvl)
  harvest: "0x71bab65ced2e5750775a0613be067df48ef06cf92a496ebf7663ae0660924954", // Harvest(address harvester, uint256, uint256)
  charged3: "0xd255b592c7f268a73e534da5219a60ff911b4cf6daae21c7d20527dd657bd99a", // ChargedFees(callFees, beefyFees, strategistFees)
  charged4: "0x9e1e3876a8a93b5957114512cad3320495e0b9761c7599fb096a20bc9c9b0262", // ChargedFees(callFees, beefyFees, strategistFees, frontendFees)
};
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

export function emptyHarvest() {
  return {
    version: 1, strategies: 0, lastDiscovery: null, lastScan: null, scanBlock: null,
    candidates: [], // [{address, id, rewardUsd, gasUsd, netUsd, sinceMin}] los mejores de la última lectura
    worthNow: 0, // cuántas estrategias pagan más que el gas ahora mismo
    simulated: 0, wouldSucceed: 0, wouldRevert: 0, sent: 0, confirmed: 0, reverted: 0, dropped: 0,
    rewardUsd: 0, gasPaidUsd: 0, realizedUsd: 0, pending: [], recent: [], lastError: null, updatedAt: null,
  };
}

export class Harvester {
  constructor({ provider, store, diag, executor, mode = "simulate", logsProvider = null }) {
    this.provider = provider; this.logs = logsProvider ?? provider; this.store = store; this.diag = diag; this.executor = executor; this.mode = mode;
    this.iface = new ethers.Interface(ABI);
    this.limits = {
      minNetUsd: Number(process.env.MIN_HARVEST_NET_USD ?? 0.005),
      rewardOverGas: Number(process.env.HARVEST_REWARD_OVER_GAS ?? 2.5), // callReward debe ser ≥ 2.5× el gas (si Beefy se adelanta, perdemos solo gas)
      maxPerHour: Number(process.env.MAX_HARVEST_PER_HOUR ?? 10),
      scanEvery: Number(process.env.HARVEST_SCAN_BLOCKS ?? 30),
      historyBlocks: Number(process.env.HARVEST_HISTORY_BLOCKS ?? 302_400), // 7 días
      leadSec: Number(process.env.HARVEST_LEAD_SEC ?? 90), // anticipación al harvest previsto
    };
    this.hist = null; // por estrategia: {events:[{block,ts,harvester,callFee}], intervalMed, callFeeMed, nextAt, ...}
    this.strats = []; this.sentTimes = []; this.busy = false;
  }

  async init() {
    this.h = (await this.store.get("harvest")) ?? emptyHarvest();
    this.h.pending ??= [];
    const cached = await this.store.get("beefy");
    if (cached && Date.now() - cached.at < 6 * 3600_000) this.strats = cached.strats;
    else await this.discover();
    this.h.strategies = this.strats.length;
    await this.save();
    this.hist = (await this.store.get("harvestHist")) ?? null;
    if (!this.hist || Date.now() - (this.hist.at ?? 0) > 6 * 3600_000) this.analyzeHistory().catch((e) => { this.h.lastError = `historial: ${e.shortMessage || e.message}`; });
  }

  /**
   * Modelo predictivo simple: historial on-chain de harvests (eventos StratHarvest/Harvest + ChargedFees) de cada
   * estrategia en los últimos días → intervalo mediano entre harvests, comisión mediana pagada al que llamó, quién
   * cosecha, y previsión del próximo harvest = último + intervalo. Se cosecha en la ventana previa a esa previsión.
   */
  async analyzeHistory() {
    if (!this.strats.length) return;
    const head = await this.provider.getBlockNumber();
    const from0 = head - this.cfg_hist();
    const addrs = this.strats.map((s) => s.address);
    const per = new Map(addrs.map((a) => [a.toLowerCase(), { events: [], fees: [] }]));
    const chunk = Number(process.env.HARVEST_HISTORY_CHUNK ?? 2000);
    let failed = 0;
    for (let from = from0; from <= head; from += chunk) {
      const to = Math.min(head, from + chunk - 1);
      let logs;
      try { logs = await this.logs.getLogs({ address: addrs, fromBlock: from, toBlock: to, topics: [[TOPICS.stratHarvest, TOPICS.harvest, TOPICS.charged3, TOPICS.charged4]] }); }
      catch (e) { failed++; this.h.lastError = `historial: ${failed} tramos sin leer (${(e.shortMessage || e.message).slice(0, 50)})`; continue; }
      for (const lg of logs) {
        const rec = per.get(lg.address.toLowerCase()); if (!rec) continue;
        if (lg.topics[0] === TOPICS.stratHarvest || lg.topics[0] === TOPICS.harvest) {
          rec.events.push({ block: lg.blockNumber, harvester: "0x" + lg.topics[1].slice(-40), tx: lg.transactionHash });
        } else {
          rec.fees.push({ block: lg.blockNumber, tx: lg.transactionHash, callFee: BigInt("0x" + lg.data.slice(2, 66)) });
        }
      }
    }
    // marca de tiempo por bloque (2 s por bloque en Base, suficiente para intervalos)
    const nowTs = Math.floor(Date.now() / 1000);
    const tsOf = (b) => nowTs - (head - b) * 2;
    const out = {};
    for (const s of this.strats) {
      const rec = per.get(s.address.toLowerCase());
      const ev = rec.events.sort((a, b) => a.block - b.block);
      const feeByTx = new Map(rec.fees.map((f) => [f.tx, f.callFee]));
      const blocks = [...new Set(ev.map((e) => e.block))];
      const intervals = []; for (let i = 1; i < blocks.length; i++) intervals.push((blocks[i] - blocks[i - 1]) * 2);
      const callFees = ev.map((e) => feeByTx.get(e.tx)).filter((x) => x !== undefined);
      const harvesters = {}; for (const e of ev) harvesters[e.harvester] = (harvesters[e.harvester] ?? 0) + 1;
      const last = blocks.length ? blocks[blocks.length - 1] : null;
      const intervalMed = median(intervals);
      out[s.address] = {
        id: s.id, n: blocks.length, intervalMed, intervalMin: intervals.length ? Math.min(...intervals) : null,
        callFeeMedWei: callFees.length ? median(callFees.map(Number)) : null, callFeeMaxWei: callFees.length ? Math.max(...callFees.map(Number)) : null,
        lastBlock: last, lastTs: last ? tsOf(last) : null, nextTs: last && intervalMed ? tsOf(last) + intervalMed : null,
        topHarvester: Object.entries(harvesters).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, harvesters: Object.keys(harvesters).length,
      };
    }
    this.hist = { at: Date.now(), head, days: this.cfg_hist() / 43200, strats: out, failedChunks: failed };
    await this.store.set("harvestHist", this.hist);
    const withData = Object.values(out).filter((x) => x.n >= 2);
    await this.diag(`harvest: historial de ${this.hist.days.toFixed(1)} días · ${withData.length}/${this.strats.length} estrategias con ≥2 harvests · intervalo mediano ${median(withData.map((x) => x.intervalMed)) ? (median(withData.map((x) => x.intervalMed)) / 3600).toFixed(1) + " h" : "—"}`);
  }
  cfg_hist() { return this.limits.historyBlocks; }

  /** Estrategias cuya ventana de harvest previsto está cerca (según el historial). */
  dueSoon(nowTs) {
    if (!this.hist) return [];
    const out = [];
    for (const [addr, x] of Object.entries(this.hist.strats)) {
      if (!x.nextTs || !x.intervalMed) continue;
      // última cosecha real conocida (lastHarvest de la estrategia, si se leyó) actualiza la previsión
      const lh = this.lastHarvestOf?.get(addr);
      const base = lh && lh > x.lastTs ? lh : x.lastTs;
      const next = base + x.intervalMed;
      if (nowTs >= next - this.cfg.leadSec && nowTs <= next + x.intervalMed) out.push({ addr, id: x.id, next, inSec: next - nowTs, callFeeMedWei: x.callFeeMedWei });
    }
    return out;
  }

  async save() { this.h.updatedAt = Date.now(); await this.store.set("harvest", this.h); }

  /** Lista de estrategias activas de Beefy en Base desde su API pública. */
  async discover() {
    try {
      const r = await fetch(BEEFY_API, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const all = await r.json();
      const base = all.filter((v) => v.chain === "base" && v.status === "active" && v.strategy && /^0x[0-9a-fA-F]{40}$/.test(v.strategy));
      this.strats = base.map((v) => ({ address: ethers.getAddress(v.strategy), id: v.id, name: v.name, platform: v.platformId, token: v.token }));
      await this.store.set("beefy", { at: Date.now(), strats: this.strats });
      this.h.lastDiscovery = Date.now(); this.h.strategies = this.strats.length;
      await this.diag(`harvest: ${this.strats.length} estrategias activas de Beefy en Base (api.beefy.finance)`);
    } catch (e) {
      this.h.lastError = `descubrimiento: ${e.shortMessage || e.message}`;
      await this.diag(`harvest: no se pudo leer la lista de Beefy (${this.h.lastError}); ${this.strats.length} estrategias en caché`);
    }
  }

  /** Llamado en cada bloque; escanea callReward cada `scanEvery` bloques y ejecuta si conviene. */
  async onBlock({ block, ts, gas, ethUsd }) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.h.pending.length) await this.reconcile(ethUsd);
      if (Date.now() - (this.h.lastDiscovery ?? 0) > 6 * 3600_000) await this.discover();
      if (!this.strats.length) return;
      const dueNow = this.dueSoon(ts);
      if (block % this.limits.scanEvery !== 0 && !(dueNow.length && block % 5 === 0)) return;
      await this.scan({ block, ts, gas, ethUsd });
    } catch (e) {
      this.h.lastError = `bloque ${block}: ${e.shortMessage || e.message}`;
    } finally { this.busy = false; }
  }

  async scan({ block, ts, gas, ethUsd }) {
    const calls = this.strats.flatMap((s) => [[s.address, this.iface.encodeFunctionData("callReward")], [s.address, this.iface.encodeFunctionData("lastHarvest")]]);
    const res = await core.multicall(ethers, this.provider, calls);
    const gasPrice = gas.baseFee + gas.priority;
    const rows = [];
    this.lastHarvestOf ??= new Map();
    this.strats.forEach((s, i) => {
      const cr = res[2 * i], lh = res[2 * i + 1];
      const lastHarvest = lh ? Number(BigInt(lh)) : null;
      if (lastHarvest) this.lastHarvestOf.set(s.address, lastHarvest);
      if (!cr) return; // la estrategia no expone callReward(): no se puede estimar
      const reward = BigInt(cr);
      const rewardUsd = (Number(reward) / 1e18) * ethUsd; // WETH
      const gasUsd = (Number(core.HARVEST_GAS * gasPrice + gas.l1Fee) / 1e18) * ethUsd;
      rows.push({ address: s.address, id: s.id, platform: s.platform, rewardUsd, gasUsd, netUsd: rewardUsd - gasUsd, sinceMin: lastHarvest ? Math.round((ts - lastHarvest) / 60) : null, worth: rewardUsd >= gasUsd * this.limits.rewardOverGas && rewardUsd - gasUsd >= this.limits.minNetUsd });
    });
    // callReward() no tiene unidad fiable (en Base muchas estrategias lo devuelven en el token de recompensa, no en WETH):
    // sirve solo para ordenar. La comisión real se MIDE simulando el harvest y comparando el saldo WETH de la wallet.
    rows.sort((a, b) => b.rewardUsd - a.rewardUsd);
    const wallet = this.executor?.wallet;
    // prioridad: las que el historial prevé a punto de cosecharse; luego las de mayor callReward
    const due = new Set(this.dueSoon(ts).map((d) => d.addr));
    for (const r of rows) r.due = due.has(r.address);
    rows.sort((a, b) => (b.due - a.due) || (b.rewardUsd - a.rewardUsd));
    const top = rows.filter((r) => r.rewardUsd > 0 || r.due).slice(0, Number(process.env.HARVEST_QUOTE_TOP ?? 25));
    if (wallet && top.length) {
      const quotes = await this.quoteFees(top, wallet.address, ethUsd);
      for (const r of top) { const q = quotes.get(r.address); r.feeUsd = q ? q.feeUsd : null; r.quoteError = q ? q.error : "sin cotización"; r.netUsd = q && q.feeUsd !== null ? q.feeUsd - r.gasUsd : null; r.worth = r.netUsd !== null && q.feeUsd >= r.gasUsd * this.limits.rewardOverGas && r.netUsd >= this.limits.minNetUsd; }
      for (const r of rows) if (!top.includes(r)) { r.feeUsd = null; r.netUsd = null; r.worth = false; }
    } else for (const r of rows) { r.feeUsd = null; r.netUsd = null; r.worth = false; }
    rows.sort((a, b) => (b.netUsd ?? -1e9) - (a.netUsd ?? -1e9));
    for (const r of rows) { const x = this.hist?.strats?.[r.address]; if (x) { r.intervalMed = x.intervalMed; r.callFeeMedUsd = x.callFeeMedWei !== null ? (x.callFeeMedWei / 1e18) * ethUsd : null; r.nextInSec = x.nextTs ? ((this.lastHarvestOf.get(r.address) && this.lastHarvestOf.get(r.address) > x.lastTs ? this.lastHarvestOf.get(r.address) : x.lastTs) + x.intervalMed) - ts : null; r.topHarvester = x.topHarvester; r.nHarvests = x.n; } }
    this.h.candidates = rows.slice(0, 12); this.h.worthNow = rows.filter((r) => r.worth).length;
    this.h.dueNow = rows.filter((r) => r.due).length;
    this.h.lastScan = Date.now(); this.h.scanBlock = block;
    const measured = rows.filter((r) => r.feeUsd !== null && r.feeUsd !== undefined);
    if (measured.length && (this.h.worthNow || block % (this.limits.scanEvery * 10) === 0)) await this.diag(`harvest: ${measured.length} comisiones medidas · ${this.h.worthNow} rentables · top: ${measured.slice(0, 3).map((r) => `${r.id} $${r.feeUsd.toFixed(4)} vs gas $${r.gasUsd.toFixed(4)}`).join(" · ")}`);
    for (const r of rows.filter((x) => x.worth).slice(0, 3)) {
      if (!wallet) break;
      await this.attempt(r, { block, ts, gas, ethUsd });
    }
    await this.save();
  }

  /** Comisión real en WETH de cada harvest: [balanceOf, harvest(wallet), balanceOf] en un solo eth_call por estrategia. */
  async quoteFees(rows, wallet, ethUsd) {
    const WETH = core.TOKENS.WETH.address;
    const bal = this.iface.encodeFunctionData("balanceOf", [wallet]);
    const out = new Map();
    await Promise.all(rows.map(async (r) => {
      const calls = [[WETH, true, bal], [r.address, true, this.iface.encodeFunctionData("harvest(address)", [wallet])], [WETH, true, bal]];
      try {
        const raw = await this.provider.call({ to: core.MULTICALL3, from: wallet, data: this.iface.encodeFunctionData("aggregate3", [calls.map(([target, allowFailure, callData]) => ({ target, allowFailure, callData }))]) });
        const [res] = this.iface.decodeFunctionResult("aggregate3", raw);
        if (!res[1].success) { out.set(r.address, { feeUsd: null, error: "harvest revertiría en simulación" }); return; }
        const b0 = BigInt(res[0].returnData), b1 = BigInt(res[2].returnData);
        out.set(r.address, { feeUsd: (Number(b1 - b0) / 1e18) * ethUsd, error: null });
      } catch (e) { out.set(r.address, { feeUsd: null, error: (e.shortMessage || e.message).slice(0, 60) }); }
    }));
    return out;
  }

  async attempt(r, { block, ts, gas, ethUsd }) {
    const wallet = this.executor.wallet;
    const rec = { block, ts, strategy: r.address, id: r.id, rewardUsd: r.feeUsd ?? r.rewardUsd, ok: false, reason: null, gasUsd: null, netUsd: null, sent: null };
    let data = this.iface.encodeFunctionData("harvest(address)", [wallet.address]);
    let tx = { to: r.address, from: wallet.address, data };
    let gasEst;
    try { gasEst = await this.provider.estimateGas(tx); }
    catch (e1) {
      try { data = this.iface.encodeFunctionData("harvest()", []); tx = { to: r.address, from: wallet.address, data }; gasEst = await this.provider.estimateGas(tx); }
      catch (e2) { rec.reason = (e2.shortMessage || e2.message).slice(0, 80); this.h.simulated++; this.h.wouldRevert++; this.push(rec); return; }
    }
    rec.gasUsd = (Number(gasEst * (gas.baseFee + gas.priority) + gas.l1Fee) / 1e18) * ethUsd;
    rec.netUsd = (r.feeUsd ?? 0) - rec.gasUsd; rec.ok = true; rec.gasEst = Number(gasEst);
    if (r.feeUsd !== null && r.feeUsd !== undefined && r.feeUsd < rec.gasUsd * this.limits.rewardOverGas) { rec.sent = `omitida: comisión medida $${r.feeUsd.toFixed(4)} < ${this.limits.rewardOverGas}× gas real $${rec.gasUsd.toFixed(4)}`; this.push(rec); return; }
    this.h.simulated++; this.h.wouldSucceed++;
    if (this.mode !== "live" || rec.netUsd < this.limits.minNetUsd) { rec.sent = this.mode !== "live" ? "modo simulación" : "omitida: neto < mínimo"; this.push(rec); return; }
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
    if (this.sentTimes.length >= this.limits.maxPerHour) { rec.sent = "omitida: tope por hora"; this.push(rec); return; }
    try {
      const prio = gas.priority > core.MIN_PRIORITY_WEI ? gas.priority : core.MIN_PRIORITY_WEI;
      const sent = await this.executor.withSender((w) => w.sendTransaction({ to: r.address, data, gasLimit: (gasEst * 13n) / 10n, maxFeePerGas: gas.baseFee * 3n + prio, maxPriorityFeePerGas: prio }));
      this.sentTimes.push(now); this.h.sent++; rec.sent = sent.hash;
      this.h.pending.push({ hash: sent.hash, sentAt: now, id: r.id, strategy: r.address, rewardUsd: r.feeUsd ?? r.rewardUsd });
      await this.diag(`harvest: enviada ${sent.hash} · ${r.id} · comisión medida $${(r.feeUsd ?? 0).toFixed(4)} vs gas $${rec.gasUsd.toFixed(4)}`);
    } catch (e) { rec.sent = `error al enviar: ${e.shortMessage || e.message}`; this.h.lastError = rec.sent; await this.diag(`harvest: ${rec.sent}`); }
    this.push(rec);
  }

  push(rec) { this.h.recent.unshift(rec); if (this.h.recent.length > MAX_RECENT) this.h.recent.length = MAX_RECENT; }

  async reconcile(ethUsd) {
    const keep = [];
    const WETH = core.TOKENS.WETH.address.toLowerCase();
    const wallet = this.executor?.wallet?.address?.toLowerCase();
    for (const t of this.h.pending) {
      let rcpt = null;
      try { rcpt = await this.provider.getTransactionReceipt(t.hash); } catch { /* red */ }
      if (!rcpt) { if (Date.now() - t.sentAt > 15 * 60_000) { this.h.dropped++; await this.diag(`harvest: ${t.hash} no minada en 15 min`); } else keep.push(t); continue; }
      const paid = (Number(rcpt.gasUsed * (rcpt.gasPrice ?? 0n)) / 1e18) * ethUsd;
      this.h.gasPaidUsd += paid;
      const rec = this.h.recent.find((x) => x.sent === t.hash);
      if (rcpt.status === 1) {
        let got = 0n;
        for (const l of rcpt.logs) {
          if (l.address.toLowerCase() !== WETH) continue;
          try { const ev = this.iface.parseLog(l); if (ev && ev.name === "Transfer" && ev.args.to.toLowerCase() === wallet) got += ev.args.value; } catch { /* otro evento */ }
        }
        const gotUsd = (Number(got) / 1e18) * ethUsd;
        this.h.confirmed++; this.h.rewardUsd += gotUsd; this.h.realizedUsd += gotUsd - paid;
        if (rec) rec.sent = `${t.hash} · confirmada · +$${(gotUsd - paid).toFixed(4)}`;
        await this.diag(`harvest: confirmada ${t.hash} · ${t.id} · recompensa $${gotUsd.toFixed(4)} − gas $${paid.toFixed(4)} = ${gotUsd - paid >= 0 ? "+" : ""}$${(gotUsd - paid).toFixed(4)}`);
      } else {
        this.h.reverted++; this.h.realizedUsd -= paid;
        if (rec) rec.sent = `${t.hash} · revertida (gas $${paid.toFixed(4)})`;
        await this.diag(`harvest: revertida ${t.hash} · ${t.id} · gas perdido $${paid.toFixed(4)}`);
      }
    }
    this.h.pending = keep;
    await this.save();
  }
}
