// Envío por bundles a builders de BSC (sin registro). Ventaja clave: un bundle cuya transacción revertiría
// NO se incluye (revertingTxHashes vacío), así que un intento fallido no cuesta gas.
// Cada bundle se manda en paralelo a varios builders; basta con que uno lo incluya.

export const BSC_BUILDERS = [
  { name: "BlockRazor", url: "https://bsc.blockrazor.xyz", method: "eth_sendBundle" },
  { name: "BlockSec", url: "https://bsc.rpc.blocksec.com", method: "eth_sendBundle" },
  { name: "48 Club", url: "https://puissant-builder.48.club/", method: "eth_sendBundle" },
];

export const MIN_BUNDLE_GAS_PRICE = 50_000_000n; // 0.05 gwei: precio medio mínimo que exigen los builders de BSC

/**
 * Manda `rawTx` como bundle de una transacción a todos los builders. Devuelve
 * { accepted: [nombres], errors: {nombre: mensaje} }. No lanza.
 */
/** Builders activos: BUNDLE_BUILDERS="nombre=url,nombre=url" sustituye la lista por defecto (pruebas o builders nuevos). */
export function activeBuilders() {
  const env = process.env.BUNDLE_BUILDERS;
  if (!env) return process.env.NODEREAL_KEY ? [...BSC_BUILDERS, { name: "NodeReal", url: `https://bsc-mainnet.nodereal.io/v1/${process.env.NODEREAL_KEY}`, method: "eth_sendBundle" }] : BSC_BUILDERS;
  return env.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf("="); return { name: x.slice(0, i), url: x.slice(i + 1), method: "eth_sendBundle" }; });
}

// Builders que respondieron HTTP 429 (cuota/límite: p. ej. NodeReal en BSC desde 2026-11-05) se saltan un rato
// en vez de gastar una petición por bundle que siempre falla. BUNDLE_429_COOLDOWN_MS (por defecto 10 min; 0 = nunca saltar).
export const builderCooldown = new Map(); // nombre → epoch ms hasta el que se salta
export const bundleStats = { skipped429: 0 };
const cooldownMs = () => Number(process.env.BUNDLE_429_COOLDOWN_MS ?? 600_000);

export async function sendBundle(rawTx, { maxBlockNumber, builders = activeBuilders(), timeoutMs = 2500, fetchImpl = fetch, now = Date.now } = {}) {
  const bundle = { txs: Array.isArray(rawTx) ? rawTx : [rawTx], revertingTxHashes: [] };
  if (maxBlockNumber) bundle.maxBlockNumber = Number(maxBlockNumber);
  const accepted = [], errors = {};
  const t = now();
  const live = builders.filter((b) => !((builderCooldown.get(b.name) ?? 0) > t));
  if (live.length < builders.length) bundleStats.skipped429 += builders.length - live.length;
  await Promise.all(live.map(async (b) => {
    try {
      const r = await fetchImpl(b.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: b.method, params: [bundle] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch { /* respuesta no JSON */ }
      if (r.status === 429 && cooldownMs() > 0) builderCooldown.set(b.name, now() + cooldownMs());
      if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 80)}`);
      if (!j) throw new Error(`respuesta no JSON: ${txt.slice(0, 80)}`);
      if (j.error) throw new Error(`${j.error.code ?? ""} ${j.error.message ?? JSON.stringify(j.error)}`.trim().slice(0, 120));
      accepted.push(b.name);
    } catch (e) { errors[b.name] = (e.message || String(e)).slice(0, 120); }
  }));
  return { accepted, errors };
}
