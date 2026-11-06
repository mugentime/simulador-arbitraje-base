// Selección automática de vaults de Beefy con APY publicado ≥ MIN (orden de Jose 2026-11-05 22:49: "solo con estrategias que
// publiquen arriba de 1000 % APY") y reglas de salida. Solo reward pools (gov) de CLM en la cadena del worker; la ejecución
// (resolve en beefyclm.mjs) verifica on-chain que el pool sea de una fábrica soportada (Uniswap v3 / Slipstream).
const API = "https://api.beefy.finance";
async function getJson(path) { const r = await fetch(API + path, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); }

export const RULES = () => ({
  minApyPct: Number(process.env.HIGH_APY_MIN_PCT ?? 1000),
  minTvl: Number(process.env.HIGH_APY_MIN_TVL ?? 100_000),
  exitApyPct: Number(process.env.HIGH_APY_EXIT_PCT ?? 500), // sale si el APY baja de aquí (la mitad del umbral)
  exitTvlMult: Number(process.env.HIGH_APY_EXIT_TVL_MULT ?? 3), // sale si el TVL se multiplica (dilución)
  exitHours: Number(process.env.HIGH_APY_EXIT_HOURS ?? 6), // la condición debe durar estas horas seguidas
  blocked: (process.env.HIGH_APY_BLOCKED || "").split(",").map((x) => x.trim()).filter(Boolean),
});

/** Candidatos en `chain` ordenados por APY: [{id, name, apyPct, tvl, clm, platform}]. */
export async function scanHighApy(chain, rules = RULES()) {
  const [govs, cows, apy, tvl] = await Promise.all([getJson("/gov-vaults"), getJson("/cow-vaults").catch(() => []), getJson("/apy/breakdown"), getJson("/tvl")]);
  const tvlById = {}; for (const b of Object.values(tvl ?? {})) for (const [k, v] of Object.entries(b ?? {})) tvlById[k] = Number(v) || 0;
  const cowByAddr = new Map(cows.filter((c) => c.chain === chain).map((c) => [String(c.earnContractAddress).toLowerCase(), c]));
  const all = govs.filter((g) => g.chain === chain && g.status === "active" && cowByAddr.has(String(g.tokenAddress).toLowerCase())).map((g) => {
    const a = Number(apy[g.id]?.totalApy ?? NaN);
    return { id: g.id, name: g.name, apyPct: Number.isFinite(a) ? a * 100 : null, tvl: tvlById[g.id] ?? 0, clm: g.tokenAddress, platform: cowByAddr.get(String(g.tokenAddress).toLowerCase())?.platformId ?? null };
  });
  const byId = Object.fromEntries(all.map((x) => [x.id, x]));
  const eligible = all.filter((x) => x.apyPct !== null && x.apyPct >= rules.minApyPct && x.tvl >= rules.minTvl && !rules.blocked.includes(x.id)).sort((a, b) => b.apyPct - a.apyPct);
  return { eligible, byId };
}

/** Elige destino: se queda con el actual si sigue elegible (evita rotar por ruido); si no, el de mayor APY. */
export function pickTarget(eligible, currentId) {
  if (currentId && eligible.some((x) => x.id === currentId)) return currentId;
  return eligible[0]?.id ?? null;
}

/** Motivo de salida (o null) para una posición: entry {apyPct, tvl}, now {apyPct, tvl}, badSince (ms o null). */
export function exitCheck(entry, now, badSince, nowMs, rules = RULES()) {
  let why = null;
  if (!now) why = "el vault ya no está activo en la API";
  else if (now.apyPct !== null && now.apyPct < rules.exitApyPct) why = `APY ${now.apyPct.toFixed(0)} % < ${rules.exitApyPct} %`;
  else if (entry?.tvl > 0 && now.tvl > entry.tvl * rules.exitTvlMult) why = `TVL ×${(now.tvl / entry.tvl).toFixed(1)} desde la entrada`;
  if (!why) return { exit: false, badSince: null };
  const since = badSince ?? nowMs;
  return { exit: !now || nowMs - since >= rules.exitHours * 3600_000, badSince: since, why };
}
