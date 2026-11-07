// Modo auto con vault fijo (AUTO_PIN), salida por pérdida (HIGH_APY_EXIT_LOSS_PCT) y por APY < fracción del máximo, sin re-entrar al que salió
process.env.STRATEGY = "beefy-clm-dca"; process.env.STRATEGY_VAULT_ID = "auto";
process.env.AUTO_PIN = "zec-rp"; process.env.AUTO_REDEPLOY = "1"; process.env.HIGH_APY_MIN_PCT = "0"; process.env.HIGH_APY_MIN_TVL = "100000";
process.env.HIGH_APY_EXIT_PCT = "0"; process.env.HIGH_APY_EXIT_FRAC = "0.5"; process.env.HIGH_APY_EXIT_HOURS = "6"; process.env.HIGH_APY_EXIT_LOSS_PCT = "10";
const { Strategy } = await import("../server/strategy.mjs");
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const vaults = { "zec-rp": { apy: 3.4, tvl: 318000, clm: "0x" + "1".repeat(40) }, "btcb-rp": { apy: 0.23, tvl: 156000, clm: "0x" + "2".repeat(40) }, "tiny-rp": { apy: 200, tvl: 900, clm: "0x" + "3".repeat(40) } };
globalThis.fetch = async (url) => {
  const p = new URL(url).pathname; let j;
  if (p === "/gov-vaults") j = Object.entries(vaults).map(([id, v]) => ({ id, chain: "bsc", status: "active", tokenAddress: v.clm, name: id }));
  else if (p === "/cow-vaults") j = Object.values(vaults).map((v) => ({ chain: "bsc", earnContractAddress: v.clm, depositTokenAddresses: [USDT, "0x" + "9".repeat(40)] }));
  else if (p === "/apy/breakdown") j = Object.fromEntries(Object.entries(vaults).map(([id, v]) => [id, { totalApy: v.apy }]));
  else if (p === "/tvl") j = { 56: Object.fromEntries(Object.entries(vaults).map(([id, v]) => [id, v.tvl])) };
  else j = {};
  return { ok: true, json: async () => j };
};
const logs = [];
const store = { m: {}, async get(k) { return this.m[k]; }, async set(k, v) { this.m[k] = v; } };
const s = new Strategy({ executor: { wallet: { address: "0x327526EC22821c0667d4A02FaEe50794281b965d" }, mode: "live" }, provider: {}, store, diag: async (m) => logs.push(m) });
await s.init();
s.net = { ...s.net, beefy: "bsc", stable: USDT, stableSym: "USDT", stableDec: 18, nativeFee: null };
const now = Date.parse("2026-11-07T17:00:00Z");
const d = { n: 2, lastAt: now - 17 * 3600_000, holdings: { "zec-rp": { since: "x", entryApyPct: 1260, peakApyPct: 1793, usd: 30 } } };
s.lastCost = {}; // sin RPC: el reporte de costo falla y no hay datos de pérdida
// 1) APY 340 % < 50 % del máximo (896 %): entra en vigilancia, sigue como destino fijo
let r = await s.autoTick({}, d, now);
ok(!r && d.target === "zec-rp", "fijo: el destino sigue siendo ZEC aunque haya otros elegibles");
ok(d.holdings["zec-rp"].badSince === now && logs.some((l) => /zec-rp en vigilancia \(APY 340 % < 897 %/.test(l)), "APY < mitad del máximo → vigilancia");
ok(logs.some((l) => /salida si APY < 50 % del máximo por 6 h o PnL ≤ −10 %/.test(l) && /fijo zec-rp/.test(l)), "línea de vigilancia con las reglas");
ok(!d.candidates.some((c) => c.startsWith("tiny-rp")), "TVL < $100k no es elegible");
// 2) a las 6 h: salida (exitClm falla sin RPC → se registra el intento)
logs.length = 0;
r = await s.autoTick({}, d, now + 6 * 3600_000);
ok(r === true && logs.some((l) => /salida de zec-rp falló/.test(l)), "6 h por debajo → intenta salir");
// 3) pérdida > 10 %: sale aunque el APY esté bien (sin esperar 6 h)
const d2 = { n: 1, lastAt: now, holdings: { "btcb-rp": { since: "x", entryApyPct: 23, peakApyPct: 23, usd: 10 } } };
s.lastCost = {}; s.lossPct = 10;
logs.length = 0;
s.lastCost = { "btcb-rp": { invested: 10, pnlPct: -12.5 } };
// sin RPC el reporte no actualiza lastCost; se usa el último valor conocido
r = await s.autoTick({}, d2, now);
ok(r === true && logs.some((l) => /salida de btcb-rp falló/.test(l)) , "PnL −12.5 % → salida inmediata");
// 4) el que salió en las últimas 24 h no vuelve a ser destino; el fijo cerrado ya no fuerza destino
const d3 = { n: 3, lastAt: now, holdings: { "zec-rp": { closed: new Date(now - 3600_000).toISOString() } } };
s.lastCost = {};
await s.autoTick({}, d3, now);
ok(d3.target === "btcb-rp", "tras salir de ZEC el destino es el mejor elegible restante (BTCB-USDT)");
console.log(fails ? `${fails} FALLAS` : "todo OK"); process.exit(fails ? 1 : 0);
