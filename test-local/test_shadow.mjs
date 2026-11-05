// Sombra: una sim ok no enviada se re-simula una vez en el bloque siguiente (sin gas) y se cuenta si seguía abierta.
import { ethers } from "ethers";
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const iface = new ethers.Interface(["function execute((uint8,address,address,uint256,uint256,(uint8,address,address,address,uint24,uint8)[]) p) returns (uint256)"]);
const fake = Object.create(Executor.prototype);
let calls = 0, mode = "open";
fake.iface = { encodeFunctionData: () => "0x", decodeFunctionResult: () => [2n * 10n ** 6n], parseError: () => null };
fake.provider = { call: async (tx) => { calls++; ok(typeof tx.blockTag === "number", "eth_call fija el bloque"); if (mode === "open") return "0x"; throw Object.assign(new Error("execution reverted"), { data: "0x" }); } };
fake.p1 = { executor: "0x" + "1".repeat(40), paused: true };
fake.wallet = { address: "0x" + "2".repeat(40) };
const plan = { source: 0, lender: "0x", token: "0x", amount: 1n, minProfit: 0n, hops: [], meta: { startTok: { sym: "USDC", decimals: 6 } } };
const tick = () => new Promise((r) => setTimeout(r, 5));
// 1) sim ok con envío omitido → se arma; en el bloque siguiente se comprueba: sigue abierta
fake.armShadow(plan, { ok: true, route: "A", gasUsd: 0.5, netUsd: 1, sent: "omitida: tope por hora" }, 100, 3000);
ok(!!fake.shadow, "sombra armada para envío omitido");
fake.checkShadow(100); ok(calls === 0, "no se comprueba en el mismo bloque");
fake.checkShadow(101); await tick();
ok(calls === 1 && fake.p1.shadow.alive === 1 && fake.p1.shadow.checked === 1, "seguía abierta en el bloque siguiente");
ok(Math.abs(fake.p1.shadow.aliveNetUsd - 1.5) < 1e-9, "neto = $2 bruto − $0.5 gas");
// 2) una enviada de verdad no se arma
fake.armShadow(plan, { ok: true, route: "B", gasUsd: 0.1, sent: "0xabc… enviada" }, 102, 3000);
ok(!fake.shadow, "envío real no arma sombra");
// 3) cerrada: revierte en el bloque siguiente
mode = "closed";
fake.armShadow(plan, { ok: true, route: "C", gasUsd: 0.1, sent: null }, 103, 3000);
fake.checkShadow(104); await tick();
ok(fake.p1.shadow.closed === 1 && fake.p1.shadow.checked === 2, "cerrada cuenta como cerrada");
// 4) demasiado tarde (> 3 bloques) → se descarta sin llamada
fake.armShadow(plan, { ok: true, route: "D", gasUsd: 0.1, sent: null }, 110, 3000);
fake.checkShadow(120); await tick();
ok(calls === 2 && !fake.shadow, "descartada si llega tarde");
// 5) SHADOW_CHECK=0 lo apaga
process.env.SHADOW_CHECK = "0"; fake.armShadow(plan, { ok: true, route: "E", gasUsd: 0.1, sent: null }, 130, 3000); ok(!fake.shadow, "SHADOW_CHECK=0 apaga");
console.log("test_shadow OK");
