// Herramienta de la revisión horaria (doc 13, reglas 5 y 6): a partir de una línea "pares:" de un worker calcula
// los 3 peores pares ELEGIBLES (los dos tokens configurados: referencia + extraTokens), la lista de elegibles con s0
// y, por token, cuántos pares tiene en la línea y cuántos contra el nativo (trampa 1 / tokens de un solo pool).
//
// Uso: node test-local/ranking_pares.mjs <cadena> <archivo con la línea "pares:"> [--jovenes=SYM,SYM]
//   --jovenes: tokens añadidos hace < 3 h (no cuentan para el ranking; se listan aparte).
// Sin argumentos corre una autoprueba.
import { readFileSync } from "node:fs";
import { CHAINS } from "../src/chains.js";

export function parsePairsLine(line) {
  const body = line.slice(line.indexOf(") · ") + 4);
  return body.split(" | ").map((seg) => {
    const m = seg.trim().match(/^(\S+)\/(\S+) p(\d+) .* s(-?[\d.]+)$/);
    if (!m) return null;
    return { a: m[1], b: m[2], name: `${m[1]}/${m[2]}`, p: Number(m[3]), s: Number(m[4]) };
  }).filter(Boolean);
}

export function configuredSymbols(cfg) {
  const set = new Set();
  for (const [role, t] of Object.entries(cfg.tokens)) { set.add(role.toLowerCase()); if (t.label) set.add(t.label.toLowerCase()); }
  for (const t of cfg.extraTokens ?? []) { set.add(t.sym.toLowerCase()); for (const s of t.symbols ?? []) set.add(s.toLowerCase()); }
  return set;
}

export function rankPairs(pairs, cfg, young = []) {
  const conf = configuredSymbols(cfg);
  const y = new Set(young.map((s) => s.toLowerCase()));
  const native = (cfg.tokens.WETH?.label ?? "WETH").toLowerCase(); // nativo envuelto: WBNB en BSC, WPOL en Polygon (allí "WETH" es el ETH puenteado)
  const cmp = (x, z) => x.s - z.s || x.p - z.p || x.name.toLowerCase().localeCompare(z.name.toLowerCase());
  const configured = pairs.filter((q) => conf.has(q.a.toLowerCase()) && conf.has(q.b.toLowerCase()));
  const isYoung = (q) => y.has(q.a.toLowerCase()) || y.has(q.b.toLowerCase());
  const eligible = configured.filter((q) => !isYoung(q)).sort(cmp);
  const perToken = {};
  for (const q of configured) for (const t of [q.a, q.b]) {
    const k = t; perToken[k] ??= { pairs: 0, pools: 0, nativePairs: 0, s0: 0 };
    perToken[k].pairs++; perToken[k].pools += q.p; if (q.s === 0) perToken[k].s0++;
    const other = t === q.a ? q.b : q.a;
    if (other.toLowerCase() === native) perToken[k].nativePairs++;
  }
  return {
    worst3: eligible.slice(0, 3),
    s0Eligible: eligible.filter((q) => q.s === 0),
    s0All: configured.filter((q) => q.s === 0),
    young: configured.filter(isYoung),
    longTail: pairs.length - configured.length,
    perToken,
  };
}

function fmt(q) { return `${q.name} (s${q.s},p${q.p})`; }

const [, , chainKey, file, ...rest] = process.argv;
if (!chainKey) {
  // autoprueba con una línea sintética
  const line = "x pares: 5 vigilados (bsc; …; mejor→peor) · USDT/WBNB p11 e1/0% 1bps r1/1ep ok1 rv1 $1 s48.2 | TUT/USDT p2 e0/0% 0.0bps r0/0ep ok0 rv0 $0.00 s0.7 | FDUSD/WBNB p1 e0/0% 0.0bps r0/0ep ok0 rv0 $0.00 s0 | STG/WBNB p1 e0/0% 0.0bps r0/0ep ok0 rv0 $0.00 s0 | SKYAI/WBNB p1 e0/0% 0.0bps r0/0ep ok0 rv0 $0.00 s0 | MYX/WBNB p1 e0/0% 0.0bps r0/0ep ok0 rv1 $0.00 s-0.3";
  const ps = parsePairsLine(line);
  if (ps.length !== 6) throw new Error(`parse: ${ps.length}`);
  const r = rankPairs(ps, { tokens: { WETH: { label: "WBNB" }, USDT: { label: "USDT" } }, extraTokens: [{ sym: "TUT" }, { sym: "FDUSD" }, { sym: "STG" }, { sym: "MYX" }] }, ["STG"]);
  const names = r.worst3.map((q) => q.name).join(",");
  if (names !== "MYX/WBNB,FDUSD/WBNB,TUT/USDT") throw new Error(`peores: ${names}`);
  if (r.longTail !== 1 || r.s0Eligible.length !== 1 || r.young.length !== 1) throw new Error(JSON.stringify(r));
  console.log("ranking_pares: OK");
} else {
  const cfg = CHAINS[chainKey];
  if (!cfg) throw new Error(`cadena desconocida: ${chainKey}`);
  const young = (rest.find((a) => a.startsWith("--jovenes=")) ?? "--jovenes=").slice(10).split(",").filter(Boolean);
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.includes("pares:")) ?? "";
  const r = rankPairs(parsePairsLine(line), cfg, young);
  console.log(`3 peores elegibles: ${r.worst3.map(fmt).join(", ")}`);
  console.log(`s0 elegibles (${r.s0Eligible.length}): ${r.s0Eligible.map(fmt).join(", ")}`);
  console.log(`s0 total configurados (${r.s0All.length}); < 3 h: ${r.young.map(fmt).join(", ")}; long tail: ${r.longTail}`);
  const risky = Object.entries(r.perToken).filter(([, v]) => v.nativePairs <= 1 || v.pairs === 1).map(([k, v]) => `${k}(${v.pairs} pares, ${v.nativePairs} vs nativo, ${v.pools} pools)`);
  console.log(`tokens con un solo par o un solo enlace nativo (trampa 1): ${risky.join(", ")}`);
}
