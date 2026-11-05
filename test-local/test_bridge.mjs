// Bridge a Base con Relay: monto con reserva, lectura de la cotización y flujo (simula, envía, sigue el estado).
import { ethers } from "ethers";
import * as core from "../src/core.js";
import { chainByKey } from "../src/chains.js";
import { Bridger, bridgeAmount, parseQuote, BASE_USDC } from "../server/bridge.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const E = ethers.parseEther;
ok(bridgeAmount(E("116"), 1, 0.2, E("0.1")) === E("116") - E("5") - E("0.1"), "reserva $1 en POL a $0.20 = 5 POL");
ok(bridgeAmount(E("0.0004"), 1, 2200, 0n) === 0n, "saldo menor que la reserva → 0");
const Q = { steps: [{ id: "deposit", kind: "transaction", requestId: "0xabc", items: [{ status: "incomplete", data: { to: "0x00000000000000000000000000000000000000aa", data: "0x1234", value: "100", chainId: 137 } }] }], details: { currencyIn: { amountUsd: "23.00" }, currencyOut: { amountUsd: "22.70", amount: "22700000" } } };
const p = parseQuote(Q);
ok(p.txs.length === 1 && p.txs[0].value === 100n && p.requestId === "0xabc" && p.out === "22700000", "cotización leída");
core.applyChain(chainByKey("polygon"));
const me = ethers.Wallet.createRandom().address; let bal = E("116.12"); const sent = []; const diags = [];
const provider = { getBalance: async () => bal, getFeeData: async () => ({ maxFeePerGas: 30_000_000_000n }), call: async () => "0x", estimateGas: async () => 100_000n, getTransactionReceipt: async () => ({ status: 1 }) };
const executor = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => { sent.push(tx); bal -= tx.value; return { hash: "0xh1" }; } }) };
let body = null;
globalThis.fetch = async (url, o) => {
  if (String(url).includes("/quote/v2")) { body = JSON.parse(o.body); return { ok: true, json: async () => ({ ...Q, steps: [{ ...Q.steps[0], items: [{ data: { ...Q.steps[0].items[0].data, value: body.amount } }] }] }) }; }
  return { ok: true, json: async () => ({ status: "success", txHashes: ["0xdest"] }) };
};
const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
process.env.BRIDGE_RUN = "b1"; process.env.BRIDGE_KEEP_USD = "1";
const b = new Bridger({ executor, provider, store, diag: async (m) => diags.push(m) }); await b.init();
await b.onBlock({ ethUsd: 0.2 });
ok(body && body.destinationChainId === 8453 && body.destinationCurrency === BASE_USDC && body.originChainId === 137, "pide USDC en Base desde Polygon");
ok(sent.length === 1 && bal >= E("5"), `enviado ${ethers.formatEther(sent[0]?.value ?? 0n)} POL, quedan ${ethers.formatEther(bal)} para gas`);
await b.onBlock({ ethUsd: 0.2 });
ok(mem.bridge.runs.b1.status === "hecho" && mem.bridge.runs.b1.destTx === "0xdest", "estado seguido hasta llegar a Base");
await b.onBlock({ ethUsd: 0.2 }); ok(sent.length === 1, "una sola vez por etiqueta");
console.log(fails ? "HAY FALLAS" : "todo OK"); process.exit(fails ? 1 : 0);
