// Prueba: límite de direcciones en eth_getLogs (publicnode BSC) → un bloque sin filtro de dirección, rangos troceados.
import assert from "node:assert/strict";
import { addrCapFromError, callCapped } from "../server/logcap.mjs";
const err = Object.assign(new Error("server response 403 Forbidden"), { info: { responseBody: '{"error":{"code":-32602,"message":"A maximum of 10 addresses is allowed. N"}}' } });
assert.equal(addrCapFromError(err), 10);
assert.equal(addrCapFromError(new Error("timeout 6 s")), 0);
const addrs = Array.from({ length: 25 }, (_, i) => "0x" + String(i + 1).padStart(40, "0"));
const all = addrs.map((a) => ({ address: a })).concat([{ address: "0x" + "f".repeat(40) }]);
const calls = [];
const call = async (f) => { calls.push(f); if (Array.isArray(f.address) && f.address.length > 10) throw err; return f.address ? all.filter((l) => f.address.includes(l.address)) : all; };
let r = await callCapped(call, { address: addrs, fromBlock: 5, toBlock: 5 }, 10);
assert.equal(r.length, 25); assert.equal(calls.length, 1); assert.equal(calls[0].address, undefined);
calls.length = 0;
r = await callCapped(call, { address: addrs, fromBlock: 5, toBlock: 9 }, 10);
assert.equal(r.length, 25); assert.equal(calls.length, 3);
calls.length = 0;
r = await callCapped(call, { address: addrs.slice(0, 3), fromBlock: 5, toBlock: 5 }, 10);
assert.equal(r.length, 3); assert.equal(calls.length, 1);
console.log("test_logcap OK");
