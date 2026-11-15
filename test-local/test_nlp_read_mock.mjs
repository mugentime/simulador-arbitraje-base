// read() de las dos posiciones contra un proveedor simulado: capital a precio del pool, comisiones, bloque histórico
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { NeutralLp, lpAtPool, baseResult, baseText } from "../server/neutrallp.mjs";
import { NeutralLp2 } from "../server/neutrallp2.mjs";

const I = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function balanceOf(address) view returns (uint256)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)",
  "function loanInfo(uint256) view returns (uint256 debt, uint256 fullValue, uint256 collateralValue, uint256 liquidationCost, uint256 liquidationValue)",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function borrowBalanceOf(address) view returns (uint256)",
  "function collateralBalanceOf(address,address) view returns (uint128)",
]);
const ETH = 1749, BTC = 63693, px = ETH / BTC / 1e10, sq = (v) => BigInt(Math.floor(Math.sqrt(v) * 2 ** 96));
const tick = Math.floor(Math.log(px) / Math.log(1.0001));
const seen = [];
const provider = {
  async call(tx) {
    seen.push(tx.blockTag ?? "latest");
    const f = I.parseTransaction({ data: tx.data }), n = f.name;
    const ethPool = tx.to.toLowerCase() !== "0x7aea2e8a3843516afa07293a10ac8e49906dabd1";
    if (n === "slot0") return I.encodeFunctionResult(n, ethPool ? [sq(ETH / 1e12), 0, 0, 0, 0, 0, true] : [sq(px), tick, 0, 0, 0, 0, true]);
    if (n === "loanInfo") return I.encodeFunctionResult(n, [55_960_000n, 76_670_000n, 59_420_000n, 0n, 0n]);
    if (n === "positions") return I.encodeFunctionResult(n, [0, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 500, tick - 200, tick + 200, 3_885_176_271_202n, 0, 0, 0, 0]);
    if (n === "collect") return I.encodeFunctionResult(n, [95_247_121_682_733n, 242n]);
    if (n === "collateralBalanceOf") return I.encodeFunctionResult(n, [105_920_000n]);
    if (n === "borrowBalanceOf") return I.encodeFunctionResult(n, [43_204_000_000_000_000n]);
    if (n === "balanceOf") return I.encodeFunctionResult(n, [1_000_000n]);
    if (n === "getUserAccountData") return I.encodeFunctionResult(n, [10_963_000_000n, 8_185_000_000n, 0n, 8500n, 8000n, 1_139_000_000_000_000_000n]);
    throw new Error(`sin simulación para ${n}`);
  },
};
const store = { get: async () => null, set: async () => {} };
const v1 = new NeutralLp({ store, diag: async () => {}, provider }); await v1.init(); v1.s.manager = "0xf79f6aD18035379C2ee3e94c0Fec9d955014B571";
const r1 = await v1.read("6543760");
const fee = 95247121682733 / 1e18 * ETH + 242 / 1e8 * BTC;
assert.ok(Math.abs(r1.feesUsd - fee) < 1e-3, `fees ${r1.feesUsd}`);
assert.ok(Math.abs(r1.lpValue - (lpAtPool(r1.am, [95247121682733n, 242n], r1.pr).value)) < 1e-9);
assert.ok(Math.abs(r1.equity - (r1.lpValue - 55.96 + 105.92 - 0.043204 * ETH)) < 0.01, `equity ${r1.equity}`);
assert.ok(Math.abs(r1.equityRevert - (76.67 - 55.96 + 105.92 - 0.043204 * ETH)) < 0.01);
assert.equal(r1.h.revert.toFixed(3), (59.42 / 55.96).toFixed(3)); // saludes: siguen con los números de Revert
seen.length = 0; await v1.read("6543760", 57022070); assert.ok(seen.every((b) => b === 57022070), `bloques ${seen}`);

const v2 = new NeutralLp2({ store, diag: async () => {}, provider, peer: v1 }); v2._p = provider; await v2.init(); v2.s.manager = "0xDEe55FC14550514A73CBB184DDda09f1c19E8926";
const r2 = await v2.read("6587053");
assert.ok(Math.abs(r2.equity - (r2.lpValue - 55.96 + 1 - r2.debtUsd)) < 0.01);
seen.length = 0; await v2.read("6565243", 57022070); assert.ok(seen.every((b) => b === 57022070), `bloques ${seen}`);
// si falla la lectura de comisiones, cae al valor de Revert (que ya las incluye) en vez de subestimar
const bad = { async call(tx) { if (I.parseTransaction({ data: tx.data }).name === "collect") throw new Error("x"); return provider.call(tx); } };
const r3 = await v1.read("6543760", undefined, bad); assert.equal(r3.feesUsd, null); assert.equal(r3.lpValue, 76.67);

// resultado desde el inicio común
const base = { equity: 49.80, feesTotal: 0.367 };
const b = baseResult({ equity: 51.04, total: 0.772 }, base);
assert.ok(Math.abs(b.total - 1.24) < 1e-9 && Math.abs(b.fees - 0.405) < 1e-9 && Math.abs(b.price - 0.835) < 1e-9);
assert.equal(baseText({ equity: 49.60, fees: 0.37 }, { equity: 49.95, feesTotal: 0 }), " · desde el inicio común (base $49.95): resultado −$0.35 = comisiones +$0.37 + precio −$0.72");
assert.equal(baseText({ equity: 1 }, null), "");
console.log("test_nlp_read_mock: ok", { capital1: r1.equity.toFixed(3), revert1: r1.equityRevert.toFixed(3), capital2: r2.equity.toFixed(3) });
