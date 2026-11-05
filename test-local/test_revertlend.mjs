// Revert Lend: tasas Q64, resumen de préstamo y flujo con nodo simulado (descubre préstamos por eventos, mide salud,
// registra una liquidación ajena y anuncia el préstamo liquidable).
import { ethers } from "ethers";
import * as core from "../src/core.js";
import { chainByKey } from "../src/chains.js";
import { RevertLend, ratesFromX64, loanSummary, REVERT_VAULTS } from "../server/revertlend.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const Q64 = 2n ** 64n;

const r = ratesFromX64(BigInt(Math.round(0.05 / 31_536_000 * 2 ** 64)), BigInt(Math.round(0.03 / 31_536_000 * 2 ** 64)));
ok(Math.abs(r.borrowApr - 0.05) < 1e-9 && Math.abs(r.supplyApr - 0.03) < 1e-9, "tasas Q64 → 5 % / 3 %");
const s = loanSummary({ debt: 1000_000000n, fullValue: 1300_000000n, collateralValue: 990_000000n, liquidationCost: 1000_000000n, liquidationValue: 1050_000000n }, 6, { exitCostBps: 10, gasUsd: 0.03 });
ok(s.liquidatable && Math.abs(s.estProfitUsd - (50 - 1.05 - 0.03)) < 1e-9, `liquidable: neto $${s.estProfitUsd.toFixed(2)}`);
ok(!loanSummary({ debt: 1n, fullValue: 2n, collateralValue: 2n, liquidationCost: 0n, liquidationValue: 0n }, 6).liquidatable, "sano → no liquidable");

core.applyChain(chainByKey("arbitrum"));
const V = REVERT_VAULTS.arbitrum[0];
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const I = new ethers.Interface([
  "function asset() view returns (address)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function vaultInfo() view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function loanInfo(uint256) view returns (uint256,uint256,uint256,uint256,uint256)",
  "function getRatesPerSecondX64(uint256,uint256) view returns (uint256,uint256)",
  "event Add(uint256 indexed tokenId, address owner, uint256 oldTokenId)",
  "event Borrow(uint256 indexed tokenId, address owner, uint256 assets, uint256 shares)",
  "event Liquidate(uint256 indexed tokenId, address liquidator, address owner, uint256 value, uint256 cost, uint256 amount0, uint256 amount1, uint256 reserve, uint256 missing)",
]);
const M3 = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"]);
const loans = { 1: [500_000000n, 800_000000n, 640_000000n, 0n, 0n], 2: [1000_000000n, 1100_000000n, 990_000000n, 1000_000000n, 1050_000000n], 3: [0n, 0n, 0n, 0n, 0n] };
function answer(to, data) {
  const f = I.parseTransaction({ data }); const t = to.toLowerCase(); const r = (v) => I.encodeFunctionResult(f.name, v);
  if (t === V.vault.toLowerCase()) {
    if (f.name === "asset") return r([USDC]);
    if (f.name === "vaultInfo") return r([1500_000000n, 3000_000000n, 1500_000000n, 10_000000n, 0n, 0n]);
    if (f.name === "loanInfo") return r(loans[Number(f.args[0])]);
  }
  if (t === USDC.toLowerCase()) { if (f.name === "decimals") return r([6]); if (f.name === "symbol") return r(["USDC"]); }
  if (t === V.irm.toLowerCase()) return r([Q64 / 1_000_000_000n, Q64 / 2_000_000_000n]);
  throw new Error("sin respuesta");
}
const provider = { async call({ to, data }) {
  const [calls] = M3.decodeFunctionData("aggregate3", data);
  return M3.encodeFunctionResult("aggregate3", [calls.map((c) => { try { return [true, answer(c.target, c.callData)]; } catch { return [false, "0x"]; } })]);
} };
const ev = (n, a, b) => ({ ...I.encodeEventLog(I.getEvent(n), a), blockNumber: b, transactionHash: "0x" + b.toString(16).padStart(64, "0") });
const logsProvider = { async getLogs({ fromBlock, toBlock }) {
  return [ev("Add", [1n, ethers.ZeroAddress, 0n], 990), ev("Borrow", [2n, ethers.ZeroAddress, 1n, 1n], 991), ev("Add", [3n, ethers.ZeroAddress, 0n], 992),
    ev("Liquidate", [7n, "0x4444444444444444444444444444444444444444", ethers.ZeroAddress, 120_000000n, 100_000000n, 0n, 0n, 0n, 0n], 995)].filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
} };
const mem = new Map(); const store = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => mem.set(k, JSON.parse(JSON.stringify(v))) };
const diags = [];
process.env.RVL_BACKFILL_BLOCKS = "50";
const rv = new RevertLend({ provider, logsProvider, store, diag: async (m) => diags.push(m) });
await rv.init();
await rv.onBlock({ block: 1000 });
const S = rv.s.vaults[V.vault];
ok(!rv.s.lastError, `sin error (${rv.s.lastError ?? "—"})`);
ok(S.assetSymbol === "USDC" && S.decimals === 6, "activo USDC/6");
ok(S.loans === 2 && rv.ids[V.vault].length === 2, `2 préstamos activos (el pagado se descarta): ${S.loans}`);
ok(S.liquidatable === 1 && S.candidates[0].tokenId === "2", "préstamo 2 liquidable");
ok(S.seenCount === 1 && Math.abs(S.seenProfitUsd - 20) < 1e-9, "liquidación ajena: ganó $20");
ok(Math.abs(S.utilization - 0.5) < 1e-9 && S.borrowApy > 0, `utilización 50 %, préstamo ${(S.borrowApy * 100).toFixed(2)} %`);
ok(diags.some((d) => d.includes("liquidable")) && rv.s.opportunities === 1, "episodio anunciado");
await rv.onBlock({ block: 1040 });
ok(rv.s.opportunities === 1, "sin doble conteo");
ok(/revert-lend: Uniswap v3: 2 préstamos/.test(rv.line()), rv.line().slice(0, 120));
process.exit(fails ? 1 : 0);
