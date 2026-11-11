import assert from "node:assert/strict";
import { seedLedger, accrueFree, addDeposits, resultSplit } from "../server/resultledger.mjs";
const near = (a, b, e = 0.01) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
// efecto de precio de lo libre: cantidad anterior × cambio de precio; los estables no cuentan
{
  const L = seedLedger();
  const b = (p, a = 0.01) => ({ chains: [{ chain: "base", rows: [{ sym: "ETH", amount: a, usd: a * p }, { sym: "USDC", amount: 50, usd: 50 }] }] });
  near(accrueFree(L, b(2000)), 0); near(accrueFree(L, b(2100)), 1); near(accrueFree(L, b(2100, 0.5)), 0); near(accrueFree(L, b(2000, 0.5)), -50);
  near(L.freePrice, -49);
  // cadena con error: no cuenta ese tramo pero conserva el dato
  accrueFree(L, { chains: [], errors: ["base: timeout"] }); assert.ok(L.lastFree["base|ETH"]);
  near(accrueFree(L, b(2010, 0.5)), 5);
  // salto irreal de precio se ignora
  near(accrueFree(L, b(4000, 0.5)), 0);
}
// depósitos: no duplica los sembrados, agrega los nuevos desde cuentas, ignora contratos y montos chicos
{
  const L = seedLedger();
  const n = addDeposits(L, [
    { chain: "base", at: "2026-11-09T16:07:11Z", amount: 0.07523, tx: "0xaaa", fromIsContract: false },
    { chain: "base", at: "2026-11-11T18:57:03Z", amount: 0.019837, tx: "0x40E2CB00f51f4d9080f83df440ec92da1ab7a3d396ff3bbe050d3358f0420633", fromIsContract: false },
    { chain: "base", at: "2026-11-12T10:00:00Z", amount: 0.05, tx: "0xbbb", fromIsContract: false },
    { chain: "base", at: "2026-11-12T11:00:00Z", amount: 0.05, tx: "0xccc", fromIsContract: true },
    { chain: "base", at: "2026-11-12T12:00:00Z", amount: 0.0001, tx: "0xddd", fromIsContract: false },
    { chain: "base", at: "2026-11-05T12:00:00Z", amount: 0.08, tx: "0xeee", fromIsContract: false },
  ], () => 2000);
  assert.equal(n, 1); assert.equal(L.deposits.length, 3); assert.equal(L.deposits[0].tx, "0xaaa"); near(L.deposits[2].usd, 100);
  assert.equal(addDeposits(L, [{ chain: "base", at: "2026-11-12T10:00:00Z", amount: 0.05, tx: "0xbbb", fromIsContract: false }], () => 2000), 0);
}
// cuentas: bots + volatilidad = total; con los datos del 11-nov da ≈ 0 = +2.5 − 2.5
{
  const r = resultSplit(seedLedger(), { now: 506.01, feesOpen: 3.77, openPrice: 11.0, hedge: -0.04 });
  near(r.put, 505.8); near(r.total, 0.21); near(r.bots + r.vol, r.total); near(r.vol, -2.5); near(r.costs, -1.92);
}
console.log("libro de resultados ok");
// una cadena que no responde no vale cero: se rellena con su último dato bueno (caso real 11-nov 23:48: Base con timeout)
{
  const { carryForward } = await import("../server/resultledger.mjs");
  const last = {}, t1 = 1000, t2 = 2000, t3 = 3000;
  const W = (pos, read) => ({ positions: pos.map(([chain, id, valueUsd]) => ({ chain, id, valueUsd })), readChains: read, totalUsd: 0 });
  const B = (rows) => ({ chains: rows.map(([chain, usd, partial]) => ({ chain, usd, rows: [], ...(partial ? { partial } : {}) })), totalUsd: 0, errors: [] });
  let w = W([["base", "nvdac", 141.81], ["robinhood", "ai", 213.44], ["robinhood", "gld", 4.9]], ["base", "robinhood", "monad"]), b = B([["base", 33.92], ["robinhood", 13.03]]);
  assert.equal(carryForward(last, w, b, t1).length, 0); near(w.totalUsd, 360.15); near(b.totalUsd, 46.95);
  // Base no responde y AI-USDG se cerró de verdad (Robinhood sí respondió): Base se rellena, AI no vuelve
  w = W([["robinhood", "gld", 4.9]], ["robinhood", "monad"]); b = B([["robinhood", 222.79]]);
  const st = carryForward(last, w, b, t2);
  assert.deepEqual(st.map((x) => [x.kind, x.chain, x.usd, x.t]), [["vaults", "base", 141.81, t1], ["libre", "base", 33.92, t1]]);
  near(w.totalUsd, 146.71); near(b.totalUsd, 256.71); assert.equal(w.positions.find((p) => p.id === "nvdac").stale, t1); assert.ok(!w.positions.some((p) => p.id === "ai"));
  // toda la lectura de saldos falla, o una cadena llega parcial: se usa lo anterior
  b = { error: "timeout" }; assert.equal(carryForward(last, W([["robinhood", "gld", 4.9]], ["robinhood"]), b, t3).filter((x) => x.kind === "libre").length, 2); near(b.totalUsd, 256.71);
  b = B([["base", 26.49, true], ["robinhood", 222.79]]); carryForward(last, W([], []), b, t3); near(b.totalUsd, 256.71); assert.equal(b.chains.find((c) => c.chain === "base").usd, 33.92);
  // vuelve Base: sin relleno y con el dato nuevo
  w = W([["base", "nvdac", 140]], ["base", "robinhood"]); b = B([["base", 30], ["robinhood", 222.79]]);
  assert.equal(carryForward(last, w, b, 4000).length, 0); near(w.totalUsd, 140); near(b.totalUsd, 252.79);
}
// espejo de Beefy: filas de una cadena sin lectura se conservan y el resumen se recalcula
{
  const { carryDash } = await import("../server/beefydash.mjs");
  const last = {}, row = (chain, id, nowUsd, pnlUsd, yieldUsd) => ({ chain, id, nowUsd, pnlUsd, yieldUsd, atDepositUsd: nowUsd - pnlUsd, dailyUsd: 0 });
  let d = { rows: [row("base", "nvdac", 141.81, -7.92, 0.79), row("robinhood", "gld", 4.9, -0.08, 0)], readChains: ["base", "robinhood"], summary: {}, errors: [] };
  assert.equal(carryDash(last, d, 1000).length, 0);
  d = { rows: [row("robinhood", "gld", 4.9, -0.08, 0)], readChains: ["robinhood"], summary: {}, errors: [] };
  assert.equal(carryDash(last, d, 2000).length, 1); assert.equal(d.rows.length, 2); near(d.summary.pnlUsd, -8); near(d.summary.yieldUsd, 0.79); assert.equal(d.rows[0].stale, 1000);
  console.log("relleno de lecturas ok");
}
