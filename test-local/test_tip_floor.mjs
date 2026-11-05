// Polygon: la propina nunca baja del piso de la cadena (25 gwei) ni de la de mercado, aunque MAX_TIP_GWEI sea 2.
// Caso real 2026-11-05 15:29 UTC: "gas tip cap 2000000000, minimum needed 25000000000".
import * as core from "../src/core.js";
import { CHAINS } from "../src/chains.js";
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
core.applyChain(CHAINS.polygon);
ok(core.priorityFloor(0n) === 25_000_000_000n, "eth_maxPriorityFeePerGas falla (0) → piso 25 gwei");
ok(core.priorityFloor(30_000_000_000n) === 30_000_000_000n, "mercado 30 gwei se respeta");
const ex = Object.create(Executor.prototype);
ex.p1 = { pending: [], sent: 0, recent: [], revertGas: [] };
ex.limits = { maxTxPerHour: 3, maxGasUsd: 1, minSendNetUsd: 0.01, revertBudgetUsdPerHour: 0.10, tipShare: 0.6, maxTipGwei: 2, bundleSend: false };
ex.iface = { encodeFunctionData: () => "0x" }; ex.encodeWithCost = () => "0x"; ex.save = async () => {}; ex.diag = async () => {};
ex.provider = { getTransactionCount: async () => 14 }; ex.wallet = { address: "0x0" };
ex.sendUrl = "https://rpc.test";
let tip = 0n, nonce;
ex.withSender = async (fn) => fn({ sendTransaction: async (tx) => { tip = tx.maxPriorityFeePerGas; nonce = tx.nonce; return { hash: "0xh", nonce: tx.nonce }; } });
const plan = { source: 0, lender: "0x0", token: "0x0", amount: 1n, minProfit: 0n, hops: [], meta: { startTok: { sym: "WETH", decimals: 18 } } };
const gas = { baseFee: 30_000_000_000n, priority: core.priorityFloor(0n), l1Fee: 0n }, polUsd = 0.17;
const rec = { route: "R", netUsd: 1.45, gasUsd: 0.02, gasEst: 400000 };
await ex.send(plan, rec, gas, polUsd);
ok(rec.sent === "0xh", `enviada (${rec.sent})`);
ok(tip >= 25_000_000_000n && tip <= 27_000_000_000n, `propina ${Number(tip) / 1e9} gwei ∈ [25, 27]`);
ok(nonce === 14, "nonce desde latest");
console.log("test_tip_floor OK");
