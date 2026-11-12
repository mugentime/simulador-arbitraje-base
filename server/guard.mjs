// Vigía de un pool: cada hora mide precio, volumen y liquidez del pool (DexScreener) y la posición (Beefy), guarda la serie y
// escribe UNA línea "vigía <nombre>: OK | AVISO | ALERTA NUEVA | ALERTA RECORDATORIO | ALERTA …". La tarea programada lee esa
// línea y solo avisa al teléfono con "ALERTA NUEVA" o "ALERTA RECORDATORIO". No envía transacciones.
const H = 3600_000;
export const GUARD_DEFAULTS = { dropPct: 15, fastDropPct: 10, minRatePct: 0.5, rateHours: 24, lossPct: 10, remindH: 6 };

/** Evalúa la serie (pura, probada). hist: [{t, price, vol24, liq, yieldUsd, nowUsd, atDep}] ascendente; el último es el actual. */
export function guardEval(hist, th = GUARD_DEFAULTS) {
  const cur = hist.at(-1), out = { alerts: [], warns: [], m: {} };
  if (!cur) return out;
  const win = (h) => hist.filter((x) => cur.t - x.t <= h * H);
  const w24 = win(24).filter((x) => x.price > 0);
  if (cur.price > 0 && w24.length) {
    const hi = w24.reduce((a, x) => (x.price > a.price ? x : a));
    out.m.dropFromHigh = (cur.price / hi.price - 1) * 100; out.m.high = hi.price;
    if (out.m.dropFromHigh <= -th.dropPct) out.alerts.push({ k: "precio", t: `precio ${out.m.dropFromHigh.toFixed(1)} % desde el máximo de 24 h ($${hi.price.toPrecision(4)} → $${cur.price.toPrecision(4)})` });
    const prev = hist.filter((x) => x.price > 0 && cur.t - x.t >= 0.75 * H && cur.t - x.t <= 1.5 * H).at(-1);
    if (prev) { out.m.h1 = (cur.price / prev.price - 1) * 100; if (out.m.h1 <= -th.fastDropPct) out.alerts.push({ k: "caida", t: `caída rápida ${out.m.h1.toFixed(1)} % en la última hora` }); }
  }
  // ritmo real: comisiones ganadas en la ventana ÷ valor medio ÷ días (se omite si Beefy reinició la cuenta: comisiones bajan)
  const old = hist.find((x) => cur.t - x.t <= (th.rateHours + 2) * H && cur.t - x.t >= (th.rateHours - 4) * H && Number.isFinite(x.yieldUsd));
  if (old && Number.isFinite(cur.yieldUsd) && cur.yieldUsd >= old.yieldUsd) {
    const seg = hist.filter((x) => x.t >= old.t && x.nowUsd > 0), avg = seg.reduce((a, x) => a + x.nowUsd, 0) / (seg.length || 1), days = (cur.t - old.t) / (24 * H);
    if (avg > 0 && days > 0) { out.m.ratePct = (cur.yieldUsd - old.yieldUsd) / avg / days * 100; if (out.m.ratePct < th.minRatePct) out.alerts.push({ k: "rendimiento", t: `ritmo real ${out.m.ratePct.toFixed(2)} %/día en ${(days * 24).toFixed(0)} h (mínimo ${th.minRatePct} %)` }); }
  }
  if (cur.atDep > 0 && cur.nowUsd > 0) { out.m.pnlPct = (cur.nowUsd / cur.atDep - 1) * 100; if (out.m.pnlPct <= -th.lossPct) out.alerts.push({ k: "perdida", t: `la posición va ${out.m.pnlPct.toFixed(1)} % contra lo metido ($${cur.atDep.toFixed(0)} → $${cur.nowUsd.toFixed(0)})` }); }
  const l24 = win(24).filter((x) => x.liq > 0);
  if (cur.liq > 0 && l24.length) { const mx = Math.max(...l24.map((x) => x.liq)); out.m.liqDrop = (cur.liq / mx - 1) * 100; if (out.m.liqDrop <= -40) out.warns.push(`liquidez del pool ${out.m.liqDrop.toFixed(0)} % en 24 h`); }
  if (cur.liq > 0 && Number.isFinite(cur.vol24)) { out.m.turn = cur.vol24 / cur.liq; if (out.m.turn < 2) out.warns.push(`volumen bajo: ${out.m.turn.toFixed(1)}× la liquidez al día`); }
  return out;
}

/** Decide el nivel del aviso: NUEVA si la causa no estaba activa en la evaluación anterior; RECORDATORIO cada remindH horas. */
export function guardLevel(state, ev, now, th = GUARD_DEFAULTS) {
  const keys = ev.alerts.map((a) => a.k).sort(), prev = state.keys ?? [];
  let level = "OK";
  if (keys.length) {
    const fresh = keys.some((k) => !prev.includes(k));
    if (fresh) { level = "ALERTA NUEVA"; state.notifiedAt = now; }
    else if (now - (state.notifiedAt ?? 0) >= th.remindH * H) { level = "ALERTA RECORDATORIO"; state.notifiedAt = now; }
    else level = "ALERTA";
  } else if (ev.warns.length) level = "AVISO";
  state.keys = keys;
  return level;
}

