// Métricas por par de tokens y exclusión de pares concretos.
// Un "par" se identifica por los símbolos de sus dos tokens ordenados alfabéticamente ("USDC/WETH").
// Los símbolos son los del universo (rol del token: WETH = nativo envuelto de la cadena, USDC = dólar de referencia);
// `excludedPairs` acepta tanto el símbolo de rol como la etiqueta real (p. ej. "WPOL/USDC" o "WETH/USDC" en Polygon).

export const pairOf = (a, b) => [a, b].sort().join("/");
export const pairOfPool = (p) => pairOf(p.token0.sym, p.token1.sym);
const names = (t) => [t.sym, t.label].filter(Boolean).map((s) => s.toLowerCase());

/** Conjunto normalizado de pares excluidos (minúsculas, orden alfabético). */
export function excludedSet(list = []) {
  return new Set(list.map((x) => (Array.isArray(x) ? x : String(x).split("/"))).map(([a, b]) => pairOf(a.trim().toLowerCase(), b.trim().toLowerCase())));
}

/** ¿El pool pertenece a un par excluido? Compara símbolo de rol, etiqueta y dirección. */
export function isExcludedPool(p, set) {
  if (!set || !set.size) return false;
  for (const a of [...names(p.token0), p.token0.address.toLowerCase()]) {
    for (const b of [...names(p.token1), p.token1.address.toLowerCase()]) if (set.has(pairOf(a, b))) return true;
  }
  return false;
}

/** Pares de tokens que recorre una ruta a partir de su etiqueta ("WETH → Uniswap v3 → USDC → … → WETH"). */
export function pairsOfLabel(label) {
  const parts = String(label).split(" → ");
  const toks = parts.filter((_, i) => i % 2 === 0);
  const out = new Set();
  for (let i = 0; i + 1 < toks.length; i++) out.add(pairOf(toks[i], toks[i + 1]));
  return [...out];
}

/** Suma un resultado de Fase 1 (sim ok/rev, enviada confirmada/revertida) a cada par de la ruta. */
export function bumpPairs(byPair, label, field, n = 1) {
  for (const k of pairsOfLabel(label)) { const s = (byPair[k] ??= { ok: 0, rev: 0, conf: 0, sentRev: 0 }); s[field] = (s[field] ?? 0) + n; }
}

/**
 * Tabla por par: pools en el universo, desajustes (rastreador), rutas rentables del modelo (byRoute) y Fase 1.
 * `disloc` = estado crudo del rastreador (pairs por direcciones), `byRoute` = stats.byRoute, `p1ByPair` = executor.p1.byPair.
 */
export function pairTable({ pools, disloc, byRoute, p1ByPair = {}, firstSeen = {} }) {
  const rows = new Map();
  const disp = new Map(); // sym -> etiqueta real
  const row = (k) => rows.get(k) ?? rows.set(k, { pair: k, pools: 0, episodes: 0, share: 0, peak: 0, routes: 0, routeEp: 0, netModel: 0, ok: 0, rev: 0, conf: 0, sentRev: 0 }).get(k);
  const poolPair = new Map();
  for (const p of pools) {
    const k = pairOfPool(p); row(k).pools++; poolPair.set(p.address.toLowerCase(), k);
    for (const t of [p.token0, p.token1]) disp.set(t.sym, t.label ?? t.sym);
  }
  for (const st of Object.values(disloc?.pairs ?? {})) {
    const [a, b] = String(st.label).split("/"); const k = pairOf(a, b);
    if (!rows.has(k)) continue; // par ya fuera del universo
    const r = row(k); r.episodes += st.episodes; r.share = st.blocks ? st.dislocBlocks / st.blocks : 0; r.peak = Math.max(r.peak, st.peakExcess ?? 0);
  }
  for (const [key, br] of Object.entries(byRoute ?? {})) {
    const addrs = key.split(":")[1]?.split(">") ?? [];
    const ks = new Set(addrs.map((a) => poolPair.get(a.toLowerCase())).filter(Boolean));
    for (const k of ks) { const r = row(k); r.routes++; r.routeEp += br.episodes; r.netModel += br.netUsd; }
  }
  for (const [k, s] of Object.entries(p1ByPair)) if (rows.has(k)) Object.assign(row(k), { ok: s.ok ?? 0, rev: s.rev ?? 0, conf: s.conf ?? 0, sentRev: s.sentRev ?? 0 });
  const out = [...rows.values()].map((r) => ({ ...r, label: r.pair.split("/").map((s) => disp.get(s) ?? s).join("/"), score: pairScore(r), since: firstSeen[r.pair] ?? null }));
  return out.sort((a, b) => b.score - a.score);
}

/** Puntuación (mayor = mejor): rutas rentables y simulaciones ok pesan más; desajustes y exceso pico después; reverts restan. */
export function pairScore(r) {
  const s = 4 * Math.log1p(r.routeEp) + 2 * Math.log1p(r.routes) + 6 * Math.log1p(r.ok) + 10 * r.conf
    + 1.5 * Math.log1p(r.episodes) + 10 * r.share + Math.min(r.peak, 50) / 10 + Math.log1p(Math.max(0, r.pools - 1))
    - 2 * Math.log1p(r.sentRev) - 0.5 * Math.log1p(r.rev);
  return Math.round(s * 10) / 10;
}

/** Línea compacta para los logs: "par p3 e12/9% 4.1bps r2/5ep ok1 rv0 env✗0 $0.12 s5.3". */
export function pairLine(rows) {
  return rows.map((r) => `${r.label} p${r.pools} e${r.episodes}/${(r.share * 100).toFixed(0)}% ${r.peak.toFixed(1)}bps r${r.routes}/${r.routeEp}ep ok${r.ok} rv${r.rev}${r.sentRev ? ` envRev${r.sentRev}` : ""}${r.conf ? ` CONF${r.conf}` : ""} $${r.netModel.toFixed(2)} s${r.score}`).join(" | ");
}
