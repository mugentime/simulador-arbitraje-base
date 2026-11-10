import assert from "node:assert/strict";
import { openSizing, token0Share, healths, cometToRevertAmount, revertToCometAmount, NLP } from "../server/neutrallp.mjs";
import { rangeTicks } from "../server/revertloan.mjs";
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
// tamaño con $50, 65 % / 65 %
const o = openSizing(50, 0.65, 0.65);
near(o.V, 32.5 / (1 - 0.4225)); near(o.F, 0.65 * o.V); near(o.A, 50 + o.F);
near(0.65 * o.A, o.V); // deuda WETH = 65 % del colateral = LP
// saludes iniciales
const x0 = { rColl: NLP.REVERT_CF * o.V, rDebt: o.F, cColl: o.A, cDebtUsd: o.V };
const h = healths(x0); near(h.revert, 0.775 / 0.65); near(h.comet, 0.85 / 0.65);
// rango centrado: ~50 % en token0
const tick = -266088, { lower, upper } = rangeTicks(tick, 2, 10);
assert.ok(Math.abs(lower % 10) === 0 && Math.abs(upper % 10) === 0); assert.ok(lower < tick && tick < upper);
const w = token0Share(Math.sqrt(1.0001 ** tick), lower, upper); assert.ok(w > 0.4 && w < 0.6, `w0 ${w}`);
// cripto −10 %: Revert baja, Compound sube → traspaso Compound→Revert
const d = { rColl: x0.rColl * 0.9, rDebt: x0.rDebt, cColl: x0.cColl, cDebtUsd: x0.cDebtUsd * 0.9 };
const hd = healths(d); assert.ok(hd.revert < 1.10 && hd.comet > 1.4);
const a1 = cometToRevertAmount(d, 1.19, 1.18); assert.ok(a1 > 0);
const after = healths({ ...d, rDebt: d.rDebt - a1, cColl: d.cColl - a1 });
near(after.revert, 1.19, 1e-9); assert.ok(after.comet >= 1.18 - 1e-9);
// cripto +20 %: Compound baja, Revert sube → traspaso Revert→Compound
const u = { rColl: x0.rColl * 1.2, rDebt: x0.rDebt, cColl: x0.cColl, cDebtUsd: x0.cDebtUsd * 1.2 };
const hu = healths(u); assert.ok(hu.comet < 1.15 && hu.revert > 1.4);
const a2 = revertToCometAmount(u, 1.30, 1.12); assert.ok(a2 > 0);
const after2 = healths({ ...u, rDebt: u.rDebt + a2, cColl: u.cColl + a2 });
assert.ok(after2.comet > hu.comet && after2.comet <= 1.30 + 1e-9); assert.ok(after2.revert >= 1.12 - 1e-9);
// límites: sin margen en el otro lado → 0
assert.equal(cometToRevertAmount({ ...d, cColl: 1.18 * d.cDebtUsd / 0.85 }, 1.19, 1.18), 0);
console.log("test_neutrallp: ok", { V: o.V.toFixed(2), F: o.F.toFixed(2), A: o.A.toFixed(2), revert: h.revert.toFixed(3), comet: h.comet.toFixed(3), down10: [hd.revert.toFixed(3), a1.toFixed(2)], up20: [hu.comet.toFixed(3), a2.toFixed(2)] });
