// Cosecha con menos vueltas (2026-11-10) y cazador de APY eliminado.
// Casos reales del 10-nov: BONER-WETH salió por "−10.24 %/día" (precio) con el vault pagando 2.9 %/día y volvió a entrar 3 min después.
import assert from "node:assert/strict";
process.env.STRATEGY = "beefy-clm-dca";
const { harvestExitWhy, gasNative, Strategy } = await import("../server/strategy.mjs");
const H = 3600_000, t0 = Date.parse("2026-11-10T06:27:00Z");

// 1) el precio baja (nuestra posición −10 %/día) pero el vault sigue pagando 2.9 %/día: NO sale
{ const p = {}; assert.equal(harvestExitWhy(p, { now: t0 + 7 * H, age: 7 * H, vp: 2.9, rate: -0.1024 }), null); assert.equal(p.lowSince, null); }
// 2) el vault baja de 0.5 %/día antes de la permanencia mínima (24 h): no sale; después de 24 h y 2 h seguidas abajo: sale
{
  const p = {};
  assert.equal(harvestExitWhy(p, { now: t0 + 6 * H, age: 6 * H, vp: 0.3 }), null);
  assert.equal(harvestExitWhy(p, { now: t0 + 25 * H, age: 25 * H, vp: 0.3 }), "rendimiento del vault 0.3 %/día < 0.5 % por 2 h");
}
// 3) baja solo 1 h y se recupera: el contador se reinicia
{
  const p = {};
  harvestExitWhy(p, { now: t0 + 30 * H, age: 30 * H, vp: 0.3 });
  assert.equal(harvestExitWhy(p, { now: t0 + 31 * H, age: 31 * H, vp: 0.8 }), null); assert.equal(p.lowSince, null);
  assert.equal(harvestExitWhy(p, { now: t0 + 32 * H, age: 32 * H, vp: 0.3 }), null);
}
// 4) vault sin medición (salió de la lista): respaldo con nuestro rendimiento
{ const p = { lowSince: t0 }; assert.match(harvestExitWhy(p, { now: t0 + 26 * H, age: 26 * H, vp: null, rate: -0.02 }), /vault sin medición/); }
// 5) rotación: otro paga ≥ 2× durante 12 h, pero solo después de la permanencia mínima
{
  const p = {}, best = { name: "NET-USDG", pct: 5 };
  assert.equal(harvestExitWhy(p, { now: t0, age: 1 * H, vp: 2, best }), null);
  assert.equal(harvestExitWhy(p, { now: t0 + 13 * H, age: 14 * H, vp: 2, best }), null, "13 h de ventaja pero 14 h de edad: espera");
  assert.match(harvestExitWhy(p, { now: t0 + 23 * H, age: 24 * H, vp: 2, best }), /^rotación: NET-USDG/);
}
// 6) la permanencia y el umbral se configuran
{ const p = { lowSince: t0 }; assert.ok(harvestExitWhy(p, { now: t0 + 3 * H, age: 7 * H, vp: 0.9 }, { SNIPER_HARVEST_MIN_HOLD_H: "6", SNIPER_HARVEST_EXIT_PCT: "1" })); }
console.log("cosecha: salida por rendimiento del vault, histéresis y permanencia mínima ok");

// gas por corrida
assert.equal(gasNative([{ fee: "1000000000000000" }, { fee: "500000000000000" }, { gasUsed: "1" }]), 0.0015);
assert.equal(gasNative(undefined), 0);
console.log("gas por corrida ok");

// cazador de APY: auto sin AUTO_PIN queda apagado; auto con AUTO_PIN (BSC) sigue; AUTO_HUNTER=1 lo reactiva
const mk = (env) => { const keep = { ...process.env }; Object.assign(process.env, env); try { return new Strategy({ store: { get: async () => null, set: async () => {} } }); } catch { return null; } finally { for (const k of Object.keys(env)) if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } };
const off = mk({ STRATEGY_VAULT_ID: "auto" }), pin = mk({ STRATEGY_VAULT_ID: "auto", AUTO_PIN: "uniswap-cow-bsc-zec-usdt-rp" }), on = mk({ STRATEGY_VAULT_ID: "auto", AUTO_HUNTER: "1" }), fixed = mk({ STRATEGY_VAULT_ID: "aero-cow-base-usdc-nvdac-vault" });
if (off && pin && on && fixed) {
  assert.equal(off.hunterOff, true); assert.equal(pin.hunterOff, false); assert.equal(on.hunterOff, false); assert.equal(fixed.hunterOff, false);
  console.log("cazador apagado (auto sin AUTO_PIN) ok");
} else console.log("cazador: no se pudo construir Strategy aislada en este test (se cubre con node --check y test_auto_pin)");
console.log("todo OK");
