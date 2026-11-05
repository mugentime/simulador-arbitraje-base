// destinos no decodificados del mempool: selectores por destino y línea con direcciones completas
import assert from "node:assert";
import { noteUnknownSelector, unknownDestLine, MempoolWatcher } from "../server/mempool.mjs";

const m = { unknownTo: {} };
const A = "0xdcffeb0c00000000000000000000000000000001", B = "0x4008a35300000000000000000000000000000002";
for (let i = 0; i < 5; i++) { m.unknownTo[A] = (m.unknownTo[A] ?? 0) + 1; noteUnknownSelector(m, A, "0x12345678" + "00".repeat(96)); }
m.unknownTo[A]++; noteUnknownSelector(m, A, "0xabcdef01" + "00".repeat(96));
m.unknownTo[B] = 2; noteUnknownSelector(m, B, "0xDEADBEEF" + "00"); noteUnknownSelector(m, B, "0xdeadbeef");
const line = unknownDestLine(m);
assert.ok(line.includes(`${A} 6 [0x12345678×5 0xabcdef01×1]`), line);
assert.ok(line.includes(`${B} 2 [0xdeadbeef×2]`), line);
assert.ok(line.indexOf(A) < line.indexOf(B), "orden por frecuencia");
assert.equal(unknownDestLine({}), null);
// poda de selectores raros cuando hay más de 12
const m2 = {}; for (let i = 0; i < 13; i++) noteUnknownSelector(m2, A, "0x" + i.toString(16).padStart(8, "0"));
assert.ok(Object.keys(m2.unknownSel[A]).length <= 12);

// ritmo: una línea cada UNKNOWN_LOG_MS
const logs = []; const w = Object.create(MempoolWatcher.prototype);
w.m = m; w.diag = async (s) => logs.push(s);
assert.ok(w.maybeLogUnknown(10_000_000)); assert.equal(w.maybeLogUnknown(10_000_000 + 60_000), null);
assert.ok(w.maybeLogUnknown(10_000_000 + 1_800_001));
await new Promise((r) => setTimeout(r, 5));
assert.equal(logs.length, 2); assert.ok(logs[0].startsWith("mempool: destinos no decodificados (completos): "));
console.log("test_unknown_dest OK");
