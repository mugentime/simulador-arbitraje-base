// P1_RESUME debe reiniciar la racha de reverts: si no, la racha vieja vuelve a pausar con el primer revert tras reanudar.
import assert from "node:assert";
import { Executor, emptyPhase1 } from "../server/executor.mjs";
const fake = Object.create(Executor.prototype);
const saved = { phase1: { ...emptyPhase1(), modelVersion: 2, reconciledLegacy: true, revertGas: [], paused: true, pausedReason: "3 reverts seguidos", consecutiveReverts: 8, resumedWith: "viejo" } };
fake.store = { get: async (k) => saved[k], set: async (k, v) => { saved[k] = v; } };
const logs = []; fake.diag = async (m) => logs.push(m);
fake.wallet = null; fake.mode = "live";
process.env.P1_RESUME = "nuevo";
await fake.init();
assert.equal(fake.p1.paused, false);
assert.equal(fake.p1.consecutiveReverts, 0, "racha reiniciada al reanudar");
assert.ok(logs.some((m) => m.includes("reanudada")));
console.log("test_resume_streak OK");
