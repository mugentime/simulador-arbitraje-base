// Envío por bundles a builders de BSC (sin registro). Ventaja clave: un bundle cuya transacción revertiría
// NO se incluye (revertingTxHashes vacío), así que un intento fallido no cuesta gas.
// Cada bundle se manda en paralelo a varios builders; basta con que uno lo incluya.

export const BSC_BUILDERS = [
  { name: "BlockRazor", url: "https://bsc.blockrazor.xyz", method: "eth_sendBundle" },
  { name: "BlockSec", url: "https://bsc.rpc.blocksec.com", method: "eth_sendBundle" },
  { name: "48 Club", url: "https://puissant-builder.48.club/", method: "eth_sendBundle" },
  { name: "BlockRazor (48)", url: "https://blockrazor-builder-virginia.48.club", method: "eth_sendBundle" },
];

export const MIN_BUNDLE_GAS_PRICE = 50_000_000n; // 0.05 gwei: precio medio mínimo que exigen los builders de BSC

/**
 * Manda `rawTx` como bundle de una transacción a todos los builders. Devuelve
 * { accepted: [nombres], errors: {nombre: mensaje} }. No lanza.
 */
/** Builders activos: BUNDLE_BUILDERS="nombre=url,nombre=url" sustituye la lista por defecto (pruebas o builders nuevos). */
export function activeBuilders() {
  const env = process.env.BUNDLE_BUILDERS;
  if (!env) return BSC_BUILDERS;
  return env.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf("="); return { name: x.slice(0, i), url: x.slice(i + 1), method: "eth_sendBundle" }; });
}

export async function sendBundle(rawTx, { maxBlockNumber, builders = activeBuilders(), timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const bundle = { txs: Array.isArray(rawTx) ? rawTx : [rawTx], revertingTxHashes: [] };
  if (maxBlockNumber) bundle.maxBlockNumber = Number(maxBlockNumber);
  const accepted = [], errors = {};
  await Promise.all(builders.map(async (b) => {
    try {
      const r = await fetchImpl(b.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: b.method, params: [bundle] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch { /* respuesta no JSON */ }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 80)}`);
      if (!j) throw new Error(`respuesta no JSON: ${txt.slice(0, 80)}`);
      if (j.error) throw new Error(`${j.error.code ?? ""} ${j.error.message ?? JSON.stringify(j.error)}`.trim().slice(0, 120));
      accepted.push(b.name);
    } catch (e) { errors[b.name] = (e.message || String(e)).slice(0, 120); }
  }));
  return { accepted, errors };
}
