// Prueba: sendErrMsg saca el mensaje real del nodo de un "could not coalesce error" de ethers v6.
import { ethers } from "ethers";
import http from "node:http";
import { sendErrMsg } from "../server/executor.mjs";

let ok = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) ok++; else { fail++; console.log("FALLA", m, "\n  obtenido:", a, "\n  esperado:", b); } };

// 1) error construido como lo hace JsonRpcProvider.getRpcError
const e1 = ethers.makeError("could not coalesce error", "UNKNOWN_ERROR", { error: { code: -32000, message: "gas tip cap 1000000000, minimum needed 25000000000" }, payload: {} });
eq(sendErrMsg(e1), "could not coalesce error: gas tip cap 1000000000, minimum needed 25000000000", "coalesce con e.error");
// 2) errores ya clasificados no se duplican
const e2 = ethers.makeError("insufficient funds for intrinsic transaction cost", "INSUFFICIENT_FUNDS", {});
eq(sendErrMsg(e2), "insufficient funds for intrinsic transaction cost", "clasificado");
eq(sendErrMsg(new Error("x")), "x", "Error normal");

// 3) extremo a extremo: nodo JSON-RPC falso que rechaza eth_sendRawTransaction con un código raro
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const j = JSON.parse(b);
    res.setHeader("content-type", "application/json");
    if (j.method === "eth_sendRawTransaction") return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: -32099, message: "gas tip cap 1 below minimum 25000000000" } }));
    res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: "0x89" }));
  });
}).listen(0);
const url = `http://127.0.0.1:${srv.address().port}`;
const prov = new ethers.JsonRpcProvider(url, 137, { staticNetwork: true, batchMaxCount: 1 });
const w = ethers.Wallet.createRandom().connect(prov);
const raw = await w.signTransaction({ to: w.address, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, chainId: 137, type: 2 });
try { await prov.broadcastTransaction(raw); fail++; console.log("FALLA: no lanzó"); }
catch (e) {
  const m = sendErrMsg(e);
  console.log("ethers dice:", e.shortMessage, "→ sendErrMsg:", m);
  eq(/below minimum 25000000000/.test(m), true, "mensaje real del nodo en e2e");
  eq(/tip cap|below minimum/i.test(m), true, "lo atrapa la regex de errores propios de la tx");
}
srv.close();
console.log(`${ok} ok, ${fail} fallas`); process.exit(fail ? 1 : 0);
