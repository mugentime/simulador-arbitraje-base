// Prueba: víctimas de back-run que revierten o ya están minadas se descartan (BSC: 0xca293ee855… 4 veces rechazada).
import { MempoolWatcher } from "../server/mempool.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const w = Object.create(MempoolWatcher.prototype);
w.m = {}; w.badVictims = new Map();
const h = "0xca293ee855aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaedbd";
const rej = `rechazado (BlockRazor (tras víctima): -38000 transaction execution failed:[ · 48 Club (tras víctima): -32000 [0xca29..edbd] execution reverted · NodeReal (tras víctima): H)`;
ok(w.victimRejected(h, rej) === "revierte", "rechazo de 48 Club con el hash de la víctima → revierte");
ok(w.victimRejected(h, "rechazado (48 Club (tras víctima): -32000 [0xca29..edbd] nonce too low: address 0x…") === "ya minada", "nonce too low de la víctima → ya minada");
ok(w.victimRejected(h, "rechazado (48 Club: -32000 [0x598e..6dc4] execution reverted)") === null, "revert de OTRA tx (la nuestra) → no marca a la víctima");
ok(w.victimRejected(h, "bundle 0x12… enviado a 48 Club") === null, "bundle aceptado → nada");
w.markBadVictim(h, "revierte");
ok(w.isBadVictim(h.toUpperCase().replace("0X", "0x")) && w.m.badVictims.revierte === 1, "marcada y reconocida sin distinguir mayúsculas");
ok(!w.isBadVictim(h, Date.now() + 7 * 3600e3), "caduca a las 6 h");
// eth_call: revierte / no revierte / error de red
w.executor = { provider: { send: async () => { throw Object.assign(new Error("could not coalesce"), { info: { error: { message: "execution reverted: Pancake: EXPIRED" } } }); } } };
ok(await w.victimReverts({ from: "0x1", to: "0x2", input: "0x", value: 0n, gas: 300000n }) === true, "eth_call revierte → true");
let sent = null;
w.executor = { provider: { send: async (m, p) => { sent = p; return "0x"; } } };
ok(await w.victimReverts({ from: "0x1", to: "0x2", input: "0xabcd", value: 5n, gas: 21000n }) === false && sent[0].value === "0x5" && sent[0].gas === "0x5208" && sent[1] === "latest", "eth_call ok → false, con value y gas en hex");
w.executor = { provider: { send: async () => { throw new Error("ETIMEDOUT"); } } };
ok(await w.victimReverts({ from: "0x1", to: "0x2", input: "0x", value: 0n }) === null, "error de red → null (no se descarta)");
console.log("OK test_bad_victim");
