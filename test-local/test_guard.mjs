import assert from "node:assert/strict";
import { guardEval, guardLevel, runGuard } from "../server/guard.mjs";
const H = 3600_000, t0 = Date.parse("2026-11-11T00:00:00Z");
const mk = (rows) => rows.map(([h, price, y = null, now = 200, liq = 30000, vol = 400000]) => ({ t: t0 + h * H, price, vol24: vol, liq, yieldUsd: y, nowUsd: now, atDep: 200 }));
// sano: sin alertas
{ const e = guardEval(mk([[0, 0.030, 0], [12, 0.032, 1.2], [24, 0.031, 2.4]])); assert.equal(e.alerts.length, 0); assert.ok(Math.abs(e.m.ratePct - 1.2) < 0.01); }
// −15 % desde el máximo de 24 h
{ const e = guardEval(mk([[0, 0.030], [10, 0.034], [23, 0.033], [24, 0.0285]])); assert.deepEqual(e.alerts.map((a) => a.k), ["precio", "caida"]); }
// ritmo real bajo
{ const e = guardEval(mk([[0, 0.03, 1.0], [24, 0.03, 1.5]])); assert.deepEqual(e.alerts.map((a) => a.k), ["rendimiento"]); }
// Beefy reinició la cuenta de comisiones (bajan): no se evalúa el ritmo
{ const e = guardEval(mk([[0, 0.03, 9], [24, 0.03, 0.5]])); assert.equal(e.alerts.length, 0); }
// pérdida de la posición y avisos de liquidez/volumen
{ const e = guardEval(mk([[0, 0.03, null, 200, 60000], [1, 0.03, null, 178, 30000, 40000]])); assert.deepEqual(e.alerts.map((a) => a.k), ["perdida"]); assert.equal(e.warns.length, 2); }
// niveles: nueva → sin repetir → recordatorio a las 6 h → nueva causa → OK
{
  const st = {}, a = { alerts: [{ k: "precio" }], warns: [] }, b = { alerts: [{ k: "precio" }, { k: "perdida" }], warns: [] };
  assert.equal(guardLevel(st, a, t0), "ALERTA NUEVA"); assert.equal(guardLevel(st, a, t0 + H), "ALERTA"); assert.equal(guardLevel(st, a, t0 + 6 * H), "ALERTA RECORDATORIO");
  assert.equal(guardLevel(st, b, t0 + 7 * H), "ALERTA NUEVA"); assert.equal(guardLevel(st, { alerts: [], warns: [] }, t0 + 8 * H), "OK"); assert.equal(guardLevel(st, a, t0 + 9 * H), "ALERTA NUEVA");
}
// corrida completa con datos simulados; si DexScreener falla, la línea lo dice y no truena
{
  const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = v; } };
  const row = { nowUsd: 216.26, atDepositUsd: 203.49, yieldUsd: 3.0 };
  const r = await runGuard({ store, row, name: "AI-USDG", chain: "robinhood", pool: "0xdcd2", fetchJson: async () => ({ pairs: [{ priceUsd: "0.03208", volume: { h24: 421622 }, liquidity: { usd: 30165 }, priceChange: { h24: 18.59 }, txns: { h24: { buys: 1027, sells: 1168 } } }] }) });
  assert.equal(r.level, "OK"); assert.match(r.line, /^vigía AI-USDG: OK · precio \$0\.03208/);
  const r2 = await runGuard({ store, row, name: "AI-USDG", chain: "robinhood", pool: "0xdcd2", fetchJson: async () => { throw new Error("HTTP 429"); } });
  assert.match(r2.line, /sin dato \(HTTP 429\)/); assert.equal(mem.guard.hist.length, 2);
  // confirmación: la causa debe repetirse en dos evaluaciones seguidas
  const low = async () => ({ pairs: [{ priceUsd: "0.0250", volume: { h24: 4e5 }, liquidity: { usd: 3e4 }, priceChange: { h24: -22 } }] });
  const a1 = await runGuard({ store, row, name: "AI-USDG", chain: "robinhood", pool: "0xdcd2", fetchJson: low });
  assert.equal(a1.level, "ALERTA NUEVA"); assert.deepEqual(a1.keys, ["precio"]); assert.deepEqual(a1.confirmed, []);
  const a2 = await runGuard({ store, row, name: "AI-USDG", chain: "robinhood", pool: "0xdcd2", fetchJson: low });
  assert.deepEqual(a2.confirmed, ["precio"]);
}
console.log("vigía ok");

