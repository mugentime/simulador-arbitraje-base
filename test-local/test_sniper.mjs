// Radar sniper: señales puras con la serie real de AI-USDG (2026-11-07) y casos de control.
import assert from "node:assert/strict";
import { dailyFromApy, emissionsPerDay, optimalSize, detectSignals, tokenExodus, concentration } from "../server/sniper.mjs";

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
// E con los datos del 7-nov: ~$636/día a 2,946 % y TVL $67.6k
near(emissionsPerDay(67636, 2946.32), 636, 3);
near(emissionsPerDay(61703, 4133.67), 636, 3);
assert.ok(Number.isFinite(dailyFromApy(4.6957690818828744e29)));
assert.equal(dailyFromApy(0), 0);
// tamaño óptimo al momento del éxodo (T=$53, E=$630, r=2 %): ~$1,240 y ~$600/día
const s = optimalSize(630, 53, 0.02); near(s.x, 1239, 5); near(s.perDay, 604, 5);

const t0 = Date.parse("2026-11-07T19:20:00Z"), m = 60_000;
const pt = (min, tvl, E = 636, amt = tvl / 70) => ({ t: t0 + min * m, tvl, amt, E });
// pre-éxodo: −9 % en 2 h con E estable (19:23 → 21:40)
const pre = [pt(0, 67636), pt(20, 65179), pt(80, 62412), pt(140, 61703)];
const sp = detectSignals(pre, { now: t0 + 140 * m });
assert.ok(sp.some((x) => x.kind === "pre-éxodo"), "debe ver pre-éxodo");
assert.ok(!sp.some((x) => x.kind === "éxodo"));
// éxodo: $61.7k → $53 en 44 min
const ex = [...pre, pt(160, 61500), pt(184, 53)];
const se = detectSignals(ex, { now: t0 + 184 * m });
const e = se.find((x) => x.kind === "éxodo"); assert.ok(e, "debe ver éxodo"); assert.ok(e.dropPct > 99); assert.equal(e.E, 636);
// caída del TVL en $ solo por precio (las unidades no cambian): no es éxodo
const px = [pt(0, 60000, 636, 1000), pt(30, 25000, 636, 1000)];
assert.equal(detectSignals(px, { now: t0 + 30 * m }).length, 0);
// éxodo con emisiones chicas: se ignora
assert.equal(detectSignals([pt(0, 5000, 5), pt(30, 100, 5)], { now: t0 + 30 * m }).filter((x) => x.kind === "éxodo").length, 0);
// éxodo de token: AI-WETH y AI-USDG perdiendo ≥ 10 % en 6 h
const te = tokenExodus([{ id: "ai-weth", token: "AI", tvl6h: 62000, tvl: 47000 }, { id: "ai-usdg", token: "AI", tvl6h: 67000, tvl: 60000 }, { id: "x", token: "X", tvl6h: 9000, tvl: 1000 }]);
assert.equal(te.length, 1); assert.equal(te[0].token, "AI");
// concentración
const c = concentration({ a: "800", b: "150", c: "50", d: "0" });
assert.equal(c.holders, 3); assert.equal(c.top1, 80); assert.equal(c.top3, 100); assert.equal(c.topAddr, "a");
assert.equal(concentration({}).top1, null);
console.log("test_sniper ok");
