// Pruebas de las funciones puras de lp-spcx y del cliente de Hyperliquid. node test-local/test_spcxlp.mjs
import assert from "node:assert/strict";
import { spcxPrice, xaeroPrice, lpView, liqDistance, aprOf, emissionsApr, parseSpxFund, widthChanged, hedgeGate } from "../server/spcxlp.mjs";
import { hedgeOrder, hlAccount } from "../server/hl.mjs";
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
assert.deepEqual(parseSpxFund("xaero:3.22:eth@repone-1120"), { legs: [{ dest: "xaero", usd: 3.22, src: "eth" }], tag: "repone-1120" });
// tramo pagado con el ETH de Base (margen del corto, 2026-11-20)
assert.deepEqual(parseSpxFund("hyperliquid:20:eth@margen-1120"), { legs: [{ dest: "hyperliquid", usd: 20, src: "eth" }], tag: "margen-1120" });
assert.equal(parseSpxFund(""), null);

// cuenta de Hyperliquid unificada: el USDC spot total YA trae el PnL sin realizar (2026-11-18). Antes se le sumaba otra vez y el
// saldo salía bajo por ese PnL. Casos reales del 17 nov (corto −0.38 tras 7 operaciones; sin el PnL abierto el spot sería $39.93):
const mainSt = { marginSummary: { accountValue: "0.0", totalMarginUsed: "0.0" }, withdrawable: "0.0", assetPositions: [] };
const real = [
  { spot: 38.32, used: 13.51, dexAcct: "13.61", pnl: "-1.60" }, // 15:57 hora de México, SPCX $142.08
  { spot: 38.12, used: 13.56, dexAcct: "13.40", pnl: "-1.81" }, // 17:05, SPCX $142.60
];
for (const c of real) for (const mode of ["unifiedAccount", "portfolioMargin", null, "default"]) {
  const dex = { marginSummary: { accountValue: c.dexAcct, totalMarginUsed: String(c.used) }, withdrawable: "0.0", assetPositions: [{ position: { coin: "xyz:SPCX", szi: "-0.38", unrealizedPnl: c.pnl } }] };
  const a = hlAccount({ dex, main: mainSt, spotUsdc: { total: c.spot, hold: c.used }, mode });
  assert.equal(a.unified, true, `unificada (${mode})`);
  near(a.account, c.spot, 1e-9, "saldo unificado = USDC spot, sin sumar el PnL otra vez");
  near(a.openPnl, Number(c.pnl), 1e-9, "PnL abierto solo informativo");
  near(a.usage, c.used / c.spot, 1e-9, "uso de margen sobre el saldo real");
  assert.equal(a.mainUsdc, 0); assert.equal(a.withdrawable, 0);
}
// el saldo nunca se toma del dex (el dex solo muestra el margen ocupado)
const dexSt = { marginSummary: { accountValue: "18.56", totalMarginUsed: "18.65" }, withdrawable: "0.0", assetPositions: [{ position: { coin: "xyz:SPCX", szi: "-0.54", unrealizedPnl: "-0.09" } }] };
near(hlAccount({ dex: dexSt, main: mainSt, spotUsdc: { total: 40.75, hold: 18.65 }, mode: "unifiedAccount" }).account, 40.75, 1e-9, "saldo = spot");
// cuenta estándar: como antes (valor del dex + USDC del principal aparte); el USDC spot no es margen
const std = hlAccount({ dex: { marginSummary: { accountValue: "40.79", totalMarginUsed: "19.0" }, withdrawable: "21.7", assetPositions: [] }, main: { marginSummary: {}, withdrawable: "3.5", assetPositions: [] }, spotUsdc: { total: 7, hold: 0 }, mode: "disabled" });
assert.equal(std.unified, false); near(std.account, 40.79, 1e-9, "saldo estándar"); near(std.mainUsdc, 3.5, 1e-9, "principal"); near(std.usage, 19 / 40.79, 1e-9, "uso estándar"); near(std.withdrawable, 21.7, 1e-9, "retirable");
// modo "disabled" manda aunque el spot tenga retención; sin lectura de spot ni de modo, también estándar
assert.equal(hlAccount({ dex: dexSt, main: mainSt, spotUsdc: { total: 40.75, hold: 18.65 }, mode: "disabled" }).unified, false);
assert.equal(hlAccount({ dex: dexSt, main: mainSt, spotUsdc: null, mode: null }).unified, false);
assert.equal(hlAccount({ dex: dexSt, main: mainSt, spotUsdc: null, mode: "unifiedAccount" }).unified, false);
// sin posición abierta y modo desconocido: no hay retención → estándar (sin doble conteo)
assert.equal(hlAccount({ dex: { marginSummary: { accountValue: "0", totalMarginUsed: "0" }, withdrawable: "0", assetPositions: [] }, main: mainSt, spotUsdc: { total: 40.75, hold: 0 }, mode: null }).unified, false);

