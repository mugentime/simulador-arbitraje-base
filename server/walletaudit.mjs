// Auditoría de retiros de la wallet (orden de Jose 2026-11-06 19:34 "Revisa si ha habido retiros"): con los
// exploradores Blockscout de cada cadena lista los movimientos SALIENTES hacia cuentas sin código (EOA) distintas de la
// propia wallet (nativo y tokens) y los depósitos ENTRANTES de nativo desde EOAs (para identificar la cuenta del último
// depósito de ETH, la única autorizada a recibir retiros).
import { ethers } from "ethers";
import { CHAINS } from "../src/chains.js";
const CHAIN_IDS = { base: 8453, optimism: 10, arbitrum: 42161, polygon: 137, robinhood: 4663, bsc: 56 };
const EXPLORERS = { base: "https://base.blockscout.com", optimism: "https://optimism.blockscout.com", arbitrum: "https://arbitrum.blockscout.com", polygon: "https://polygon.blockscout.com", robinhood: "https://robinhoodchain.blockscout.com" };
async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } }); if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`); return r.json(); }
async function pages(url, max = 4) { const out = []; let next = null; for (let i = 0; i < max; i++) { const j = await get(url + (next ? (url.includes("?") ? "&" : "?") + new URLSearchParams(next) : "")); out.push(...(j.items ?? [])); if (!j.next_page_params) break; next = j.next_page_params; } return out; }

export async function auditWallet(address, { days = 14, whitelist = [], provider = null } = {}) {
  const me = address.toLowerCase(), since = Date.now() - days * 86400_000, wl = whitelist.map((x) => x.toLowerCase());
  const res = { at: new Date().toISOString(), address, days, chains: {}, withdrawals: [], deposits: [], errors: [] };
  const viaAlchemyOk = new Set();
  if (process.env.ALCHEMY_KEY) await Promise.all(Object.keys(ALCHEMY).map(async (chain) => {
    try { await viaAlchemy(chain, address, since, wl, res); viaAlchemyOk.add(chain); } catch (e) { res.errors.push(`${chain}: alchemy: ${String(e.message).replace(process.env.ALCHEMY_KEY, "***").slice(0, 80)}`); }
  }));
  await Promise.all(Object.entries(EXPLORERS).filter(([c]) => !viaAlchemyOk.has(c)).map(async ([chain, base]) => {
    try {
      const [txs, tts] = await Promise.all([pages(`${base}/api/v2/addresses/${address}/transactions`), pages(`${base}/api/v2/addresses/${address}/token-transfers`)]);
      const recent = (x) => new Date(x.timestamp).getTime() >= since;
      let nOut = 0, nIn = 0;
      for (const t of txs.filter(recent)) {
        const from = t.from?.hash?.toLowerCase(), to = t.to?.hash?.toLowerCase(), v = BigInt(t.value ?? "0");
        if (from === me) { nOut++; if (v > 0n && to && to !== me && t.to?.is_contract === false) res.withdrawals.push({ chain, at: t.timestamp, kind: "nativo", to, amount: Number(v) / 1e18, token: "nativo", tx: t.hash, whitelisted: wl.includes(to) }); }
        else if (to === me && v > 0n) { nIn++; res.deposits.push({ chain, at: t.timestamp, from, fromIsContract: !!t.from?.is_contract, amount: Number(v) / 1e18, tx: t.hash }); }
      }
      for (const t of tts.filter(recent)) {
        const from = t.from?.hash?.toLowerCase(), to = t.to?.hash?.toLowerCase();
        if (from !== me || !to || to === me || to === "0x0000000000000000000000000000000000000000" || t.to?.is_contract !== false) continue;
        const dec = Number(t.total?.decimals ?? t.token?.decimals ?? 18);
        res.withdrawals.push({ chain, at: t.timestamp, kind: "token", to, amount: Number(t.total?.value ?? 0) / 10 ** dec, token: t.token?.symbol ?? t.token?.address_hash ?? t.token?.address, tx: t.transaction_hash, whitelisted: wl.includes(to) });
      }
      res.chains[chain] = { txs: txs.length, out: nOut, in: nIn, tokenTransfers: tts.length };
    } catch (e) {
      // respaldo: API estilo Etherscan de Routescan (sin clave)
      try { await viaRoutescan(chain, address, since, wl, res); }
      catch (e2) { res.errors.push(`${chain}: ${e.message.slice(0, 60)} / routescan: ${e2.message.slice(0, 60)}`); }
    }
  }));

  res.withdrawals.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  res.deposits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // sin explorador para Base: localizar los depósitos de ETH por saldo histórico (nodo de archivo)
  if (!res.chains.base && provider) {
    try {
      const f = await findNativeDeposits(provider, address);
      res.baseScan = f;
      for (const d of f) for (const t of d.txs) res.deposits.push({ chain: "base", at: d.at, from: t.from, fromIsContract: (await provider.getCode(t.from)) !== "0x", amount: t.value, tx: t.hash });
      if (f.some((d) => !d.txs.length)) res.errors.push(`base: ${f.filter((d) => !d.txs.length).length} subidas de saldo sin tx directa (internas/puente) en bloques ${f.filter((d) => !d.txs.length).map((d) => d.block).join(",")}`);
    } catch (e) { res.errors.push(`base: saldo histórico: ${String(e.shortMessage || e.message).slice(0, 80)}`); }
    res.deposits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  // último depósito de ETH en Base desde una cuenta (no contrato): la cuenta autorizada para retiros
  res.lastEthDeposit = res.deposits.find((d) => d.chain === "base" && !d.fromIsContract) ?? null;
  return res;
}
export function auditLine(r) {
  const w = r.withdrawals.filter((x) => !x.whitelisted);
  return `auditoría retiros ${r.address} (${r.days} d): ${w.length ? `${w.length} SALIDAS A CUENTAS AJENAS: ` + w.map((x) => `${x.at} [${x.chain}] ${x.amount} ${x.token} → ${x.to} tx ${x.tx}`).join(" | ") : "ninguna salida a cuentas ajenas"}` +
    ` · depósitos de nativo recibidos: ${r.deposits.slice(0, 8).map((d) => `${d.at} [${d.chain}] ${d.amount} desde ${d.from}${d.fromIsContract ? " (contrato)" : ""} tx ${d.tx}`).join(" | ") || "ninguno"}` +
    ` · último depósito de ETH en Base desde cuenta: ${r.lastEthDeposit ? `${r.lastEthDeposit.from} (${r.lastEthDeposit.amount} ETH, ${r.lastEthDeposit.at})` : "no encontrado"}` +
    ` · por cadena: ${Object.entries(r.chains).map(([c, x]) => `${c} ${x.out} enviadas/${x.in} recibidas/${x.tokenTransfers} transf.`).join(", ")}` + (r.errors.length ? ` · errores: ${r.errors.join(" | ")}` : "");
}

async function viaRoutescan(chain, address, since, wl, res) {
  const me = address.toLowerCase(), id = CHAIN_IDS[chain];
  const base = `https://api.routescan.io/v2/network/mainnet/evm/${id}/etherscan/api?address=${address}&sort=desc&page=1&offset=200`;
  const q = async (action) => { const j = await get(`${base}&module=account&action=${action}`); if (!Array.isArray(j.result)) throw new Error(String(j.message || j.result).slice(0, 60)); return j.result; };
  const [txs, tts] = await Promise.all([q("txlist"), q("tokentx")]);
  const cfg = Object.values(CHAINS).find((c) => c.key === chain);
  const prov = cfg ? new ethers.JsonRpcProvider(cfg.rpcs[0], undefined, { staticNetwork: true }) : null;
  const codeCache = new Map();
  const isEoa = async (a) => { if (!prov) return null; if (!codeCache.has(a)) codeCache.set(a, (await prov.getCode(a).catch(() => null)) === "0x"); return codeCache.get(a); };
  const recent = (x) => Number(x.timeStamp) * 1000 >= since;
  let nOut = 0, nIn = 0;
  for (const t of txs.filter(recent)) {
    const from = t.from?.toLowerCase(), to = t.to?.toLowerCase(), v = BigInt(t.value ?? "0"), at = new Date(Number(t.timeStamp) * 1000).toISOString();
    if (t.isError === "1") continue;
    if (from === me) { nOut++; if (v > 0n && to && to !== me && (await isEoa(to)) !== false) res.withdrawals.push({ chain, at, kind: "nativo", to, amount: Number(v) / 1e18, token: "nativo", tx: t.hash, whitelisted: wl.includes(to) }); }
    else if (to === me && v > 0n) { nIn++; res.deposits.push({ chain, at, from, fromIsContract: (await isEoa(from)) === false, amount: Number(v) / 1e18, tx: t.hash }); }
  }
  for (const t of tts.filter(recent)) {
    const from = t.from?.toLowerCase(), to = t.to?.toLowerCase();
    if (from !== me || !to || to === me || /^0x0{40}$/.test(to) || (await isEoa(to)) === false) continue;
    res.withdrawals.push({ chain, at: new Date(Number(t.timeStamp) * 1000).toISOString(), kind: "token", to, amount: Number(t.value) / 10 ** Number(t.tokenDecimal || 18), token: t.tokenSymbol, tx: t.hash, whitelisted: wl.includes(to) });
  }
  res.chains[chain] = { txs: txs.length, out: nOut, in: nIn, tokenTransfers: tts.length, via: "routescan" };
}

