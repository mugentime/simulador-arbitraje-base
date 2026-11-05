// Ranking de vaults de Beefy por APY (datos de api.beefy.finance; caché de 10 min).
// GET /api/beefy-top?n=10&minTvl=50000&chain=base&includeEol=0
const API = "https://api.beefy.finance";
const TTL = 10 * 60_000;
let cache = null;

async function getJson(path) {
  const r = await fetch(API + path, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function load() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const [vaults, cows, govs, apy, tvl] = await Promise.all([
    getJson("/vaults"), getJson("/cow-vaults").catch(() => []), getJson("/gov-vaults").catch(() => []),
    getJson("/apy/breakdown"), getJson("/tvl"),
  ]);
  const tvlById = {};
  for (const byVault of Object.values(tvl)) for (const [id, v] of Object.entries(byVault)) tvlById[id] = Number(v) || 0;
  const all = new Map();
  for (const v of [...vaults, ...cows, ...govs]) if (v?.id && !all.has(v.id)) all.set(v.id, v);
  cache = { at: Date.now(), all, apy, tvlById };
  return cache;
}

export async function beefyTop({ n = 10, minTvl = 50_000, chain = null, includeEol = false } = {}) {
  const { at, all, apy, tvlById } = await load();
  const rows = [];
  for (const v of all.values()) {
    if (!includeEol && v.status && v.status !== "active") continue;
    if (chain && v.chain !== chain) continue;
    const a = apy[v.id];
    const total = Number(a?.totalApy);
    if (!Number.isFinite(total) || total <= 0) continue;
    const t = tvlById[v.id] ?? 0;
    if (t < minTvl) continue;
    rows.push({
      id: v.id, name: v.name, chain: v.chain, platform: v.platformId, type: v.type ?? "standard",
      assets: v.assets, apyPct: +(total * 100).toFixed(2), tvlUsd: Math.round(t),
      tradingAprPct: a.tradingApr != null ? +(a.tradingApr * 100).toFixed(2) : null,
      rewardAprPct: a.vaultApr != null ? +(a.vaultApr * 100).toFixed(2) : (a.clmApr != null ? +(a.clmApr * 100).toFixed(2) : null),
      createdAt: v.createdAt ? new Date(v.createdAt * 1000).toISOString().slice(0, 10) : null,
      url: `https://app.beefy.com/vault/${v.id}`,
    });
  }
  rows.sort((x, y) => y.apyPct - x.apyPct);
  return { fetchedAt: new Date(at).toISOString(), filters: { n, minTvl, chain, includeEol }, eligible: rows.length, top: rows.slice(0, n) };
}

export function beefyTopLine(r) {
  return r.top.map((x, i) => `${i + 1}) ${x.name} [${x.chain}/${x.platform}${x.type !== "standard" ? "/" + x.type : ""}] ${x.apyPct}% TVL $${x.tvlUsd.toLocaleString("en-US")}`).join(" | ");
}

// Tokens de los CLM de Beefy en una cadena (símbolo → dirección), para alimentar extraTokens.
const BASES = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"]); // Robinhood: WETH, USDG
const BASE_SYMS = new Set(["WETH", "ETH", "USDG"]);
export async function beefyClmTokens(chain) {
  const { all, apy, tvlById } = await load();
  const out = {};
  for (const v of all.values()) {
    if (v.chain !== chain || v.type !== "cowcentrated" || !Array.isArray(v.depositTokenAddresses)) continue;
    // el orden de assets no coincide con depositTokenAddresses: se empareja quitando los tokens base conocidos (nativo envuelto / dólar) de ambos lados
    const reward = [...all.values()].find((g) => g.type === "gov" && g.tokenAddress?.toLowerCase() === v.earnContractAddress?.toLowerCase());
    const info = { name: v.name, status: v.status, apyPct: +(((apy[reward?.id ?? v.id]?.totalApy) ?? 0) * 100).toFixed(1), tvlUsd: Math.round((tvlById[v.id] ?? 0) + (tvlById[reward?.id] ?? 0)) };
    const addrs = v.depositTokenAddresses.filter((x) => !BASES.has(x.toLowerCase()));
    const syms = (v.assets ?? []).filter((x) => !BASE_SYMS.has(String(x).toUpperCase()));
    if (addrs.length !== 1 || syms.length !== 1) continue;
    const o = (out[addrs[0].toLowerCase()] ??= { symbol: syms[0], address: addrs[0], vaults: [] });
    o.vaults.push(info);
  }
  return Object.values(out);
}

// Vaults CLM de Beefy en una cadena con sus dos tokens, APY (el del Reward Pool si existe) y TVL (CLM + Reward Pool).
export async function beefyClmVaults(chain) {
  const { all, apy, tvlById } = await load();
  const govs = [...all.values()].filter((g) => g.type === "gov" && g.chain === chain);
  const out = [];
  for (const v of all.values()) {
    if (v.chain !== chain || v.type !== "cowcentrated" || v.status !== "active" || !Array.isArray(v.depositTokenAddresses) || v.depositTokenAddresses.length !== 2) continue;
    const reward = govs.find((g) => g.tokenAddress?.toLowerCase() === v.earnContractAddress?.toLowerCase());
    const apyDec = Math.max(Number(apy[reward?.id]?.totalApy) || 0, Number(apy[v.id]?.totalApy) || 0);
    out.push({ id: reward?.id ?? v.id, name: v.name, tokens: v.depositTokenAddresses, apy: apyDec, tvlUsd: (tvlById[v.id] ?? 0) + (tvlById[reward?.id] ?? 0) });
  }
  return out;
}
