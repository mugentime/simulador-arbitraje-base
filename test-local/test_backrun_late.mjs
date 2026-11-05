// Prueba: (1) el back-run público no se envía si la víctima ya está minada; (2) quote() cotiza saltos repartidos (split).
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const ex = Object.create(Executor.prototype);
ex.p1 = {}; let built = 0;
ex.buildPlan = () => { built++; return null; };
// víctima con blockNumber (ya minada al recibirla)
let r = await ex.sendBackrunPublic({ hash: "0xaa", blockNumber: "0x10" }, {}, [], {}, 1);
ok(/ya minada/.test(r) && built === 0 && ex.p1.backrunLate === 1, `víctima con blockNumber → "${r}"`);
// víctima pendiente en la tx, pero el recibo ya existe al enviar
ex.provider = { getTransactionReceipt: async () => ({ blockNumber: 123 }) };
r = await ex.sendBackrunPublic({ hash: "0xbb", blockNumber: null }, {}, [], {}, 1);
ok(/bloque 123/.test(r) && built === 0 && ex.p1.backrunLate === 2, `recibo existente → "${r}"`);
// víctima pendiente de verdad: sigue al plan (buildPlan se llama)
ex.provider = { getTransactionReceipt: async () => null };
r = await ex.sendBackrunPublic({ hash: "0xcc", blockNumber: null }, {}, [], {}, 1);
ok(built === 1 && r === null, "víctima pendiente → se construye el plan como antes");
// error de red al pedir el recibo: no bloquea
ex.provider = { getTransactionReceipt: async () => { throw new Error("red"); } };
r = await ex.sendBackrunPublic({ hash: "0xdd" }, {}, [], {}, 1);
ok(built === 2, "error de red en el recibo → se sigue");
// (2) split: suma de partes con la misma asignación que el contrato
const calls = [];
const orig = Executor.prototype.quote;
ex.quote = async function (p, tokenIn, a, sp, tag) { if (p.kind === "split") return orig.call(this, p, tokenIn, a, sp, tag); calls.push([p.id, a]); return a * 2n; };
const out = await ex.quote({ kind: "split", parts: [{ id: "A" }, { id: "B" }], bps: [8000, 2000] }, "0x1", 1001n);
ok(out === 2002n && calls[0][1] === 800n && calls[1][1] === 201n, `split 80/20 de 1001 → partes ${calls.map((c) => c[1]).join("/")}, salida ${out}`);
console.log("OK test_backrun_late");
