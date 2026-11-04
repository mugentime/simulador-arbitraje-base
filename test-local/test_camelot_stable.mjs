// Prueba local: los pares estables de un fork v2 con `stableFlag` (Camelot stableSwap()) se descartan al cargar pools.
import assert from "node:assert";
import { ethers } from "ethers";
import * as core from "../src/core.js";

const iface = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"]);
const A = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", B = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const STABLE = "0x1111111111111111111111111111111111111111", VOLATILE = "0x2222222222222222222222222222222222222222";
const sel = (sig) => ethers.id(sig).slice(0, 10);
const abi = ethers.AbiCoder.defaultAbiCoder();
const answer = (target, data) => {
  const s = data.slice(0, 10);
  if (s === sel("token0()")) return abi.encode(["address"], [A]);
  if (s === sel("token1()")) return abi.encode(["address"], [B]);
  if (s === sel("getReserves()")) return abi.encode(["uint112", "uint112", "uint32"], [10n ** 21n, 3n * 10n ** 12n, 0]);
  if (s === sel("stableSwap()")) return abi.encode(["bool"], [target.toLowerCase() === STABLE.toLowerCase()]);
  return null;
};
const provider = {
  async call({ data }) {
    const [calls] = iface.decodeFunctionData("aggregate3", data);
    return iface.encodeFunctionResult("aggregate3", [calls.map((c) => { const r = answer(c.target, c.callData); return [r !== null, r ?? "0x"]; })]);
  },
};
const tokens = new Map([[A.toLowerCase(), { sym: "WETH", address: A, decimals: 18 }], [B.toLowerCase(), { sym: "USDC", address: B, decimals: 6 }]]);
const spec = { dex: "Camelot v2", kind: "v2", feeBps: 30, stableFlag: "stableSwap" };
const pools = await core.loadPools(ethers, provider, new Map([[STABLE, spec], [VOLATILE, spec]]), tokens);
assert.deepStrictEqual(pools.map((p) => p.address), [VOLATILE]);
const plain = await core.loadPools(ethers, provider, new Map([[STABLE, { ...spec, stableFlag: undefined }]]), tokens);
assert.strictEqual(plain.length, 1, "sin stableFlag no se consulta ni se descarta");
console.log("OK test_camelot_stable");