// emisiones: el periodo es apertura → último cobro (no baja entre cobro y cobro)
near(emissionsApr(1, 149.46, 0, 86400_000), 244.21, 0.01, "APR emisiones, 1 cobro de $1 en 1 día");
near(emissionsApr(2, 149.46, 0, 2 * 86400_000), 244.21, 0.01, "APR emisiones, 2 cobros en 2 días");
assert.equal(emissionsApr(0, 149.46, 0, 0), null);
// cambio de ancho (SPX_RANGE_PCT): el rango real ±10 % [-228000, -226050] no cambia con 10 y sí con 5; el nuevo ±5 % ya no dispara
assert.equal(widthChanged(-228000, -226050, 10), false);
assert.equal(widthChanged(-228000, -226050, 5), true);
const r5 = rangeTicks(-227030, 5, 50);
assert.equal(widthChanged(r5.lower, r5.upper, 5), false);
assert.equal(widthChanged(r5.lower, r5.upper, 10), true);
near(1.0001 ** (r5.upper - -227030), 1.05, 0.01, "borde superior ±5 %");
assert.equal(widthChanged(undefined, undefined, 5), false);
// al re-centrar a ±5 % con lo retirado (SPCX + USDG) el swap es pequeño y el valor se conserva
const sw5 = rebalanceSwap(0.2762e18, 112.2e6, s, r5.lower, r5.upper, 100);
assert.ok(Number(sw5.amountIn) / 1e6 < 45 && sw5.sellToken0 === false, "swap de re-centrado");
// confirmación del reajuste del corto: umbral $7.6 (5 % del LP), 15 min, inmediato desde 2× ($15.2)
{
  const opt = { minDiffUsd: 7.6, confirmMin: 15, urgentX: 2 }, M = 60_000;
  const sell = { sz: 0.08, isBuy: false, usd: 11.4 }, buy = { sz: 0.08, isBuy: true, usd: 11.5 }, none = { sz: 0 };
  // primer cruce: no opera, abre el episodio
  let g = hedgeGate(sell, null, 0, opt);
  assert.equal(g.trade, false); assert.equal(g.started, true); assert.equal(g.dev.since, 0);
  // sigue fuera a los 10 min: aún espera; a los 15: opera
  g = hedgeGate(sell, g.dev, 10 * M, opt); assert.equal(g.trade, false); assert.ok(!g.started);
  const keep = g.dev;
  g = hedgeGate(sell, keep, 15 * M, opt); assert.equal(g.trade, true); assert.equal(g.dev, null); assert.equal(g.urgent, false);
  // caso real del 17 nov (15:51 → 16:02 UTC): el desfase se deshizo a los 11 min → no se opera y se cuenta como evitado
  g = hedgeGate(none, keep, 11 * M, opt); assert.equal(g.trade, false); assert.equal(g.dev, null); assert.equal(g.ended.since, 0);
  // caso real del 18 nov (14:34 → 14:41): cambia de lado a los 7 min → el reloj empieza de nuevo y el primero cuenta como evitado
  g = hedgeGate(buy, { since: 0, sign: -1, maxUsd: 11.4 }, 7 * M, opt);
  assert.equal(g.trade, false); assert.equal(g.dev.since, 7 * M); assert.equal(g.dev.sign, 1); assert.equal(g.ended.sign, -1);
  // desfase grande (apertura, re-centrado, salto fuerte): inmediato
  g = hedgeGate({ sz: 0.23, isBuy: false, usd: 33.35 }, null, 0, opt); assert.equal(g.trade, true); assert.equal(g.urgent, true);
  g = hedgeGate({ sz: 0.55, isBuy: false, usd: 76 }, null, 0, { ...opt, minDiffUsd: 7.5 }); assert.equal(g.trade, true);
  // sin desfase y sin episodio: nada
  g = hedgeGate(none, null, 0, opt); assert.equal(g.trade, false); assert.equal(g.ended, null);
  // confirmMin 0 = comportamiento anterior
  assert.equal(hedgeGate(sell, null, 0, { ...opt, confirmMin: 0 }).trade, true);
}
console.log("test_spcxlp: OK");

