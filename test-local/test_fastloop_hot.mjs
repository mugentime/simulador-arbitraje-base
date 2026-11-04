// Prueba: el bucle rápido solo lee pools que están en algún ciclo y pide todos los tramos del multicall a la vez.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import * as core from "../src/core.js";
import { FastLoop } from "../server/fastloop.mjs";
const iface = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"]);
const mk = (i) => ({ address: ethers.getAddress("0x" + (i + 1).toString(16).padStart(40, "0")), kind: "v2", reserve0: 1n, reserve1: 1n });
const pools = Array.from({ length: 700 }, (_, i) => mk(i));
// 450 pools en ciclos, 250 fuera
const cycles = []; for (let i = 0; i < 450; i += 3) cycles.push({ route: [pools[i], pools[i + 1], pools[i + 2]] });
let inFlight = 0, maxInFlight = 0, targets = [];
const provider = { call: async ({ data }) => {
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  const [calls] = iface.decodeFunctionData("aggregate3", data);
  for (const c of calls) targets.push(c.target);
  await new Promise((r) => setTimeout(r, 20)); inFlight--;
  const word = (n) => n.toString(16).padStart(64, "0");
  return iface.encodeFunctionResult("aggregate3", [calls.map(() => ({ success: true, returnData: "0x" + word(5n) + word(7n) + word(0n) }))]);
} };
const fl = new FastLoop({ url: null, executor: { onBlock: async () => null }, diag: async () => {}, provider, intervalMs: 10_000 });
fl.setUniverse(pools, cycles);
assert.equal(fl.f.hotPools, 450); assert.equal(fl.f.totalPools, 700);
fl.setContext({ gas: { gasPrice: 1n }, ethUsd: 3000, lenders: [] });
fl.start();
await new Promise((r) => setTimeout(r, 300)); fl.stop();
assert.ok(fl.f.reads >= 1, "al menos una lectura");
const set = new Set(targets);
assert.equal(set.size, 450, "solo pools de ciclos");
assert.ok(!set.has(pools[600].address));
assert.equal(maxInFlight, 3, "3 tramos de 200 en paralelo (1 ida y vuelta)");
assert.equal(fl.pools[0].reserve0, 5n); assert.equal(fl.pools[600].reserve0, 1n);
assert.ok(fl.f.changedPools >= 450);
console.log("test_fastloop_hot OK", { reads: fl.f.reads, readMs: fl.f.readMs, maxInFlight });
process.exit(0);
