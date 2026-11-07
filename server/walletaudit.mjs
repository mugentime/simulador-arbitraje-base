// Auditoría de retiros de la wallet (orden de Jose 2026-11-06 19:34 "Revisa si ha habido retiros"): con los
// exploradores Blockscout de cada cadena lista los movimientos SALIENTES hacia cuentas sin código (EOA) distintas de la
// propia wallet (nativo y tokens) y los depósitos ENTRANTES de nativo desde EOAs (para identificar la cuenta del último
// depósito de ETH, la única autorizada a recibir retiros).
const EXPLORERS = { base: "https://base.blockscout.com", optimism: "https://optimism.blockscout.com", arbitrum: "https://arbitrum.blockscout.com", polygon: "https://polygon.blockscout.com", robinhood: "https://robinhoodchain.blockscout.com" };
async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } }); if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`); return r.json(); }
async function pages(url, max = 4) { const out = []; let next = null; for (let i = 0; i < max; i++) { const j = await get(url + (next ? (url.includes("?") ? "&" : "?") + new URLSearchParams(next) : "")); out.push(...(j.items ?? [])); if (!j.next_page_params) break; next = j.next_page_params; } return out; }

export async function auditWallet(address, { days = 14, whitelist = [] } = {}) {
  const me = address.toLowerCase(), since = Date.now() - days * 86400_000, wl = whitelist.map((x) => x.toLowerCase());
  const res = { at: new Date().toISOString(), address, days, chains: {}, withdrawals: [], deposits: [], errors: [] };
  await Promise.all(Object.entries(EXPLORERS).map(async ([chain, base]) => {
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
    } catch (e) { res.errors.push(`${chain}: ${e.message.slice(0, 100)}`); }
  }));
  res.withdrawals.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  res.deposits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
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