// ---- SPCX suelto → LP (addLoose) con una cadena simulada: mete lo suelto, no toca el USDG previo, cuenta como aporte y es de una sola vez
{
  const { SpcxLp, SPX } = await import("../server/spcxlp.mjs");
  const sq = 930025359568875203494278n, pxNow = spcxPrice(sq), rg = rangeTicks(-227064, 8, 50);
  const u = amountsFor(1e18, Number(sq) / 2 ** 96, rg.lower, rg.upper);
  const chain = { spcx: 52442200000000000n, usdg: 290423n, xaero: 0n, L: 10n ** 18n, staked: true, steps: [] };
  const bot = new SpcxLp({ executor: null, provider: null, store: { get: async () => null, set: async () => {} }, diag: async (m) => chain.steps.push(m) });
  bot.s = { tokenId: "1", entry: { usd: 201.15 }, contribUsd: 3.16, rewardsUsd: 0, claims: [], actions: 0 };
  bot.cfg.live = true;
  bot.save = async () => {};
  bot.bal = async (t) => (t === SPX.SPCX ? chain.spcx : t === SPX.USDG ? chain.usdg : chain.xaero);
  bot.c = () => ({ slot0: async () => [sq, -227064n], positions: async () => ({ liquidity: chain.L }) });
  bot.approve = async () => {};
  bot.splitAndSwap = async (x0, x1, sqrtP, lo, up) => {
    const sw = rebalanceSwap(Number(x0), Number(x1), Number(sqrtP) / 2 ** 96, lo, up, 100);
    assert.equal(sw.sellToken0, true, "vende parte del SPCX");
    chain.spcx -= sw.amountIn; chain.usdg += BigInt(Math.floor(Number(sw.amountIn) * (Number(sqrtP) / 2 ** 96) ** 2));
  };
  bot.unstake = async () => { assert.ok(chain.staked); chain.staked = false; chain.xaero += 10n ** 18n; return 10n ** 18n; };
  bot.stake = async () => { assert.ok(!chain.staked); chain.staked = true; };
  bot.send = async (step) => {
    assert.ok(!chain.staked, "increaseLiquidity con la NFT fuera del gauge");
    const add = Math.min(Number(chain.spcx) / u.a0, (Number(chain.usdg) - 290423) / u.a1) * 1e18;
    chain.L += BigInt(Math.floor(add)); chain.spcx -= BigInt(Math.floor(add / 1e18 * u.a0)); chain.usdg -= BigInt(Math.floor(add / 1e18 * u.a1));
  };
  const rr = { px: pxNow, xaeroPx: 0.43, lower: rg.lower, upper: rg.upper };
  const loose = 0.0524422 * pxNow;
  assert.equal(await bot.addLoose("t1", rr), true);
  assert.ok(chain.staked, "vuelve al gauge");
  near(bot.s.addedUsd, loose, loose * 0.02, "lo que entra al LP ≈ lo suelto");
  assert.ok(chain.usdg >= 290423n && chain.usdg < 290423n + 100000n, "el USDG previo de la wallet no se toca");
  assert.ok(Number(chain.spcx) / 1e18 * pxNow < 0.1, "casi no sobra SPCX");
  assert.equal(bot.s.looseTag, "t1"); assert.equal(bot.s.loosePending, null);
  near(bot.s.rewardsUsd, 0.43, 1e-9, "el xAERO cobrado al salir del gauge se registra");
  assert.ok(chain.steps.some((m) => m.includes("cobro #1:")) && chain.steps.some((m) => m.includes("cuenta como aporte")));
  // tope: no mete más de SPX_ADD_LOOSE_MAX_USD
  chain.spcx = 10n ** 18n; const Lb = chain.L;
  assert.equal(await bot.addLoose("t2", rr), false); assert.equal(chain.L, Lb); assert.equal(bot.s.looseTag, "t2");
  // fallo a media: queda pendiente, espera 10 min y se rinde al tercer intento sin perder la cuenta
  chain.spcx = 52442200000000000n; bot.send = async () => { throw new Error("revertida"); };
  await assert.rejects(bot.addLoose("t3", rr)); assert.equal(bot.s.loosePending.tries, 1);
  assert.equal(await bot.addLoose("t3", rr), false, "espera 10 min"); assert.equal(bot.s.loosePending.tries, 1);
}
console.log("addLoose OK");
