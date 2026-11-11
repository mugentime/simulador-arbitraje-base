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
