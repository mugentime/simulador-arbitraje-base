// Prueba de las cuentas del espejo del dashboard de Beefy (FIFO clásico y CLM, tramo actual, cosechas).
import assert from "node:assert/strict";
import { currentSegment, classicFifo, clmFifo, clmHarvestShare } from "../server/beefydash.mjs";

// tramo actual: lo anterior al último saldo 0 no cuenta
const seg = currentSegment([
  { datetime: "2026-11-01T00:00:00Z", share_balance: "10", share_diff: "10" },
  { datetime: "2026-11-02T00:00:00Z", share_balance: "0", share_diff: "-10" },
  { datetime: "2026-11-03T00:00:00Z", share_balance: "5", share_diff: "5" },
  { datetime: "2026-11-04T00:00:00Z", share_balance: "8", share_diff: "3" },
]);
assert.equal(seg.length, 2); assert.equal(seg[0].datetime, "2026-11-03T00:00:00Z");

// clásico: 2 depósitos, retiro FIFO del primero
const c = classicFifo([{ shares: 10, ppfs: 1.0, px: 2 }, { shares: 10, ppfs: 1.1, px: 3 }, { shares: -5, ppfs: 1.2, px: 4 }]);
assert.equal(c.shares, 15);
assert.ok(Math.abs(c.underlyingAtDeposit - (5 * 1.0 + 10 * 1.1)) < 1e-9);
assert.ok(Math.abs(c.usdAtDeposit - (5 * 1.0 * 2 + 10 * 1.1 * 3)) < 1e-9);

// CLM: depósito de $10 (5 USDC + 0.0025 X a $2000), luego $10 más, retiro de la mitad del primer lote, una recompensa cobrada
const k = clmFifo([
  { shares: 100, t0: 5, t1: 0.0025, p0: 1, p1: 2000, claims: [] },
  { shares: 100, t0: 10, t1: 0, p0: 1, p1: 1900, claims: [] },
  { shares: -50, t0: 0, t1: 0, p0: 1, p1: 2100, claims: [{ reward_address: "0xR", reward_to_usd: "0.5", claimed_amount: "2" }] },
]);
assert.equal(k.shares, 150);
assert.ok(Math.abs(k.token0 - 12.5) < 1e-9 && Math.abs(k.token1 - 0.00125) < 1e-12);
assert.ok(Math.abs(k.usdAtDeposit - (12.5 + 0.00125 * 2000)) < 1e-9);
assert.equal(k.claimedUsd, 1);

// cosechas: solo después del primer depósito, con el saldo vigente en cada una
const h = clmHarvestShare(
  [{ datetime: "2026-11-01T00:00:00Z", share_balance: "100" }, { datetime: "2026-11-03T00:00:00Z", share_balance: "200" }],
  [{ timestamp: "2026-10-31T00:00:00Z", compoundedAmount0: "100", compoundedAmount1: "0", totalSupply: "1000", token0ToUsd: "1", token1ToUsd: "1" },
   { timestamp: "2026-11-02T00:00:00Z", compoundedAmount0: "10", compoundedAmount1: "0.001", totalSupply: "1000", token0ToUsd: "1", token1ToUsd: "2000" },
   { timestamp: "2026-11-04T00:00:00Z", compoundedAmount0: "10", compoundedAmount1: "0", totalSupply: "1000", token0ToUsd: "1", token1ToUsd: "2000" }]);
assert.equal(h.n, 2);
assert.ok(Math.abs(h.usd - (0.1 * (10 + 0.001 * 2000) + 0.2 * 10)) < 1e-9);
console.log("test_beefydash OK");
