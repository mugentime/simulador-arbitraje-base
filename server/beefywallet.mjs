// Posiciones de una wallet en Beefy (todas las cadenas con RPC conocido): saldos on-chain de cada vault, CLM y
// reward pool; valor en USD con precios de api.beefy.finance; APY y TVL actuales; y lo depositado neto según el
// historial de Beefy (databarn / clm-api) para calcular la ganancia o pérdida de cada posición.
// Uso: GET /api/beefy-wallet?address=0x…  y línea "beefy wallet" en los logs (BEEFY_WALLETS, por defecto la del executor).

import { ethers } from "ethers";
import * as core from "../src/core.js";
import { CHAINS } from "../src/chains.js";

const API = "https://api.beefy.finance";
const EXTRA_RPCS = {
  monad: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz", "https://monad-mainnet.drpc.org"],
  avax: ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"],
  sonic: ["https://rpc.soniclabs.com", "https://sonic-rpc.publicnode.com"],
  linea: ["https://rpc.linea.build", "https://linea-rpc.publicnode.com"],
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
};
const BEEFY_TO_KEY = { base: "base", bsc: "bsc", polygon: "polygon", arbitrum: "arbitrum", optimism: "optimism" };
const iface = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function getPricePerFullShare() view returns (uint256)"]);

