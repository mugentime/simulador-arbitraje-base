// Escalera de montos en paralelo: 1 ida y vuelta, se elige el mayor monto que funciona y solo ese se contabiliza.
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const mk = (okFrom, reason = "Error(transferFrom reverted)", delay = 50) => {
  const ex = Object.create(Executor.prototype); ex.p1 = { wouldSucceed: 0, projectedNetUsd: 0, gasUsdSimulated: 0, simulated: 0, recent: [], byPair: {} };
  ex.calls = []; ex.inflightMax = 0; let inflight = 0;
  ex.simulate = async (plan, block, ts, gas, ethUsd, mode) => {
    ex.calls.push({ amount: plan.amount, mode }); inflight++; ex.inflightMax = Math.max(ex.inflightMax, inflight);
    await new Promise((r) => setTimeout(r, delay)); inflight--;
    const good = okFrom !== null && plan.amount <= okFrom;
    const rec = { route: "A → B → A", ok: good, reason: good ? null : reason, netUsd: 1, gasUsd: 0.01, amountUsd: Number(plan.amount) };
    if (!good && mode !== true) rec.tentative = true;
    if (good && mode !== "quiet") ex.countLadderOk(rec);
    return rec;
  };
  return ex;
};
const plan0 = { amount: 3200n }, r = { amountIn: 3200n, amountInUsd: 3200 };
delete process.env.LADDER_PARALLEL;
let ex = mk(800n), t0 = Date.now();
let { plan, rec } = await ex.ladderSim(plan0, r, 1, 0, {}, 1, null);
const ms = Date.now() - t0;
ok(rec.ok && plan.amount === 800n && rec.sizeDiv === 4, "elige el mayor monto válido (÷4)");
ok(ex.inflightMax === 6 && ms < 140, `los 6 escalones en paralelo (${ms} ms, secuencial serían ≥300)`);
ok(ex.p1.wouldSucceed === 1 && ex.p1.simulated === 1, "solo el elegido se contabiliza");
ex = mk(null);
({ plan, rec } = await ex.ladderSim(plan0, r, 1, 0, {}, 1, null));
ok(!rec.ok && plan.amount === 100n && ex.calls.at(-1).mode === true, "todos fallan: diagnóstico completo en ÷32");
ex = mk(null, "Error(Pancake: K)");
({ plan, rec } = await ex.ladderSim(plan0, r, 1, 0, {}, 1, null));
ok(!rec.ok && plan.amount === 3200n && ex.calls.at(-1).mode === true, "motivo sin escalera: diagnóstico en ÷1");
process.env.LADDER_PARALLEL = "0";
ex = mk(800n);
({ plan, rec } = await ex.ladderSim(plan0, r, 1, 0, {}, 1, null));
ok(rec.ok && plan.amount === 800n && ex.inflightMax === 1 && ex.calls.length === 3 && ex.p1.wouldSucceed === 1, "LADDER_PARALLEL=0: secuencial como antes");
console.log("test_ladder OK");