const ALCHEMY = { base: "base-mainnet", arbitrum: "arb-mainnet", optimism: "opt-mainnet", polygon: "polygon-mainnet", bsc: "bnb-mainnet", robinhood: "robinhood-mainnet" };
async function viaAlchemy(chain, address, since, wl, res) {
  const url = `https://${ALCHEMY[chain]}.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`;
  const rpc = async (method, params) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(25_000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const me = address.toLowerCase();
  const xfers = async (dir) => { const out = []; let pageKey; for (let i = 0; i < 5; i++) { const r = await rpc("alchemy_getAssetTransfers", [{ fromBlock: "0x0", [dir]: address, category: ["external", "erc20"], withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", order: "desc", ...(pageKey ? { pageKey } : {}) }]); out.push(...r.transfers); if (!r.pageKey || Date.parse(r.transfers.at(-1)?.metadata?.blockTimestamp ?? 0) < since) break; pageKey = r.pageKey; } return out; };
  const [outs, ins] = await Promise.all([xfers("fromAddress"), xfers("toAddress")]);
  const codeCache = new Map();
  const isEoa = async (a) => { a = a.toLowerCase(); if (!codeCache.has(a)) codeCache.set(a, (await rpc("eth_getCode", [a, "latest"]).catch(() => null)) === "0x"); return codeCache.get(a); };
  const recent = (t) => Date.parse(t.metadata?.blockTimestamp ?? 0) >= since;
  let nOut = 0, nIn = 0;
  for (const t of outs.filter(recent)) {
    nOut++; const to = t.to?.toLowerCase();
    if (!to || to === me || /^0x0{40}$/.test(to)) continue;
    if (await isEoa(to)) res.withdrawals.push({ chain, at: t.metadata.blockTimestamp, kind: t.category === "external" ? "nativo" : "token", to, amount: Number(t.value), token: t.asset ?? t.rawContract?.address, tx: t.hash, whitelisted: wl.includes(to) });
  }
  for (const t of ins.filter(recent)) {
    if (t.category !== "external" || t.from?.toLowerCase() === me) continue;
    nIn++; res.deposits.push({ chain, at: t.metadata.blockTimestamp, from: t.from.toLowerCase(), fromIsContract: !(await isEoa(t.from)), amount: Number(t.value), tx: t.hash });
  }
  res.chains[chain] = { txs: outs.length + ins.length, out: nOut, in: nIn, tokenTransfers: 0, via: "alchemy" };
}

/**
 * Depósitos de nativo recientes sin explorador: muestrea el saldo hacia atrás cada `step` bloques, busca subidas y ubica el
 * bloque exacto por búsqueda binaria; ahí lee las txs del bloque con destino a la wallet. Requiere un nodo con estado
 * histórico (archivo) para getBalance en bloques pasados.
 */
export async function findNativeDeposits(provider, address, { lookback = 120_000, step = 3_000, minWei = 10n ** 15n, max = 5 } = {}) {
  const me = address.toLowerCase();
  const head = await provider.getBlockNumber();
  const bal = (b) => provider.getBalance(address, b);
  const pts = [];
  for (let b = head; b > head - lookback; b -= step) pts.push([b, await bal(b)]);
  const out = [];
  for (let i = 0; i + 1 < pts.length && out.length < max; i++) {
    const [hi, bh] = pts[i], [lo, bl] = pts[i + 1];
    if (bh - bl < minWei) continue;
    // primera subida ≥ minWei dentro de (lo, hi]
    let a = lo, z = hi, ba = bl;
    while (z - a > 1) { const m = Math.floor((a + z) / 2); const bm = await bal(m); if (bm - ba >= minWei) z = m; else { a = m; ba = bm; } }
    const blk = await provider.getBlock(z, true);
    const txs = (blk?.prefetchedTransactions ?? []).filter((t) => t.to?.toLowerCase() === me && t.value > 0n);
    out.push({ block: z, at: new Date(Number(blk.timestamp) * 1000).toISOString(), increase: Number(await bal(z) - await bal(z - 1)) / 1e18, txs: txs.map((t) => ({ hash: t.hash, from: t.from.toLowerCase(), value: Number(t.value) / 1e18 })) });
  }
  return out;
}
