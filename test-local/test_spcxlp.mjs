// Pruebas de las funciones puras de lp-spcx y del cliente de Hyperliquid. node test-local/test_spcxlp.mjs
import assert from "node:assert/strict";
import { spcxPrice, xaeroPrice, lpView, liqDistance, aprOf, parseSpxFund } from "../server/spcxlp.mjs";
import { hedgeOrder } from "../server/hl.mjs";
import { rangeTicks, rebalanceSwap, amountsFor } from "../server/revertloan.mjs";

const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);

// precios con las lecturas on-chain del 2026-11-17 02:17 UTC
near(spcxPrice(930025359568875203494278n), 137.8, 0.3, "SPCX/USDG");
near(xaeroPrice(120278000562703636280848003878070628n), 0.434, 0.01, "xAERO/USDG ≈ AERO");

// rango ±10 % alineado a 50
const tick = -227064, r = rangeTicks(tick, 10, 50);
assert.ok(Math.abs(r.lower % 50) === 0 && Math.abs(r.upper % 50) === 0);
near(1.0001 ** (r.upper - tick), 1.10, 0.01, "borde superior");
near(1.0001 ** (r.lower - tick), 1 / 1.10, 0.01, "borde inferior");

// reparto de $150 en USDG: valor total conservado y ~mitad en SPCX al centro del rango
const sqrtP = 930025359568875203494278n, s = Number(sqrtP) / 2 ** 96;
const sw = rebalanceSwap(0, 150e6, s, r.lower, r.upper, 100);
assert.equal(sw.sellToken0, false);
near(Number(sw.amountIn) / 1e6, 75, 6, "USDG a SPCX");
const px = spcxPrice(sqrtP);
const x0 = Number(sw.amountIn) / 1e6 / px * 1e18, x1 = 150e6 - Number(sw.amountIn);
// la liquidez que cabe con esas cantidades usa casi todo de ambos lados
const unit = amountsFor(1e18, s, r.lower, r.upper);
const L = Math.min(x0 / unit.a0, x1 / unit.a1) * 1e18;
const v = lpView(BigInt(Math.floor(L)), sqrtP, r.lower, r.upper);
near(v.usd, 150, 2, "valor del LP");
near(v.spcx * px, 75, 6, "parte SPCX");

// al bajar el precio el LP acumula SPCX (el corto debe crecer); al subir lo suelta
const down = lpView(BigInt(Math.floor(L)), BigInt(Math.floor(Number(sqrtP) * Math.sqrt(0.95))), r.lower, r.upper);
const up = lpView(BigInt(Math.floor(L)), BigInt(Math.floor(Number(sqrtP) * Math.sqrt(1.05))), r.lower, r.upper);
assert.ok(down.spcx > v.spcx && up.spcx < v.spcx);

// orden de cobertura: abrir corto, umbral, mínimo de Hyperliquid y reduceOnly
let o = hedgeOrder(-0.544, 0, 138, 2, { minUsd: 10.5, minDiffUsd: 7.5 });
assert.equal(o.sz, 0.54); assert.equal(o.isBuy, false); assert.equal(o.reduceOnly, false);
o = hedgeOrder(-0.60, -0.54, 138, 2, { minUsd: 10.5, minDiffUsd: 7.5 });
assert.equal(o.sz, 0); // $8.28 < mínimo de la orden
o = hedgeOrder(-0.40, -0.54, 138, 2, { minUsd: 10.5, minDiffUsd: 7.5 });
assert.equal(o.sz, 0.14); assert.equal(o.isBuy, true); assert.equal(o.reduceOnly, true);
o = hedgeOrder(-0.70, -0.60, 138, 2, { minUsd: 10.5, minDiffUsd: 20 });
assert.equal(o.sz, 0); // bajo el umbral del 5 %

// liquidación y APR
near(liqDistance(138, 165.6), 0.2, 1e-9, "distancia a liquidación");
assert.equal(liqDistance(138, null), Infinity);
near(aprOf(1, 150, 1), 243.33, 0.01, "APR");
assert.equal(aprOf(1, 150, 0), null);

// fondeo
assert.deepEqual(parseSpxFund("robinhood:110,hyperliquid:42@spcx-1117"), { legs: [{ dest: "robinhood", usd: 110 }, { dest: "hyperliquid", usd: 42 }], tag: "spcx-1117" });
assert.equal(parseSpxFund("polygon:5@x"), null);
assert.equal(parseSpxFund(""), null);

console.log("test_spcxlp: OK");
