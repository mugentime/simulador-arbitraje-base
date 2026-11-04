// Tope por hora, presupuesto de reverts y racha: sobreviven a un redeploy (viven en p1, que se guarda en el volumen).
import { Executor, seedRevertGas } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const store = new Map();
const mk = async () => { const ex = Object.create(Executor.prototype); ex.store = { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null), set: async (k, v) => { store.set(k, JSON.stringify(v)); } }; ex.p1 = (await ex.store.get("phase1")) ?? { recent: [] }; return ex; };
let ex = await mk();
const now = Date.now();
ex.sentTimes.push(now - 1000); ex.revertGas.push({ t: now - 1000, usd: 0.25 }); ex.consecutiveReverts++; ex.consecutiveReverts++;
await ex.save();
ex = await mk(); // "redeploy"
ok(ex.sentTimes.length === 1, "tope por hora persiste");
ok(ex.revertGas.reduce((a, x) => a + x.usd, 0) === 0.25, "gas perdido en la hora persiste");
ok(ex.consecutiveReverts === 2, "racha de reverts persiste");
const recent = [{ ts: Math.floor(now / 1000) - 600, sent: "0xabc · revertida (gas $0.2540)" }, { ts: Math.floor(now / 1000) - 7200, sent: "0xdef · revertida (gas $0.1)" }, { ts: Math.floor(now / 1000), sent: "omitida: tope por hora" }];
const seed = seedRevertGas(recent, now);
ok(seed.length === 1 && seed[0].usd === 0.254, "semilla: solo reverts de la última hora");
const ex2 = Object.create(Executor.prototype);
ok(Array.isArray(ex2.sentTimes) && ex2.consecutiveReverts === 0, "sin estado cargado no falla");
console.log("test_budget_persist OK");
