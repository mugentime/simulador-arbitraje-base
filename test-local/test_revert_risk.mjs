// Un envío con gas solo sale si lo que perdería al revertir (gas completo con la propina) cabe en el presupuesto que queda en la hora.
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const mk = (spent) => {
  const ex = Object.create(Executor.prototype);
  ex.p1 = { pending: [], sent: 0, recent: [], revertGas: spent ? [{ t: Date.now() - 1000, usd: spent }] : [] };
  ex.limits = { maxTxPerHour: 5, maxGasUsd: 1, minSendNetUsd: 0.01, revertBudgetUsdPerHour: 0.25, tipShare: 0.6, maxTipGwei: 2, bundleSend: false };
  ex.iface = { encodeFunctionData: () => "0x" }; ex.encodeWithCost = () => "0x"; ex.save = async () => {}; ex.diag = async () => {};
  ex.sendUrl = "https://rpc.test"; ex.sent = 0; ex.withSender = async () => { ex.sent++; return { hash: "0xhash", nonce: 1 }; };
  return ex;
};
const plan = { source: 0, lender: "0x0", token: "0x0", amount: 1n, minProfit: 0n, hops: [], meta: { startTok: { sym: "WETH", decimals: 18 } } };
const gas = { baseFee: 5_000_000n, priority: 1_000_000n, l1Fee: 0n }, ethUsd = 3500;
// neto $0.25 con gas $0.01 → propina 60 % ≈ $0.15 sobre 800k gas → si revierte pierde ≈ $0.16
let ex = mk(0.2), rec = { route: "A", netUsd: 0.25, gasUsd: 0.01, gasEst: 800000 };
await ex.send(plan, rec, gas, ethUsd);
ok(ex.sent === 0 && /si revierte perdería/.test(rec.sent), `con $0.20 ya gastados no se arriesga ≈$0.065 (propina ya limitada por EV) (${rec.sent})`);
ex = mk(0); rec = { route: "A", netUsd: 0.25, gasUsd: 0.01, gasEst: 800000 };
await ex.send(plan, rec, gas, ethUsd);
ok(ex.sent === 1 && rec.sent === "0xhash", `sin gasto previo sí se envía (${rec.sent})`);
// caso real 23:08 UTC (Base): neto $0.34, propina 60 % → arriesgaba $0.20 para ganar $0.14. Ahora la propina se limita
// para que neto tras propina ≥ 3× pérdida si revierte.
ex = mk(0); rec = { route: "B", netUsd: 0.34, gasUsd: 0.005, gasEst: 400000 };
let tipGwei = 0; ex.withSender = async (fn) => { const w = { sendTransaction: async (tx) => { tipGwei = Number(tx.maxPriorityFeePerGas) / 1e9; return { hash: "0xh2", nonce: 2 }; } }; ex.sent++; return fn(w); };
await ex.send(plan, rec, gas, ethUsd);
const riskUsd = (Number((gas.baseFee + BigInt(Math.round(tipGwei * 1e9))) * 400000n) / 1e18) * ethUsd;
ok(ex.sent === 1 && rec.netUsd >= 3 * riskUsd * 0.999, `propina limitada ${tipGwei.toFixed(4)} gwei: neto $${rec.netUsd.toFixed(4)} ≥ 3× riesgo $${riskUsd.toFixed(4)}`);
// neto apenas mayor que 3× gas: sin margen para propina → sale con la mínima
ex = mk(0); rec = { route: "C", netUsd: 0.016, gasUsd: 0.005, gasEst: 400000 };
await ex.send(plan, rec, gas, ethUsd);
ok(/omitida: neto tras propina|0xhash/.test(rec.sent), `neto justo: ${rec.sent}`);
console.log("test_revert_risk OK");