const STABLE = /^(USDC|USDT|USDG|DAI|USDbC|USDC\.e)$/i;
/** Precio en USD del token volátil del par (DexScreener da el del token base: si el base es el dólar, se usa el del otro). */
export function pairPrice(p) {
  const pu = Number(p.priceUsd), pn = Number(p.priceNative);
  if (STABLE.test(p.baseToken?.symbol ?? "") && !STABLE.test(p.quoteToken?.symbol ?? "") && pn > 0) return { price: pu / pn, inv: true };
  return { price: pu, inv: false };
}
export async function runGuard({ store, row, name, chain, pool, th = GUARD_DEFAULTS, fetchJson, storeKey = "guard" }) {
  const now = Date.now();
  const st = (await store.get(storeKey).catch(() => null)) ?? { hist: [], state: {} };
  let px = null, err = null;
  try { const j = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${pool}`); const p = j?.pairs?.[0] ?? j?.pair ?? null; if (p) { const pp = pairPrice(p); px = { price: pp.price, vol24: Number(p.volume?.h24), liq: Number(p.liquidity?.usd), ch24: pp.inv ? (1 / (1 + Number(p.priceChange?.h24) / 100) - 1) * 100 : Number(p.priceChange?.h24), tx24: (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0) }; } else err = "sin par"; }
  catch (e) { err = String(e.message ?? e).slice(0, 60); }
  const s = { t: now, price: px?.price ?? null, vol24: px?.vol24 ?? null, liq: px?.liq ?? null, yieldUsd: row?.yieldUsd ?? null, nowUsd: row?.nowUsd ?? null, atDep: row?.atDepositUsd ?? null };
  st.hist.push(s); st.hist = st.hist.filter((x) => now - x.t <= 14 * 24 * H);
  const ev = guardEval(st.hist, th);
  // sin posición en el vault (p. ej. la defensa automática ya sacó todo) no hay nada que defender: se sigue midiendo, sin alertas
  if (!row) { ev.alerts = []; ev.warns = []; }
  const level = row ? guardLevel(st.state, ev, now, th) : (st.state.keys = [], "SIN POSICIÓN");
  // una causa cuenta como confirmada cuando aparece en dos evaluaciones seguidas (evita actuar por una lectura mala de precio)
  const streak = {}; for (const a of ev.alerts) streak[a.k] = (st.state.streak?.[a.k] ?? 0) + 1;
  st.state.streak = streak;
  const confirmed = Object.entries(streak).filter(([, n]) => n >= 2).map(([k]) => k);
  await store.set(storeKey, st).catch(() => {});
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—"), k = (v) => (Number.isFinite(v) ? "$" + Math.round(v).toLocaleString("en-US") : "—");
  const line = `vigía ${name}: ${level}${ev.alerts.length ? " · " + ev.alerts.map((a) => a.t).join(" | ") : ""}${ev.warns.length ? " · avisos: " + ev.warns.join(" | ") : ""}` +
    ` · precio ${px ? "$" + px.price.toPrecision(4) : "sin dato" + (err ? ` (${err})` : "")}${px ? ` (24 h ${f(px.ch24)} %, vs máximo 24 h ${f(ev.m.dropFromHigh)} %)` : ""} · volumen 24 h ${k(px?.vol24)} · liquidez ${k(px?.liq)}` +
    ` · posición ${row ? `$${f(row.nowUsd, 2)} (metido $${f(row.atDepositUsd, 2)}, comisiones $${f(row.yieldUsd, 2)})` : "sin dato"} · ritmo real ${f(ev.m.ratePct, 2)} %/día · reglas: precio −${th.dropPct} % en 24 h, −${th.fastDropPct} % en 1 h, ritmo < ${th.minRatePct} %/día, posición −${th.lossPct} %`;
  return { at: new Date(now).toISOString(), level, keys: ev.alerts.map((a) => a.k), confirmed, alerts: ev.alerts.map((a) => a.t), warns: ev.warns, m: ev.m, px, row: row ? { nowUsd: row.nowUsd, atDepositUsd: row.atDepositUsd, yieldUsd: row.yieldUsd } : null, line };
}

/** Sin dinero en el vault no hay nada que vigilar: no se consulta el precio ni se guarda la serie; solo queda el estado. */
export function guardIdle(name, now = Date.now()) {
  return { at: new Date(now).toISOString(), level: "SIN POSICIÓN", idle: true, keys: [], confirmed: [], alerts: [], warns: [], m: {}, px: null, row: null,
    line: `vigía ${name}: SIN POSICIÓN · no hay dinero en el vault, no se mide ni se alerta · se reactiva solo si vuelve a haber posición` };
}
