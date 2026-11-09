// Espejo del dashboard de Beefy (app.beefy.com/dashboard/<wallet>): mismas columnas y mismas cuentas.
//   Resumen: Depositado (valor actual), Vaults, Rendimiento, Diario.
//   Por vault: Al depositar · Ahora · Rendimiento · PnL · APY · Diario.
// Método de Beefy (beefy-v2, licencia MIT, src/helpers/pnl.ts y selectors/analytics.ts), reimplementado aquí:
//   · historial de la wallet: clm-api.beefy.finance/api/v1/investor/<wallet>/timeline (CLM y clásicos) y, de respaldo,
//     databarn.beefy.finance/api/v1/beefy/timeline (clásicos); solo cuenta el tramo "actual" (desde la última vez que el
//     saldo quedó en 0);
//   · FIFO de acciones: cada depósito es un lote con su precio de entrada; cada retiro consume los lotes más viejos;
//   · CLM: "al depositar" = tokens 0/1 que quedan en los lotes × su precio al entrar; rendimiento = comisiones que el CLM
//     compuso (cosechas de clm-api × tu parte de las acciones en cada cosecha) + recompensas cobradas + pendientes;
//     PnL = ahora + cobradas + pendientes − al depositar;
//   · clásicos: "al depositar" = acciones restantes × ppfs de entrada × precio de entrada; rendimiento = (subyacente
//     ahora − subyacente al depositar) × precio actual; PnL = ahora − al depositar;
//   · diario = valor × totalDaily del APY de Beefy (apy/breakdown).
// "Ahora" usa el valor on-chain de cada posición (beefywallet.mjs), igual que Beefy usa el saldo en vivo.

import { beefyWallet } from "./beefywallet.mjs";