async function getJson(url, ms = 25_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${r.status}`);
  return r.json();
}

function rpcsFor(chain) {
  const key = BEEFY_TO_KEY[chain];
  const list = key ? (CHAINS[key]?.rpcs ?? []) : (EXTRA_RPCS[chain] ?? []);
  return list;
}

/** Valor en unidades del activo subyacente a partir del saldo de acciones (puro, probado). */
export function underlyingAmount({ type, shares, ppfs, tokenDecimals = 18 }) {
  const raw = type === "standard" ? (shares * ppfs) / 10n ** 18n : shares;
  return Number(raw) / 10 ** tokenDecimals;
}

/** Neto depositado por vault (USD) desde entradas de historial con usd_diff (o equivalente). */
export function netDepositsByVault(entries) {
  const out = {};
  for (const e of entries ?? []) {
    const id = e.product_key?.split(":").pop() ?? e.vault_id ?? e.display_name;
    const d = Number(e.usd_diff ?? e.usdDiff ?? 0);
    if (!id || !Number.isFinite(d)) continue;
    const o = (out[id] ??= { netUsd: 0, txs: 0, first: e.datetime ?? null, name: e.display_name ?? null });
    o.netUsd += d; o.txs++;
  }
  return out;
}

export async function beefyWallet(address, { provider = null } = {}) {
  address = ethers.getAddress(address);
  const [vaults, cows, govs, apy, tvl, prices, lps] = await Promise.all([
    getJson(`${API}/vaults`), getJson(`${API}/cow-vaults`).catch(() => []), getJson(`${API}/gov-vaults`).catch(() => []),
    getJson(`${API}/apy/breakdown`).catch(() => ({})), getJson(`${API}/tvl`).catch(() => ({})),
    getJson(`${API}/prices`).catch(() => ({})), getJson(`${API}/lps`).catch(() => ({})),
  ]);
  const price = { ...prices, ...lps };
  const tvlById = {}; for (const byV of Object.values(tvl)) for (const [id, v] of Object.entries(byV ?? {})) tvlById[id] = Number(v) || 0;
  const all = [];
  for (const v of vaults) all.push({ ...v, type: v.type ?? "standard" });
  for (const v of cows) all.push({ ...v, type: "cowcentrated" });
  for (const v of govs) all.push({ ...v, type: "gov" });
  const byChain = {};
  for (const v of all) if (v.earnContractAddress && ethers.isAddress(v.earnContractAddress)) (byChain[v.chain] ??= []).push(v);

  // historial (neto depositado); dos fuentes, la que responda
  let history = { source: null, entries: [], error: null };
  for (const url of [`https://databarn.beefy.com/api/v1/beefy/timeline?address=${address}`, `https://clm-api.beefy.finance/api/v1/investor/${address}/timeline`]) {
    try { const j = await getJson(url, 20_000); const arr = Array.isArray(j) ? j : (j?.data ?? j?.result ?? []); if (Array.isArray(arr)) { history.entries.push(...arr); history.source = (history.source ? history.source + "+" : "") + new URL(url).host; } }
    catch (e) { history.error = (history.error ? history.error + " | " : "") + e.message.slice(0, 80); }
  }
  const net = netDepositsByVault(history.entries);
  const chainsInHistory = [...new Set(history.entries.map((e) => e.chain).filter(Boolean))];

  const positions = []; const errors = [];
  const chains = [...new Set([...chainsInHistory, "base", "monad"])];
  for (const chain of chains) {
    const list = byChain[chain] ?? [];
    if (!list.length) continue;
    let p = chain === core.CHAIN?.beefy && provider ? provider : null;
    let bal = null;
    for (const url of p ? [null] : rpcsFor(chain)) {
      try {
        if (!p) p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: false, batchMaxCount: 1 });
        bal = await core.multicall(ethers, p, list.map((v) => [v.earnContractAddress, iface.encodeFunctionData("balanceOf", [address])]));
        break;
      } catch (e) { errors.push(`${chain}${url ? " " + new URL(url).host : ""}: ${(e.shortMessage || e.message).slice(0, 60)}`); p = null; }
    }
    if (!bal) { if (!rpcsFor(chain).length && !(chain === core.CHAIN?.beefy)) errors.push(`${chain}: sin RPC configurado`); continue; }
    const held = list.map((v, i) => ({ v, shares: bal[i] ? BigInt(bal[i]) : 0n })).filter((x) => x.shares > 0n);
    const std = held.filter((x) => x.v.type === "standard");
    const pp = std.length ? await core.multicall(ethers, p, std.map((x) => [x.v.earnContractAddress, iface.encodeFunctionData("getPricePerFullShare")])) : [];
    std.forEach((x, i) => { x.ppfs = pp[i] ? BigInt(pp[i]) : 10n ** 18n; });
    for (const x of held) {
      const v = x.v;
      const amt = underlyingAmount({ type: v.type, shares: x.shares, ppfs: x.ppfs ?? 10n ** 18n, tokenDecimals: Number(v.tokenDecimals ?? v.depositTokenDecimals ?? 18) });
      const px = Number(price[v.oracleId] ?? price[v.id] ?? NaN);
      const usd = Number.isFinite(px) ? amt * px : null;
      const a = apy[v.id] ?? {};
      const n = net[v.id];
      positions.push({ chain, id: v.id, name: v.name, type: v.type, platform: v.platformId, status: v.status, assets: v.assets,
        valueUsd: usd, apyPct: a.totalApy != null ? +(a.totalApy * 100).toFixed(2) : null, tvlUsd: Math.round(tvlById[v.id] ?? 0),
        netDepositedUsd: n ? +n.netUsd.toFixed(2) : null, pnlUsd: n && usd !== null ? +(usd - n.netUsd).toFixed(2) : null, txs: n?.txs ?? null,
        firstDeposit: n?.first ?? null, url: `https://app.beefy.com/vault/${v.id}` });
    }
  }
  // un CLM depositado en su vault o reward pool aparece una vez (la capa que tiene las acciones)
  positions.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const total = positions.reduce((s, x) => s + (x.valueUsd ?? 0), 0);
  const daily = positions.reduce((s, x) => s + (x.valueUsd ?? 0) * (Math.pow(1 + (x.apyPct ?? 0) / 100, 1 / 365) - 1), 0);
  return { address, at: new Date().toISOString(), totalUsd: +total.toFixed(2), estDailyUsd: +daily.toFixed(3), positions,
    history: { source: history.source, entries: history.entries.length, chains: chainsInHistory, error: history.error, sampleKeys: history.entries[0] ? Object.keys(history.entries[0]).slice(0, 20) : null },
    errors };
}

export function beefyWalletLine(r) {
  return `beefy wallet ${r.address}: total $${r.totalUsd} · est. $${r.estDailyUsd}/día · ${r.positions.length} posiciones: ` +
    r.positions.map((p) => `[${p.chain}] ${p.name} (${p.type}${p.status !== "active" ? ", " + p.status : ""}) $${p.valueUsd?.toFixed(2) ?? "?"}` +
      `${p.netDepositedUsd !== null ? ` dep $${p.netDepositedUsd} → ${p.pnlUsd >= 0 ? "+" : ""}$${p.pnlUsd}` : ""} APY ${p.apyPct ?? "—"}% TVL $${p.tvlUsd} id ${p.id}`).join(" | ") +
    ` · historial: ${r.history.source ?? "—"} (${r.history.entries} entradas${r.history.chains.length ? ", cadenas " + r.history.chains.join("/") : ""}${r.history.error ? ", error " + r.history.error : ""})` +
    (r.errors.length ? ` · errores: ${r.errors.join(" | ")}` : "");
}
