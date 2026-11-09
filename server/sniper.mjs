// Radar "sniper" (F0, doc 22): vigila los vaults CLM de Beefy de esta cadena para anticipar y detectar éxodos de TVL
// mientras las emisiones siguen (caso AI-USDG, 2026-11-07: el TVL cayó de $61.7k a $53 en < 45 min y los que se quedaron
// cobraron emisiones pensadas para $62k). Solo lee y avisa: no envía transacciones.
//   · lista y APY de api.beefy.finance cada 15 min; TVL on-chain (balance/totalSupply × precio del CLM) cada SNIPER_EVERY_MIN
//   · E = emisiones en $/día del vault (TVL × tasa diaria del APY) y E medido por el crecimiento del ppfs (vaults que componen)
//   · concentración: mayores depositantes reconstruidos con los Transfer de las participaciones (escaneo incremental)
//   · gauge: rewardRate / periodFinish (si la estrategia lo expone) → horas hasta que se acaban las emisiones
//   · señales: pre-éxodo, éxodo de token y éxodo (ver detectSignals); historial de 48 h; GET /api/sniper
//   · SNIPER_INSPECT="<vault>@<desde ISO>/<hasta ISO>": diagnóstico único de quién retiró en una ventana
import { ethers } from "ethers";
import * as core from "../src/core.js";

const API = "https://api.beefy.finance";
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ZERO32 = ethers.zeroPadValue("0x", 32);
const I = new ethers.Interface([
  "function balance() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function strategy() view returns (address)",
  "function gauge() view returns (address)",
  "function rewardPool() view returns (address)",
  "function periodFinish() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function rewardToken() view returns (address)",
]);
const STABLES = new Set(["USDG", "USDC", "USDT", "USD₮0", "USDC.E", "DAI", "WETH", "ETH", "WBNB", "USDT0"]);
const USD = new Set(["USDG", "USDC", "USDT", "USD₮0", "USDC.E", "DAI", "USDT0", "USDBC"]);
const HOUR = 3600_000;

/** Tasa diaria equivalente a un APY en % (en espacio logarítmico: APY de 10²⁹ % no desborda). */
export function dailyFromApy(apyPct) {
  if (!(apyPct > 0)) return 0;
  return Math.expm1(Math.log1p(apyPct / 100) / 365);
}
/** Emisiones en $/día de un vault: TVL × tasa diaria. */
export const emissionsPerDay = (tvl, apyPct) => (tvl > 0 ? tvl * dailyFromApy(apyPct) : 0);
/** Tamaño óptimo x* = √(E·T/r) − T (rendimiento marginal = r) y ganancia diaria esperada. */
export function optimalSize(E, T, r = 0.02) {
  if (!(E > 0) || !(T >= 0) || !(r > 0)) return { x: 0, perDay: 0 };
  const x = Math.max(0, Math.sqrt((E * Math.max(T, 1)) / r) - T);
  return { x, perDay: x > 0 ? (E * x) / (T + x) : 0 };
}
/** Valor de la serie más cercano a `ms` atrás (o null). ser: [{t, tvl, E?, pp?}] ordenada. */
export function at(ser, msAgo, now = Date.now()) {
  const target = now - msAgo; let best = null;
  for (const p of ser) { if (p.t <= target) best = p; else break; }
  return best;
}

/**
 * Señales de un vault sobre su serie (pura, probada):
 *  - "éxodo": el TVL cae a ≤ 50 % del máximo de los últimos 60 min (máximo ≥ minTvl) y las emisiones de antes eran ≥ minE.
 *  - "pre-éxodo": el TVL baja ≥ 5 % en 2 h (TVL ≥ 5×minTvl) con E estable (±15 %): el APY sube solo porque se va el TVL.
 */