const CLM_API = "https://clm-api.beefy.finance/api/v1";
const DATABARN = "https://databarn.beefy.finance/api/v1";
const cache = new Map();
async function getJson(url, ttlMs, ms = 25_000) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < ttlMs) return c.data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname.slice(0, 40)}: HTTP ${r.status}`);
    const data = await r.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } catch (e) { if (c) return c.data; throw e; }
}

const N = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
const lc = (a) => String(a ?? "").toLowerCase();
const EPS = 1e-12;

/** Tramo actual del historial: entradas después de la última vez que el saldo de acciones quedó en ~0. */
export function currentSegment(entries) {
  const xs = [...entries].sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
  let start = 0;
  xs.forEach((e, i) => { if (Math.abs(N(e.share_balance)) <= EPS) start = i + 1; });
  return xs.slice(start);
}

/** FIFO de un vault clásico (acciones con ppfs y precio del subyacente). */
export function classicFifo(rows) {
  const lots = [];
  for (const r of rows) {
    const sh = N(r.shares);
    if (sh > 0) lots.push({ rem: sh, ppfs: N(r.ppfs), px: N(r.px) });
    else if (sh < 0) {
      let left = -sh;
      for (const l of lots) { if (left <= 0) break; const take = Math.min(l.rem, left); l.rem -= take; left -= take; }
    }
  }
  const live = lots.filter((l) => l.rem > EPS);
  const shares = live.reduce((s, l) => s + l.rem, 0);
  const underlyingAtDeposit = live.reduce((s, l) => s + l.rem * l.ppfs, 0);
  const usdAtDeposit = live.reduce((s, l) => s + l.rem * l.ppfs * l.px, 0);
  return { shares, underlyingAtDeposit, usdAtDeposit };
}

/** FIFO de un CLM (acciones con montos de token0/token1 y sus precios al entrar) + recompensas cobradas. */
export function clmFifo(rows) {
  const lots = []; let claimedUsd = 0; const claimed = {};
  for (const r of rows) {
    for (const c of r.claims ?? []) {
      const amt = N(c.claimed_amount);
      if (amt > 0) { const usd = amt * N(c.reward_to_usd); claimedUsd += usd; const k = lc(c.reward_address); (claimed[k] ??= { amount: 0, usd: 0 }); claimed[k].amount += amt; claimed[k].usd += usd; }
    }
    const sh = N(r.shares);
    if (sh > 0) lots.push({ rem: sh, t0: N(r.t0), t1: N(r.t1), p0: N(r.p0), p1: N(r.p1) });
    else if (sh < 0) {
      let left = -sh;
      for (const l of lots) {
        if (left <= 0 || l.rem <= EPS) continue;
        const take = Math.min(l.rem, left), f = take / l.rem;
        l.t0 -= l.t0 * f; l.t1 -= l.t1 * f; l.rem -= take; left -= take;
      }
    }
  }
  const live = lots.filter((l) => l.rem > EPS);
  const t0 = live.reduce((s, l) => s + l.t0, 0), t1 = live.reduce((s, l) => s + l.t1, 0);
  const c0 = live.reduce((s, l) => s + l.t0 * l.p0, 0), c1 = live.reduce((s, l) => s + l.t1 * l.p1, 0);
  return { shares: live.reduce((s, l) => s + l.rem, 0), token0: t0, token1: t1, entryPx0: t0 > 0 ? c0 / t0 : null, entryPx1: t1 > 0 ? c1 / t1 : null, usdAtDeposit: c0 + c1, claimedUsd, claimed };
}

/** Comisiones que el CLM compuso a tu favor: en cada cosecha posterior a tu primer depósito, tu saldo de acciones vigente
 *  × lo compuesto ÷ totalSupply, al precio de ese momento. */
export function clmHarvestShare(entries, harvests) {
  if (!entries.length || !Array.isArray(harvests)) return { usd: 0, amount0: 0, amount1: 0, n: 0 };
  const first = new Date(entries[0].datetime).getTime();
  const hs = harvests.map((h) => ({ ...h, t: new Date(h.timestamp).getTime() })).filter((h) => h.t > first).sort((a, b) => a.t - b.t);
  let i = 0, usd = 0, a0 = 0, a1 = 0, n = 0;
  for (const h of hs) {
    while (i < entries.length - 1 && new Date(entries[i + 1].datetime).getTime() < h.t) i++;
    const bal = N(entries[i].share_balance), ts = N(h.totalSupply);
    if (!(ts > 0) || !(bal > 0)) continue;
    const x0 = bal * N(h.compoundedAmount0) / ts, x1 = bal * N(h.compoundedAmount1) / ts;
    a0 += x0; a1 += x1; usd += x0 * N(h.token0ToUsd) + x1 * N(h.token1ToUsd); n++;
  }
  return { usd, amount0: a0, amount1: a1, n };
}

export async function beefyDashboard(address, { provider = null } = {}) {
  const w = await beefyWallet(address, { provider });
  const errors = [...(w.errors ?? [])];
  const [clmTl, dbTl] = await Promise.all([
    getJson(`${CLM_API}/investor/${w.address}/timeline`, 5 * 60_000).catch((e) => { errors.push(`timeline clm-api: ${e.message}`); return []; }),
    getJson(`${DATABARN}/beefy/timeline?address=${w.address}`, 5 * 60_000).catch((e) => { errors.push(`timeline databarn: ${e.message}`); return []; }),
  ]);
  const clmBy = {}, classicBy = {}, dbBy = {};
  for (const e of Array.isArray(clmTl) ? clmTl : []) {
    if (e.type === "clm" && e.manager_address) (clmBy[lc(e.manager_address)] ??= []).push(e);
    else if (e.type === "classic" && e.vault_address) (classicBy[lc(e.vault_address)] ??= []).push(e);
  }
  for (const e of Array.isArray(dbTl) ? dbTl : []) { const k = lc(String(e.product_key ?? "").split(":").pop()); if (k.startsWith("0x")) (dbBy[k] ??= []).push(e); }

  // una fila por CLM (su reward pool y el CLM suelto se suman, como en Beefy) y una por vault clásico
  const groups = new Map();
  for (const p of w.positions) {
    const clmKey = p.type === "cowcentrated" ? lc(p.address) : p.type === "gov" && p.isClmLike ? lc(p.tokenAddress) : null;
    const key = clmKey ? `clm:${p.chain}:${clmKey}` : `classic:${p.chain}:${lc(p.address)}`;
    const g = groups.get(key) ?? { key, kind: clmKey ? "clm" : "classic", chain: p.chain, addr: clmKey ?? lc(p.address), positions: [] };
    g.positions.push(p); groups.set(key, g);
  }

  const rows = [];
  for (const g of groups.values()) {
    const main = g.positions.find((p) => p.type === "gov") ?? g.positions[0];
    const now = g.positions.reduce((s, p) => s + (Number.isFinite(p.valueUsd) ? p.valueUsd : 0), 0);
    const pendingUsd = g.positions.reduce((s, p) => s + (p.pendingUsd ?? 0), 0);
    const pending = g.positions.flatMap((p) => p.pending ?? []);
    const daily = g.positions.reduce((s, p) => s + (p.dailyRate !== null && Number.isFinite(p.valueUsd) && p.status === "active" ? p.valueUsd * p.dailyRate : 0), 0);
    const row = { id: main.id, name: main.name, chain: g.chain, platform: main.platform, type: main.type, kind: g.kind, status: main.status, assets: main.assets, url: main.url,
      apyPct: main.apyPct, tvlUsd: main.tvlUsd, nowUsd: +now.toFixed(4), dailyUsd: +daily.toFixed(4), pendingUsd: +pendingUsd.toFixed(4), pending, layers: g.positions.map((p) => p.id) };
    if (g.kind === "clm") {
      const cur = currentSegment(clmBy[g.addr] ?? []);
      if (cur.length) {
        const f = clmFifo(cur.map((e) => ({ shares: e.share_diff, t0: e.underlying0_diff, t1: e.underlying1_diff, p0: e.token0_to_usd, p1: e.token1_to_usd, claims: e.reward_pool_claim_details })));
        let comp = { usd: 0, n: 0, amount0: 0, amount1: 0 };
        try { comp = clmHarvestShare(cur, await getJson(`${CLM_API}/vault/${g.chain}/${g.addr}/harvests`, 15 * 60_000)); }
        catch (e) { errors.push(`cosechas ${main.id}: ${e.message}`); }
        const atDep = f.usdAtDeposit;
        Object.assign(row, {
          atDepositUsd: +atDep.toFixed(4), firstDeposit: cur[0].datetime, txs: cur.length,
          tokensAtDeposit: { amount0: f.token0, amount1: f.token1, entryPx0: f.entryPx0, entryPx1: f.entryPx1 },
          yield: { compoundedUsd: +comp.usd.toFixed(4), harvests: comp.n, claimedUsd: +f.claimedUsd.toFixed(4), pendingUsd: +pendingUsd.toFixed(4) },
          yieldUsd: +(comp.usd + f.claimedUsd + pendingUsd).toFixed(4),
          pnlUsd: +(now + f.claimedUsd + pendingUsd - atDep).toFixed(4),
        });
      }
    } else {
      const src = classicBy[g.addr]?.length ? "clm-api" : dbBy[g.addr]?.length ? "databarn" : null;
      const raw = src === "clm-api" ? classicBy[g.addr].map((e) => ({ ...e, ppfs: e.share_to_underlying, px: e.underlying_to_usd }))
        : src === "databarn" ? dbBy[g.addr].map((e) => ({ ...e, ppfs: e.share_to_underlying_price, px: e.underlying_to_usd_price })) : [];
      const cur = currentSegment(raw);
      if (cur.length) {
        const f = classicFifo(cur.map((e) => ({ shares: e.share_diff, ppfs: e.ppfs, px: e.px })));
        const underNow = g.positions.reduce((s, p) => s + (Number.isFinite(p.underlying) ? p.underlying : 0), 0);
        const pxNow = underNow > 0 ? now / underNow : 0;
        const yU = underNow - f.underlyingAtDeposit;
        Object.assign(row, {
          atDepositUsd: +f.usdAtDeposit.toFixed(4), firstDeposit: cur[0].datetime, txs: cur.length, source: src,
          underlying: { atDeposit: f.underlyingAtDeposit, now: underNow, yieldTokens: yU },
          yield: { compoundedUsd: +(yU * pxNow).toFixed(4), claimedUsd: 0, pendingUsd: +pendingUsd.toFixed(4) },
          yieldUsd: +(yU * pxNow + pendingUsd).toFixed(4),
          pnlUsd: +(now + pendingUsd - f.usdAtDeposit).toFixed(4),
        });
      }
    }
    if (row.atDepositUsd === undefined) { row.atDepositUsd = null; row.yieldUsd = null; row.pnlUsd = null; row.noHistory = true; }
    if (row.atDepositUsd) row.pnlPct = +(100 * row.pnlUsd / row.atDepositUsd).toFixed(2);
    rows.push(row);
  }
  // Beefy no muestra polvo: filas de menos de 1 centavo fuera
  const shown = rows.filter((r) => r.nowUsd >= 0.01).sort((a, b) => b.nowUsd - a.nowUsd);
  const sum = (k) => +shown.reduce((s, r) => s + (Number.isFinite(r[k]) ? r[k] : 0), 0).toFixed(2);
  return { address: w.address, at: new Date().toISOString(),
    summary: { depositedUsd: sum("nowUsd"), vaults: shown.length, yieldUsd: sum("yieldUsd"), dailyUsd: sum("dailyUsd"), monthlyUsd: +(sum("dailyUsd") * 30).toFixed(2), atDepositUsd: sum("atDepositUsd"), pnlUsd: sum("pnlUsd") },
    rows: shown, timeline: { clm: Array.isArray(clmTl) ? clmTl.length : 0, databarn: Array.isArray(dbTl) ? dbTl.length : 0 }, errors };
}

export function beefyDashLine(d) {
  const f = (v) => (v === null || v === undefined ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`);
  return `beefy dashboard ${d.address}: depositado ${f(d.summary.depositedUsd)} · ${d.summary.vaults} vaults · rendimiento ${f(d.summary.yieldUsd)} · diario ${f(d.summary.dailyUsd)} · PnL ${f(d.summary.pnlUsd)} · ` +
    d.rows.map((r) => `[${r.chain}] ${r.name}: al depositar ${f(r.atDepositUsd)} ahora ${f(r.nowUsd)} rend ${f(r.yieldUsd)} PnL ${f(r.pnlUsd)} APY ${r.apyPct ?? "—"}% diario ${f(r.dailyUsd)}`).join(" | ") +
    ` · historial clm-api ${d.timeline.clm} / databarn ${d.timeline.databarn}` + (d.errors.length ? ` · errores: ${d.errors.slice(0, 4).join(" | ")}` : "");
}
