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
// BRIDGE_TOKEN: todo el USDT de BSC → USDC en Base; Relay pide approve + depósito y se envían en orden
{
  core.applyChain(chainByKey("bsc"));
  const USDT = "0x55d398326f99059fF775485246999027B3197955";
  const I = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
  const sent2 = []; let qbody = null;
  const prov = { getBalance: async () => E("0.0011"), getFeeData: async () => ({ gasPrice: 100_000_000n }), estimateGas: async () => 60_000n, getTransactionReceipt: async () => ({ status: 1 }), waitForTransaction: async () => ({ status: 1 }),
    call: async (tx) => { const sel = String(tx.data).slice(0, 10);
      if (tx.to && tx.to.toLowerCase() === USDT.toLowerCase()) { if (sel === I.getFunction("balanceOf").selector) return I.encodeFunctionResult("balanceOf", [ethers.parseUnits("98.53", 18)]); if (sel === I.getFunction("decimals").selector) return I.encodeFunctionResult("decimals", [18]); return I.encodeFunctionResult("symbol", ["USDT"]); }
      return "0x"; } };
  const ex = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => { sent2.push(tx); return { hash: "0xt" + sent2.length }; } }) };
  globalThis.fetch = async (url, o) => {
    if (String(url).includes("/quote/v2")) { qbody = JSON.parse(o.body); return { ok: true, json: async () => ({ steps: [
      { id: "approve", kind: "transaction", items: [{ data: { to: USDT, data: "0x095ea7b3", value: "0", chainId: 56 } }] },
      { id: "deposit", kind: "transaction", requestId: "0xr2", items: [{ data: { to: "0x00000000000000000000000000000000000000bb", data: "0x99", value: "0", chainId: 56 } }] }],
      details: { currencyIn: { amountUsd: "98.53" }, currencyOut: { amountUsd: "98.20", amount: "98200000" } } }) }; }
    return { ok: true, json: async () => ({ status: "success", txHashes: ["0xdest2"] }) };
  };
  const mem2 = {}; const st2 = { get: async (k) => mem2[k], set: async (k, v) => { mem2[k] = JSON.parse(JSON.stringify(v)); } };
  process.env.BRIDGE_RUN = "t1"; process.env.BRIDGE_TOKEN = USDT;
  const b2 = new Bridger({ executor: ex, provider: prov, store: st2, diag: async () => {} }); await b2.init();
  await b2.onBlock({ ethUsd: 670 });
  ok(qbody && qbody.originCurrency === USDT && qbody.amount === ethers.parseUnits("98.53", 18).toString() && qbody.originChainId === 56, "pide puentear todo el USDT de BSC");
  ok(sent2.length === 2 && sent2[0].to === USDT && sent2[1].data === "0x99", "approve y depósito, en ese orden");
  ok(mem2.bridge.runs.t1.hash === "0xt2" && mem2.bridge.runs.t1.requestId === "0xr2", "sigue el depósito");
  await b2.onBlock({ ethUsd: 670 }); ok(mem2.bridge.runs.t1.status === "hecho", "llegó a Base");
  delete process.env.BRIDGE_TOKEN;
}
console.log(fails ? "HAY FALLAS" : "todo OK"); process.exit(fails ? 1 : 0);