export function detectSignals(ser, { now = Date.now(), minTvl = 1000, minE = 20 } = {}) {
  const out = [];
  if (!ser?.length) return out;
  const q = (p) => p.amt ?? p.tvl; // unidades del CLM en el vault: bajan solo por retiros (el TVL en $ también se mueve con el precio)
  const cur = ser[ser.length - 1];
  const win = ser.filter((p) => p.t >= now - HOUR);
  const peak = win.reduce((m, p) => (q(p) > (m ? q(m) : -1) ? p : m), null);
  if (peak && peak.tvl >= minTvl && q(cur) <= q(peak) * 0.5 && (peak.E ?? 0) >= minE)
    out.push({ kind: "éxodo", fromTvl: peak.tvl, toTvl: cur.tvl, dropPct: (1 - q(cur) / q(peak)) * 100, E: peak.E, minutes: Math.round((cur.t - peak.t) / 60_000) });
  const h2 = at(ser, 2 * HOUR, now);
  if (h2 && h2.tvl >= 5 * minTvl && q(cur) <= q(h2) * 0.95 && q(cur) > q(h2) * 0.5 && h2.E >= minE && cur.E >= h2.E * 0.85 && cur.E <= h2.E * 1.15)
    out.push({ kind: "pre-éxodo", fromTvl: h2.tvl, toTvl: cur.tvl, dropPct: (1 - q(cur) / q(h2)) * 100, E: cur.E });
  return out;
}
/** Éxodo de token: ≥ 2 vaults del mismo token volátil (TVL ≥ $2k hace 6 h) perdiendo ≥ 10 % en 6 h. rows: [{token, tvl6h, tvl}] */
export function tokenExodus(rows) {
  const by = {};
  for (const r of rows) if (r.token && r.tvl6h >= 2000 && r.tvl <= r.tvl6h * 0.9) (by[r.token] ??= []).push(r);
  return Object.entries(by).filter(([, v]) => v.length >= 2).map(([token, v]) => ({ token, vaults: v.map((x) => x.id), dropPct: (1 - v.reduce((s, x) => s + x.tvl, 0) / v.reduce((s, x) => s + x.tvl6h, 0)) * 100 }));
}
/** Parte del mayor depositante y de los 3 mayores (balances en string crudo). */
export function concentration(bals) {
  const xs = Object.entries(bals).map(([a, b]) => [a, BigInt(b)]).filter(([, b]) => b > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const tot = xs.reduce((s, [, b]) => s + b, 0n);
  if (tot === 0n) return { holders: 0, top1: null, top3: null, topAddr: null };
  const pct = (b) => Number((b * 10000n) / tot) / 100;
  return { holders: xs.length, top1: pct(xs[0][1]), top3: pct(xs.slice(0, 3).reduce((s, [, b]) => s + b, 0n)), topAddr: xs[0][0] };
}

export class Sniper {
  constructor({ provider, store, diag, chainKey }) {
    this.p = provider; this.store = store; this.diag = diag; this.chain = chainKey;
    this.everyMs = Number(process.env.SNIPER_EVERY_MIN ?? 5) * 60_000;
    this.minE = Number(process.env.SNIPER_MIN_E ?? 20);
    this.watchN = Number(process.env.SNIPER_WATCH ?? 15);
    this.v = new Map(); this.alerts = []; this.nextAt = 0; this.listAt = 0; this.busy = false; this.saveAt = 0; this.reportAt = 0;
  }
  get wanted() { return process.env.SNIPER !== "0" && ["robinhood", "base", "bsc", "arbitrum", "optimism", "polygon"].includes(this.chain); }
  async init() {
    const s = (await this.store.get("sniper")) ?? {};
    this.alerts = s.alerts ?? []; this.inspected = s.inspected ?? {};
    for (const x of s.vaults ?? []) this.v.set(x.id, x);
  }
  async save() {
    await this.store.set("sniper", { alerts: this.alerts.slice(-200), inspected: this.inspected, vaults: [...this.v.values()].map((x) => (x.watch ? x : { ...x, ser: (x.ser ?? []).slice(-90) })) });
  }

  async onBlock(ctx) {
    if (!this.wanted || this.busy || Date.now() < this.nextAt) return;
    this.busy = true; this.nextAt = Date.now() + this.everyMs;
    try {
      if (Date.now() - this.listAt > 15 * 60_000) await this.refreshList();
      await this.tick();
      await this.holdersStep().catch((e) => { this.holdersError = (e.shortMessage || e.message || String(e)).slice(0, 160); });
      await this.inspect().catch((e) => this.diag(`sniper: diagnóstico falló · ${(e.shortMessage || e.message).slice(0, 160)}`));
      if (Date.now() - this.reportAt > HOUR) { this.reportAt = Date.now(); await this.diag(`sniper ${this.chain}: ${this.summaryLine()}`); }
      if (Date.now() - this.saveAt > 30 * 60_000) { this.saveAt = Date.now(); await this.save(); }
    } catch (e) { this.lastError = (e.shortMessage || e.message || String(e)).slice(0, 200); await this.diag(`sniper ${this.chain}: error ${this.lastError}`); }
    finally { this.busy = false; }
  }

  /** Lista de vaults CLM de la cadena con TVL y APY de Beefy; fija el precio del CLM (USD por unidad) contra el saldo on-chain. */
  async refreshList() {
    const get = async (path) => { const r = await fetch(API + path, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); };
    const [vs, gs, tvl, apy] = await Promise.all([get("/vaults"), get("/gov-vaults").catch(() => []), get("/tvl"), get("/apy")]);
    const tv = {}; for (const b of Object.values(tvl ?? {})) for (const [k, x] of Object.entries(b ?? {})) tv[k] = Number(x) || 0;
    const list = [...vs, ...gs.map((g) => ({ ...g, type: "gov" }))].filter((v) => v.chain === this.chain && v.status === "active" && v.type !== "cowcentrated" && /-cow-/.test(v.id) && ethers.isAddress(v.earnContractAddress ?? ""));
    const amts = await core.multicall(ethers, this.p, list.map((v) => [v.earnContractAddress, I.encodeFunctionData(v.type === "gov" ? "totalSupply" : "balance")]));
    for (let i = 0; i < list.length; i++) {
      const v = list[i], raw = amts[i];
      const x = this.v.get(v.id) ?? { id: v.id, ser: [] };
      Object.assign(x, { name: v.name, addr: v.earnContractAddress, gov: v.type === "gov", clm: v.tokenAddress ?? null, assets: v.assets ?? [], createdAt: v.createdAt ?? null, apiTvl: tv[v.id] ?? 0, apy: Number(apy?.[v.id] ?? 0) * 100 });
      x.token = (x.assets.find((a) => !STABLES.has(String(a).toUpperCase())) ?? null);
      x.Eapi = emissionsPerDay(x.apiTvl, x.apy);
      const amt = raw ? Number(ethers.formatUnits(BigInt(raw), 18)) : 0;
      if (amt > 0 && x.apiTvl > 0) x.lp = x.apiTvl / amt;
      x.depTokens = (v.depositTokenAddresses ?? []).filter((a) => ethers.isAddress(a));
      x.usdPair = x.assets.some((a) => USD.has(String(a).toUpperCase()));
      if (this.chain !== "robinhood") x.stock = false; // las restricciones de transferencia solo aplican a los Stock Tokens de Robinhood
      this.v.set(v.id, x);
    }
    // símbolos on-chain (una vez por vault): los Stock Tokens de Robinhood (sufijo "rh") solo se transfieren entre wallets aprobadas
    const need = [...this.v.values()].filter((x) => x.syms === undefined && x.depTokens?.length && x.Eapi >= this.minE);
    if (need.length) {
      const S = new ethers.Interface(["function symbol() view returns (string)"]);
      const flat = need.flatMap((x) => x.depTokens.map((t) => [t, S.encodeFunctionData("symbol")]));
      const r = await core.multicall(ethers, this.p, flat).catch(() => []);
      let k = 0;
      for (const x of need) { x.syms = x.depTokens.map(() => { const raw = r[k++]; try { return raw ? S.decodeFunctionResult("symbol", raw)[0] : null; } catch { return null; } }); x.stock = this.chain === "robinhood" && x.syms.some((y) => /rh$/i.test(y ?? "")); }
    }
    // conjunto vigilado: los de mayores emisiones (y todo lo que ya tenía alerta abierta)
    const ranked = [...this.v.values()].filter((x) => x.Eapi >= this.minE && x.apiTvl >= 500).sort((a, b) => b.Eapi - a.Eapi);
    const watch = new Set(ranked.slice(0, this.watchN).map((x) => x.id));
    for (const x of this.v.values()) x.watch = watch.has(x.id);
    this.listAt = Date.now();
    if (!this.gaugeAt || Date.now() - this.gaugeAt > 6 * HOUR) { this.gaugeAt = Date.now(); await this.gauges(ranked.slice(0, this.watchN)).catch(() => {}); }
  }

  /** TVL on-chain de todos los vaults, serie de 48 h, E medido por ppfs y señales. */
  async tick() {
    const xs = [...this.v.values()].filter((x) => x.lp > 0);
    if (!xs.length) return;
    const calls = [];
    for (const x of xs) { calls.push([x.addr, I.encodeFunctionData(x.gov ? "totalSupply" : "balance")]); calls.push([x.addr, I.encodeFunctionData("getPricePerFullShare")]); }
    const res = await core.multicall(ethers, this.p, calls);
    const now = Date.now(), rows = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], a = res[2 * i], pp = res[2 * i + 1];
      if (!a) continue;
      const tvl = Number(ethers.formatUnits(BigInt(a), 18)) * x.lp;
      // E: las emisiones no dependen del TVL → se usa el último E de la API (se refresca cada 15 min)
      const pt = { t: now, tvl: +tvl.toFixed(2), amt: +Number(ethers.formatUnits(BigInt(a), 18)).toPrecision(8), E: +(x.Eapi ?? 0).toFixed(2) };
      if (pp && !x.gov) pt.pp = BigInt(pp).toString();
      (x.ser ??= []).push(pt);
      x.ser = x.ser.filter((p) => p.t >= now - (x.watch ? 48 : 7) * HOUR); // 48 h de los vigilados; 7 h del resto (alcanza para las señales)
      x.tvl = pt.tvl;
      // E medido: crecimiento del ppfs en la última hora × TVL (lo que de verdad pagó el vault, ya sin comisiones de Beefy)
      const h1 = at(x.ser, HOUR, now);
      if (h1?.pp && pt.pp && BigInt(h1.pp) > 0n && now - h1.t > 20 * 60_000) { const g = Number(BigInt(pt.pp) * 1_000_000n / BigInt(h1.pp)) / 1e6 - 1; x.Emeas = +(g * (24 * HOUR / (now - h1.t)) * tvl).toFixed(2); }
      const h6 = at(x.ser, 6 * HOUR, now);
      if (h6) rows.push({ id: x.id, token: x.token, tvl6h: h6.tvl, tvl: h6.amt ? h6.tvl * (pt.amt / h6.amt) : tvl });
      for (const s of detectSignals(x.ser, { now, minE: this.minE })) await this.alert(x, s);
    }
    for (const t of tokenExodus(rows)) await this.alert({ id: `token:${t.token}`, name: t.token }, { kind: "éxodo de token", ...t });
  }

  async alert(x, s) {
    const key = `${x.id}|${s.kind}`, now = Date.now();
    const last = this.alerts.findLast?.((a) => a.key === key) ?? [...this.alerts].reverse().find((a) => a.key === key);
    const cool = s.kind === "éxodo" ? 2 * HOUR : 6 * HOUR;
    if (last && now - last.t < cool) return;
    const T = x.tvl ?? s.toTvl ?? 0, E = s.E ?? x.Eapi ?? 0;
    const size = s.kind === "éxodo" ? optimalSize(E, T) : null;
    const conc = x.holders?.c ? ` · mayor depositante ${x.holders.c.top1 ?? "?"} %` : "";
    const gauge = x.gauge?.hoursLeft != null ? ` · emisiones del gauge por ${x.gauge.hoursLeft.toFixed(0)} h` : "";
    const a = { t: now, key, id: x.id, kind: s.kind, s, T, E };
    if (s.kind === "éxodo" && x.addr) (this.requests ??= []).push({ key: `${x.id}|${now}`, id: x.id, at: now, E, T, stock: !!x.stock, gov: !!x.gov });
    this.alerts.push(a); if (this.alerts.length > 200) this.alerts.shift();
    const txt = s.kind === "éxodo de token"
      ? `${s.token}: ${s.vaults.length} vaults pierden TVL (−${s.dropPct.toFixed(0)} % en 6 h) · ${s.vaults.join(", ")}`
      : `${x.name} (${x.id}) · TVL $${Math.round(s.fromTvl)} → $${Math.round(s.toTvl)} (−${s.dropPct.toFixed(0)} %${s.minutes != null ? ` en ${s.minutes} min` : " en 2 h"}) · emisiones ~$${Math.round(E)}/día${conc}${gauge}${size ? ` · tamaño óptimo ~$${Math.round(size.x)} → ~$${Math.round(size.perDay)}/día si las emisiones siguen` : ""}`;
    await this.diag(`sniper ALERTA ${s.kind} · ${txt}`);
  }

  /** Concentración de depositantes: Transfer de las participaciones del vault, escaneo incremental (presupuesto por vuelta). */
  async holdersStep() {
    const ws = [...this.v.values()].filter((x) => x.watch && x.createdAt).sort((a, b) => (b.Eapi ?? 0) - (a.Eapi ?? 0));
    let budget = Number(process.env.SNIPER_LOG_BUDGET ?? 12);
    const head = await this.p.getBlockNumber();
    for (const x of ws) {
      if (budget <= 0) break;
      const h = (x.holders ??= { bals: {}, from: null, span: 50_000 });
      if (h.from == null) { try { h.from = await this.blockAt(x.createdAt * 1000 - HOUR, head); } catch { continue; } budget -= 2; }
      while (h.from <= head && budget > 0) {
        const to = Math.min(head, h.from + h.span - 1);
        budget--;
        let logs;
        try { logs = await this.p.getLogs({ address: x.addr, topics: [TRANSFER], fromBlock: h.from, toBlock: to }); }
        catch (e) { if (h.span > 1000) { h.span = Math.floor(h.span / 4); continue; } h.error = (e.shortMessage || e.message || "").slice(0, 120); break; }
        for (const l of logs) {
          const from = ethers.dataSlice(l.topics[1], 12).toLowerCase(), dest = ethers.dataSlice(l.topics[2], 12).toLowerCase(), amt = BigInt(l.data);
          if (from !== ethers.ZeroAddress) h.bals[from] = String(BigInt(h.bals[from] ?? "0") - amt);
          if (dest !== ethers.ZeroAddress) h.bals[dest] = String(BigInt(h.bals[dest] ?? "0") + amt);
        }
        for (const [k, b] of Object.entries(h.bals)) if (BigInt(b) <= 0n) delete h.bals[k];
        h.from = to + 1;
        if (logs.length < 500 && h.span < 2_000_000) h.span *= 2;
      }
      h.done = h.from > head;
      if (h.done) h.c = concentration(h.bals);
    }
  }
  async blockAt(ms, head) {
    // sin lecturas de bloques viejos (algunos nodos públicos piden token para "archive"): tiempo de bloque medido en los
    // últimos 2,000 bloques y, si hace falta, ajuste con bloques ya cercanos al objetivo
    head ??= await this.p.getBlockNumber();
    const [hb, pb] = await Promise.all([this.p.getBlock(head), this.p.getBlock(Math.max(0, head - 2000))]);
    const bt = Math.max(0.01, (hb.timestamp - pb.timestamp) / Math.min(2000, head));
    let b = Math.max(0, Math.floor(head - (hb.timestamp - ms / 1000) / bt));
    for (let i = 0; i < 4; i++) { try { const x = await this.p.getBlock(b); if (!x) break; const d = Math.round((x.timestamp - ms / 1000) / bt); if (Math.abs(d) < 50) break; b = Math.max(0, Math.min(head, b - d)); } catch { break; } }
    return b;
  }

  /** Gauge de la estrategia (si lo expone): ritmo de recompensa y horas hasta periodFinish. */
  async gauges(xs) {
    const c = async (to, fn, args = []) => I.decodeFunctionResult(fn, await this.p.call({ to, data: I.encodeFunctionData(fn, args) }));
    for (const x of xs) {
      try {
        const clm = x.clm; if (!clm) continue;
        const [strat] = await c(clm, "strategy");
        let g = null; for (const fn of ["gauge", "rewardPool"]) { try { [g] = await c(strat, fn); if (g && g !== ethers.ZeroAddress) break; } catch {} }
        if (!g) continue;
        const [pf] = await c(g, "periodFinish"); let rate = null, tok = null;
        try { [rate] = await c(g, "rewardRate"); [tok] = await c(g, "rewardToken"); } catch {}
        x.gauge = { addr: g, periodFinish: Number(pf), hoursLeft: Math.max(0, (Number(pf) * 1000 - Date.now()) / HOUR), rewardRate: rate != null ? String(rate) : null, rewardToken: tok, at: Date.now() };
      } catch {}
    }
  }

  /** SNIPER_INSPECT="<vault>@<desde ISO>/<hasta ISO>": retiros, depósitos y eventos de la estrategia en la ventana (una vez por valor). */
  async inspect() {
    const spec = process.env.SNIPER_INSPECT;
    if (!spec || this.inspected[spec]) return;
    const m = /^\s*(0x[0-9a-fA-F]{40})\s*@\s*([^/]+)\/(.+?)\s*$/.exec(spec);
    if (!m) { this.inspected[spec] = "formato inválido"; return; }
    const [, vault, a, b] = m;
    const head = await this.p.getBlockNumber();
    const fromB = await this.blockAt(Date.parse(a), head), toB = await this.blockAt(Date.parse(b), head);
    const x = [...this.v.values()].find((v) => v.addr?.toLowerCase() === vault.toLowerCase());
    const scan = async (address, topics) => { const out = []; let f = fromB, span = 20_000; while (f <= toB) { const t = Math.min(toB, f + span - 1); try { out.push(...(await this.p.getLogs({ address, topics, fromBlock: f, toBlock: t }))); f = t + 1; } catch { if (span > 500) span = Math.floor(span / 4); else throw new Error("eth_getLogs no responde"); } } return out; };
    const tr = await scan(vault, [TRANSFER]);
    const burns = {}, mints = {};
    const burnBlocks = [];
    for (const l of tr) { const fr = ethers.dataSlice(l.topics[1], 12).toLowerCase(), to = ethers.dataSlice(l.topics[2], 12).toLowerCase(), amt = BigInt(l.data); if (to === ethers.ZeroAddress) { burns[fr] = (burns[fr] ?? 0n) + amt; burnBlocks.push(l.blockNumber); } if (fr === ethers.ZeroAddress) mints[to] = (mints[to] ?? 0n) + amt; }
    let pp = 10n ** 18n; try { [pp] = I.decodeFunctionResult("getPricePerFullShare", await this.p.call({ to: vault, data: I.encodeFunctionData("getPricePerFullShare") })); } catch {}
    const usd = (sh) => (x?.lp ? Number(ethers.formatUnits((sh * pp) / 10n ** 18n, 18)) * x.lp : null);
    const fmt = (o) => Object.entries(o).sort((p, q) => (q[1] > p[1] ? 1 : -1)).slice(0, 5).map(([k, v]) => `${k} ${ethers.formatUnits(v, 18).slice(0, 10)} parts${usd(v) != null ? ` (~$${usd(v).toFixed(0)})` : ""}`).join(" | ") || "ninguno";
    let stratTxt = "";
    if (x?.clm) {
      try {
        const [strat] = I.decodeFunctionResult("strategy", await this.p.call({ to: x.clm, data: I.encodeFunctionData("strategy") }));
        const sl = await scan(strat, []); const byTopic = {}; for (const l of sl) { const k = l.topics[0]?.slice(0, 10) ?? "anon"; (byTopic[k] ??= []).push(l.blockNumber); }
        stratTxt = ` · eventos de la estrategia ${strat}: ${Object.entries(byTopic).map(([k, bs]) => `${k}×${bs.length} (bloques ${bs.slice(0, 3).join(",")}${bs.length > 3 ? "…" : ""})`).join(", ") || "ninguno"}`;
        const clmT = await scan(x.clm, [TRANSFER, null, ZERO32]); stratTxt += ` · CLM quemado (retiros del CLM) ${clmT.length} eventos`;
      } catch (e) { stratTxt = ` · estrategia: ${(e.shortMessage || e.message).slice(0, 80)}`; }
    }
    const msg = `sniper diagnóstico ${x?.name ?? vault} bloques ${fromB}–${toB} (${a} → ${b}): ${tr.length} Transfer · retiros (quema de participaciones, bloques ${burnBlocks.join(",") || "—"}): ${fmt(burns)} · depósitos: ${fmt(mints)}${stratTxt}`;
    this.inspected[spec] = new Date().toISOString();
    await this.diag(msg.slice(0, 3500));
  }

  /**
   * Candidatos a semilla (F1): E ≥ SNIPER_SEED_MIN_E ($100/día), TVL ≥ $5k, par con estable en dólares, sin Stock Tokens de
   * Robinhood; si un par tiene vault que compone y reward pool, el vault (ahí lo que deja el que sale se reparte, doc 22 §7).
   * Orden: E con un plus por concentración (no es filtro).
   */
  seedCandidates() {
    const minE = Number(process.env.SNIPER_SEED_MIN_E ?? 100);
    const ok = [...this.v.values()].filter((x) => x.Eapi >= minE && (x.apiTvl ?? 0) >= 5000 && x.usdPair && x.stock === false);
    const byPair = {};
    for (const x of ok) { const k = [...x.assets].map(String).sort().join("-"); const cur = byPair[k]; if (!cur || (cur.gov && !x.gov) || (cur.gov === x.gov && x.Eapi > cur.Eapi)) byPair[k] = x; }
    return Object.values(byPair).map((x) => ({ id: x.id, name: x.name, E: x.Eapi, tvl: x.tvl ?? x.apiTvl, score: x.Eapi * (1 + 0.5 * ((x.holders?.c?.top1 ?? 0) / 100)) })).sort((a, b) => b.score - a.score);
  }
  isSeedCandidate(id) { return this.seedCandidates().some((c) => c.id === id); }
  info(id) { return this.v.get(id) ?? null; }

  summaryLine() {
    const w = [...this.v.values()].filter((x) => x.watch).sort((a, b) => (b.Eapi ?? 0) - (a.Eapi ?? 0));
    const row = (x) => { const h1 = at(x.ser ?? [], HOUR), h6 = at(x.ser ?? [], 6 * HOUR); const d = (p) => (p?.tvl ? `${(((x.tvl ?? 0) / p.tvl - 1) * 100).toFixed(0)}%` : "—"); return `${x.name} TVL $${Math.round(x.tvl ?? x.apiTvl ?? 0)} (1h ${d(h1)}, 6h ${d(h6)}) E $${Math.round(x.Eapi ?? 0)}/d${x.Emeas != null ? ` medido $${Math.round(x.Emeas)}/d` : ""}${x.holders?.c ? ` top1 ${x.holders.c.top1}%` : x.holders ? " top1 …" : ""}${x.gauge?.hoursLeft != null ? ` gauge ${x.gauge.hoursLeft.toFixed(0)}h` : ""}`; };
    return `radar · ${this.v.size} vaults CLM, ${w.length} vigilados (E ≥ $${this.minE}/día) · ${w.map(row).join(" | ")}`;
  }
  /** Para /api/sniper */
  view() {
    const w = [...this.v.values()].filter((x) => x.watch).sort((a, b) => (b.Eapi ?? 0) - (a.Eapi ?? 0));
    return { chain: this.chain, at: Date.now(), vaults: this.v.size, lastError: this.lastError ?? null, watch: w.map((x) => ({ id: x.id, name: x.name, token: x.token, tvl: x.tvl, apiTvl: x.apiTvl, apyPct: x.apy, E: x.Eapi, Emeas: x.Emeas ?? null, per100: x.Eapi ? +(x.Eapi * 100 / ((x.tvl ?? x.apiTvl) + 100)).toFixed(2) : null, holders: x.holders?.c ?? null, holdersScan: x.holders ? (x.holders.done ? "completo" : `bloque ${x.holders.from}`) : null, gauge: x.gauge ?? null, ser: (x.ser ?? []).filter((_, i, a) => i % 3 === 0 || i === a.length - 1).map((p) => [p.t, p.tvl]) })), alerts: this.alerts.slice(-50).reverse(), seeds: this.seedCandidates().slice(0, 10), requests: (this.requests ?? []).slice(-20) };
  }
}