// decisión del vigía automático (salida / cobro diario)
{
  const { guardDecision } = await (async () => { process.env.STRATEGY = "beefy-clm-dca"; return import("../server/strategy.mjs"); })();
  const D = 24 * 3600_000, row = (now, dep = 203.49) => ({ nowUsd: now, atDepositUsd: dep, yieldUsd: 3 });
  // alerta de precio → salida total; la de rendimiento sola no saca
  assert.equal(guardDecision({}, { keys: ["precio"], confirmed: ["precio"], alerts: ["precio −16 %"], row: row(180) }, [], t0).kind, "exit");
  assert.equal(guardDecision({}, { keys: ["precio"], confirmed: [], alerts: ["precio −16 %"], row: row(203) }, [], t0), null, "sin confirmar no sale");
  assert.equal(guardDecision({}, { keys: ["rendimiento"], confirmed: ["rendimiento"], alerts: ["ritmo bajo"], row: row(203) }, [], t0), null);
  // cobro: la base se fija el primer día; no cobra antes de 24 h ni si la ganancia es menor al mínimo
  const G = {};
  assert.equal(guardDecision(G, { keys: [], row: row(218.29) }, [], t0), null); assert.equal(G.basis.usd, 203.49);
  assert.equal(guardDecision(G, { keys: [], row: row(225) }, [], t0 + 23 * 3600_000), null);
  const t = guardDecision(G, { keys: [], row: row(228.29, 190) }, [{ at: new Date(t0 + 3600_000).toISOString(), usd: 10 }, { at: new Date(t0 - 3600_000).toISOString(), usd: 10 }], t0 + D);
  assert.equal(t.kind, "take"); assert.ok(Math.abs(t.basis - 213.49) < 1e-9 && Math.abs(t.gain - 14.8) < 1e-9 && Math.abs(t.frac - 14.8 / 228.29) < 1e-9);
  G.lastTakeAt = t0 + D;
  assert.equal(guardDecision(G, { keys: [], row: row(230) }, [], t0 + D + 3600_000), null, "una vez al día");
  assert.equal(guardDecision(G, { keys: [], row: row(205) }, [], t0 + 2 * D), null, "ganancia menor al mínimo");
  assert.equal(guardDecision(G, { keys: [], row: row(500) }, [], t0 + 2 * D).frac, 0.5, "tope 50 %");
  console.log("vigía automático ok");
}
// sin posición: mide pero no alerta
{
  const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = v; } };
  const hi = async () => ({ pairs: [{ priceUsd: "0.036", volume: { h24: 4e5 }, liquidity: { usd: 3e4 }, priceChange: { h24: 5 } }] }), lo = async () => ({ pairs: [{ priceUsd: "0.029", volume: { h24: 4e5 }, liquidity: { usd: 3e4 }, priceChange: { h24: -19 } }] });
  await runGuard({ store, row: null, name: "AI-USDG", chain: "robinhood", pool: "0x", fetchJson: hi });
  const r = await runGuard({ store, row: null, name: "AI-USDG", chain: "robinhood", pool: "0x", fetchJson: lo });
  assert.equal(r.level, "SIN POSICIÓN"); assert.deepEqual(r.keys, []); assert.deepEqual(r.confirmed, []); assert.match(r.line, /^vigía AI-USDG: SIN POSICIÓN · precio/);
  console.log("vigía sin posición ok");
}
// sin dinero en el vault: estado en reposo, sin precio ni alertas
{
  const { guardIdle } = await import("../server/guard.mjs");
  const r = guardIdle("AI-USDG", Date.parse("2026-11-12T00:00:00Z"));
  assert.equal(r.level, "SIN POSICIÓN"); assert.equal(r.idle, true); assert.equal(r.px, null); assert.deepEqual(r.confirmed, []); assert.match(r.line, /^vigía AI-USDG: SIN POSICIÓN · no hay dinero/);
  console.log("vigía en reposo ok");
}
// precio cuando el token base del par es el dólar (NVDAc-USDC puede venir como USDC/NVDAc)
{
  const { pairPrice } = await import("../server/guard.mjs");
  assert.deepEqual(pairPrice({ priceUsd: "0.0558", priceNative: "0.0000268", baseToken: { symbol: "CASHCAT" }, quoteToken: { symbol: "WETH" } }), { price: 0.0558, inv: false });
  const q = pairPrice({ priceUsd: "1.0", priceNative: "0.005", baseToken: { symbol: "USDC" }, quoteToken: { symbol: "NVDAc" } });
  assert.ok(q.inv && Math.abs(q.price - 200) < 1e-9);
  const { guardDecision, GUARD_DEFS, resolveVaultSpec } = await import("../server/strategy.mjs");
  assert.equal(guardDecision({}, { confirmed: [], row: { nowUsd: 300, atDepositUsd: 100 } }, [], t0 + 5 * 24 * 3600_000, { take: false }), null, "sin cobro en vaults sin take");
  assert.equal(guardDecision({}, { confirmed: ["perdida"], alerts: ["x"], row: { nowUsd: 80, atDepositUsd: 100 } }, [], t0, { take: false }).kind, "exit");
  assert.deepEqual(GUARD_DEFS.base.map((d) => d.key), ["NVDAc-USDC"]); assert.deepEqual(GUARD_DEFS.robinhood.map((d) => d.key), ["AI-USDG", "CASHCAT-WETH"]);
  // "aero:CASHCAT-WETH" elige el vault de Aerodrome aunque el de Uniswap tenga más TVL
  const of = globalThis.fetch;
  globalThis.fetch = async (u) => ({ ok: true, json: async () => String(u).endsWith("/vaults") ? [
    { id: "uniswap-cow-robinhood-cashcat-weth-vault", name: "CASHCAT-WETH", chain: "robinhood", status: "active", type: "standard", platformId: "uniswap" },
    { id: "aero-cow-robinhood-cashcat-weth-vault", name: "CASHCAT-WETH", chain: "robinhood", status: "active", type: "standard", platformId: "aerodrome" }] : String(u).endsWith("/tvl") ? { 4663: { "uniswap-cow-robinhood-cashcat-weth-vault": 20000, "aero-cow-robinhood-cashcat-weth-vault": 500 } } : [] });
  assert.equal(await resolveVaultSpec("aero:CASHCAT-WETH", "robinhood"), "aero-cow-robinhood-cashcat-weth-vault");
  assert.equal(await resolveVaultSpec("CASHCAT-WETH", "robinhood"), "uniswap-cow-robinhood-cashcat-weth-vault");
  globalThis.fetch = of;
  console.log("vigía multi-vault ok");
}
