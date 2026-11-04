// Back-run público: la comisión debe igualar la propina efectiva de la víctima (no superarla).
import assert from "node:assert/strict";
import { backrunFee } from "../server/executor.mjs";
const g = (x) => BigInt(Math.round(x * 1e9));
// víctima EIP-1559 (JSON crudo de eth_getTransactionByHash: hex; gasPrice = maxFee en pendientes)
const v2 = { type: "0x2", gasPrice: "0x" + g(842).toString(16), maxFeePerGas: "0x" + g(842).toString(16), maxPriorityFeePerGas: "0x" + g(30).toString(16) };
const base = g(100);
const f = backrunFee(v2, base);
assert.equal(f.fee.maxPriorityFeePerGas, g(30));
assert.equal(f.fee.maxFeePerGas, g(842));
assert.equal(f.effective, g(130)); // base + propina, no 842
// lo que hacía antes: legacy a 842 → propina efectiva 742 gwei > 30 de la víctima (quedábamos antes que ella)
assert.ok(g(842) - base > f.effective - base);
// maxFee limita la propina
const tight = backrunFee({ maxFeePerGas: g(110), maxPriorityFeePerGas: g(30) }, base);
assert.equal(tight.effective, g(110));
// legacy
const l = backrunFee({ type: "0x0", gasPrice: "0x" + g(200).toString(16) }, base);
assert.deepEqual(l.fee, { gasPrice: g(200), type: 0 });
assert.equal(backrunFee({ maxFeePerGas: g(50), maxPriorityFeePerGas: g(1) }, base), null); // maxFee < base: no se incluiría
assert.equal(backrunFee({}, base), null);
console.log("test_backrun_fee OK");
