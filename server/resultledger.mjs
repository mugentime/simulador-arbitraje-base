// Resultado real de la cartera desde un punto de partida fijo: lo que vale hoy − lo que había − lo que se depositó,
// separado en lo que viene de los bots (comisiones − costos) y lo que viene de la volatilidad (cambio de precio).
// Este módulo lleva el libro: punto de partida, depósitos externos y el efecto de precio acumulado de lo que está libre
// en las wallets (ETH y demás tokens sin estable). El resto (comisiones, precio dentro de los vaults) lo mide Beefy.
const STABLE = /^(USDC|USDT|USDG|DAI|USDC\.e|USDbC|FDUSD|USD1|USDS|vUSDT.*)$/i;

// cuentas que entregan lo que llega por puente (Relay): eso es dinero propio moviéndose entre cadenas, no un depósito
const BRIDGE_SOLVERS = new Set(["0xf70da97812cb96acdf810712aa562db8dfa3dbef"]);

/** Libro inicial (reconstruido a mano el 2026-11-11 con los registros de los bots). */
export function seedLedger() {
  return {
    v: 1,
    start: { at: "2026-11-07T19:06:00Z", usd: 303, note: "$221.51 libres + $80.74 en Beefy + ≈ $1 en POL" },
    deposits: [
      { at: "2026-11-09T16:05:00Z", chain: "base", eth: 0.07523, usd: 161.4, tx: null },
      { at: "2026-11-11T18:57:03Z", chain: "base", eth: 0.019837, usd: 41.4, tx: "0x40e2cb00f51f4d9080f83df440ec92da1ab7a3d396ff3bbe050d3358f0420633" },
    ],
    // hasta el 2026-11-11 20:10 UTC (estimado por tramos con los saldos y precios registrados)
    seed: { at: "2026-11-11T20:10:00Z", freePrice: -12, closedPrice: -1.5, closedFees: 0.9 },
    freePrice: 0, // efecto de precio de lo libre acumulado desde seed.at
    lastFree: null, // { "<cadena>|<token>": { a: cantidad, p: precio } }
  };
}

/** Acumula el efecto de precio de los saldos libres entre dos lecturas: cantidad anterior × (precio de ahora − precio anterior). */
export function accrueFree(ledger, balances) {
  if (!balances || balances.error || !Array.isArray(balances.chains)) return 0;
  const now = {};
  for (const c of balances.chains) for (const r of c.rows ?? []) {
    if (STABLE.test(r.sym) || !(r.amount > 0) || !(r.usd > 0)) continue;
    now[`${c.chain}|${r.sym}`] = { a: r.amount, p: r.usd / r.amount };
  }
  let d = 0;
  for (const [k, prev] of Object.entries(ledger.lastFree ?? {})) {
    const cur = now[k]; if (!cur || !(prev.p > 0)) continue; // token o cadena sin lectura: no se cuenta el tramo
    const ch = cur.p / prev.p - 1;
    if (Math.abs(ch) > 0.3) continue; // salto de precio irreal (fuente de precios)
    d += prev.a * (cur.p - prev.p);
  }
  // una cadena que falla en esta lectura conserva su último dato para el siguiente tramo
  const failed = new Set((balances.errors ?? []).map((e) => String(e).split(/[ :]/)[0]));
  const keep = Object.fromEntries(Object.entries(ledger.lastFree ?? {}).filter(([k]) => failed.has(k.split("|")[0]) && !now[k]));
  ledger.lastFree = { ...keep, ...now };
  ledger.freePrice = +((ledger.freePrice ?? 0) + d).toFixed(6);
  return d;
}

/** Depósitos externos nuevos (nativo recibido desde una cuenta, no contrato) detectados por la auditoría. Devuelve cuántos agregó. */
export function addDeposits(ledger, auditDeposits, priceOf, minUsd = 5) {
  let n = 0;
  const t0 = Date.parse(ledger.start.at);
  for (const d of auditDeposits ?? []) {
    const at = Date.parse(d.at);
    if (!Number.isFinite(at) || at <= t0 || d.fromIsContract || !(d.amount > 0) || BRIDGE_SOLVERS.has(String(d.from ?? "").toLowerCase())) continue;
    const dup = ledger.deposits.some((x) => (d.tx && x.tx && x.tx.toLowerCase() === d.tx.toLowerCase()) ||
      (x.chain === d.chain && Math.abs(x.eth / d.amount - 1) < 0.01 && Math.abs(Date.parse(x.at) - at) < 86400_000));
    if (dup) { const x = ledger.deposits.find((y) => !y.tx && y.chain === d.chain && Math.abs(y.eth / d.amount - 1) < 0.01); if (x && d.tx) x.tx = d.tx; continue; }
    const px = Number(priceOf(d.chain)); if (!(px > 0)) continue;
    const usd = +(d.amount * px).toFixed(2); if (usd < minUsd) continue;
    ledger.deposits.push({ at: new Date(at).toISOString(), chain: d.chain, eth: d.amount, usd, tx: d.tx ?? null, from: d.from ?? null, auto: true });
    n++;
  }
  ledger.deposits.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return n;
}

/** Cuentas finales (puro): `now` = valor total de hoy; el costo de operar sale por diferencia. */
export function resultSplit(ledger, { now, feesOpen = 0, openPrice = 0, hedge = 0 }) {
  const deposits = ledger.deposits.reduce((a, d) => a + d.usd, 0), put = ledger.start.usd + deposits, total = now - put;
  const freePrice = ledger.seed.freePrice + (ledger.freePrice ?? 0), { closedPrice, closedFees } = ledger.seed;
  const vol = openPrice + freePrice + closedPrice;
  const costs = total - vol - feesOpen - closedFees - hedge;
  return { now, start: ledger.start.usd, deposits, put, total, bots: feesOpen + closedFees + hedge + costs, vol, feesOpen, closedFees, hedge, costs, openPrice, freePrice, closedPrice };
}
