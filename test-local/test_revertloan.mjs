// Pruebas de las funciones puras de server/revertloan.mjs y de la decisión de desapalancar con un vault/pool simulados.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { priceFromSqrt, rangeTicks, borrowable, repayFor, health, amountsFor, needsRecenter, rebalanceSwap, RevertLoan, RVL } from "../server/revertloan.mjs";

// precio desde sqrtPriceX96 (tick −199721 ≈ $2,121.7 del pool real WETH-USDC 0.3 %)
const sq = BigInt(Math.floor(Math.sqrt(1.0001 ** -199721) * 2 ** 96));
assert.ok(Math.abs(priceFromSqrt(sq) - 2121.7) < 1, `precio ${priceFromSqrt(sq)}`);

// rango ±10 %: ~953 ticks a cada lado, alineado a 60
const r = rangeTicks(-199721, 10);
assert.ok(r.lower % 60 === 0 && r.upper % 60 === 0);
assert.ok(r.lower <= -199721 - 953 && r.lower > -199721 - 953 - 60, `lower ${r.lower}`);
assert.ok(r.upper >= -199721 + 953 && r.upper < -199721 + 953 + 60, `upper ${r.upper}`);

// préstamo máximo: colateral $23.25 (=$30 × 77.5 %) → ≤ 95 % = $22.0875 menos margen 0.3 %
const col = 23_250_000n;
const b = borrowable(col, 0n);
assert.ok(b <= 22_087_500n && b >= 22_020_000n, `borrowable ${b}`);
assert.equal(borrowable(col, 22_087_500n), 0n);
assert.ok(borrowable(col, 0n, 0.5) < 11_100_000n);

// salud y repago para volver al objetivo
assert.ok(Math.abs(health(col, 22_087_500n) - 1 / 0.95) < 1e-6);
const rep = repayFor(22_000_000n, 22_000_000n, 1.06); // salud 1.0 → 1.06
assert.ok(Math.abs(Number(22_000_000n - rep) * 1.06 - 22_000_000) < 2, `repay ${rep}`);
assert.equal(repayFor(30_000_000n, 10_000_000n, 1.06), 0n);

// monitor: salud 1.01 con USDC suficiente → approve + repay; salud alta → nada
function fakeEnv({ debt, coll, usdc }) {
  const sent = [];
  const iface = new ethers.Interface(["function loanInfo(uint256) view returns (uint256,uint256,uint256,uint256,uint256)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"]);
  const provider = {
    async call(tx) {
      const sel = tx.data.slice(0, 10);
      if (sel === iface.getFunction("loanInfo").selector) return iface.encodeFunctionResult("loanInfo", [debt, coll * 100n / 77n, coll, 0n, 0n]);
      if (sel === iface.getFunction("slot0").selector) return iface.encodeFunctionResult("slot0", [sq, -199721, 0, 0, 0, 0, true]);
      if (sel === iface.getFunction("balanceOf").selector) return iface.encodeFunctionResult("balanceOf", [usdc]);
      if (sel === iface.getFunction("allowance").selector) return iface.encodeFunctionResult("allowance", [0n]);
      if (sel === iface.getFunction("positions").selector) return iface.encodeFunctionResult("positions", [0, ethers.ZeroAddress, RVL.WETH, RVL.USDC, 3000, -200700, -198720, 1n, 0n, 0n, 0n, 0n]);
      return "0x";
    },
    async estimateGas() { return 100_000n; }, async getBalance() { return ethers.parseEther("0.05"); }, async getFeeData() { return { maxFeePerGas: 10_000_000n }; },
    async waitForTransaction(h) { return { status: 1, blockNumber: 1, logs: [] }; },
  };
  const executor = { mode: "live", wallet: { address: "0x327526EC22821c0667d4A02FaEe50794281b965d" }, withSender: async (fn) => fn({ sendTransaction: async (t) => { sent.push(t); return { hash: "0x" + String(sent.length).padStart(64, "0") }; } }) };
  const store = { m: new Map(), async get(k) { return this.m.get(k) ?? null; }, async set(k, v) { this.m.set(k, v); } };
  return { sent, provider, executor, store };
}
{
  const env = fakeEnv({ debt: 22_000_000n, coll: 22_220_000n, usdc: 22_000_000n }); // salud 1.01
  const rl = new RevertLoan({ executor: env.executor, provider: env.provider, store: env.store, diag: async () => {} });
  await rl.init(); rl.s.tokenId = "1"; await rl.monitor();
  assert.equal(env.sent.length, 2, "approve + repay");
  assert.equal(env.sent[1].to, RVL.VAULT);
  assert.equal(rl.s.actions, 1);
}
{
  const env = fakeEnv({ debt: 20_000_000n, coll: 22_220_000n, usdc: 22_000_000n }); // salud 1.111
  const rl = new RevertLoan({ executor: env.executor, provider: env.provider, store: env.store, diag: async () => {} });
  await rl.init(); rl.s.tokenId = "1"; await rl.monitor();
  assert.equal(env.sent.length, 0, "sin acción");
  assert.ok(rl.line().includes("salud 1.11"));
}
// re-centrado: dentro del 80 % central no; cerca del borde o fuera, sí
assert.equal(needsRecenter(-199721, -200700, -198720), false);
assert.equal(needsRecenter(-198850, -200700, -198720), true);
assert.equal(needsRecenter(-198700, -200700, -198720), true);
assert.equal(needsRecenter(-200800, -200700, -198720), true);
// cantidades: en el centro del rango, ~50/50 en valor; fuera por arriba (precio de token0 alto), todo en token1
{
  const s = Math.sqrt(1.0001 ** -199710);
  const a = amountsFor(1e15, s, -200700, -198720), P = s * s;
  const share0 = a.a0 * P / (a.a0 * P + a.a1);
  assert.ok(share0 > 0.4 && share0 < 0.6, `reparto ${share0}`);
  const up = amountsFor(1e15, Math.sqrt(1.0001 ** -198000), -200700, -198720);
  assert.ok(up.a0 === 0 && up.a1 > 0);
}
// reequilibrio: posición quedada toda en USDC (precio subió) → comprar WETH por ~la mitad del valor
{
  const s = Math.sqrt(1.0001 ** -198000), P = s * s; // ETH ≈ $2,580
  const sw = rebalanceSwap(0, 30e6, s, ...Object.values(rangeTicks(-198000, 10)));
  assert.equal(sw.sellToken0, false);
  assert.ok(Number(sw.amountIn) > 13e6 && Number(sw.amountIn) < 17e6, `usdc in ${sw.amountIn}`);
  assert.ok(Number(sw.minOut) > 0);
  // ya balanceada → swap casi nulo
  const r = rangeTicks(-198000, 10), a = amountsFor(1e15, s, r.lower, r.upper);
  const sw2 = rebalanceSwap(a.a0, a.a1, s, r.lower, r.upper);
  assert.ok(Number(sw2.amountIn) / (a.a1 + a.a0 * P) < 0.01, "sin swap si ya está balanceada");
}
console.log("test_revertloan: ok");
