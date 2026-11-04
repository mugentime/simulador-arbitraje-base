// Prueba: FanoutProvider difunde la tx firmada al "secuenciador" y al RPC a la vez; lecturas solo por el RPC.
import http from "node:http";
import { ethers } from "ethers";
import { FanoutProvider } from "../server/executor.mjs";
const calls = { seq: [], rpc: [] };
function node(name, { delay = 0, fail = null, reads = true }) {
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const j = JSON.parse(b); calls[name].push(j.method);
      const reply = (o) => setTimeout(() => res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, ...o })), delay);
      if (j.method === "eth_sendRawTransaction") return fail ? reply({ error: { code: -32000, message: fail } }) : reply({ result: ethers.keccak256(j.params[0]) });
      if (!reads) return reply({ error: { code: -32601, message: "method not supported" } });
      if (j.method === "eth_chainId") return reply({ result: "0x2105" });
      if (j.method === "eth_getTransactionCount") return reply({ result: "0x7" });
      reply({ result: "0x0" });
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const seq = await node("seq", { delay: 5, reads: false });
const rpc = await node("rpc", { delay: 60 });
const w = ethers.Wallet.createRandom();
let p = new FanoutProvider(rpc.url, [seq.url, rpc.url], 8453);
let signer = new ethers.NonceManager(w.connect(p));
const tx = await signer.sendTransaction({ to: w.address, data: "0x", gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
ok(tx.nonce === 7, "nonce leído del RPC normal (no del secuenciador)");
ok(calls.seq.length === 1 && calls.seq[0] === "eth_sendRawTransaction", "el secuenciador solo recibe eth_sendRawTransaction");
ok(calls.rpc.includes("eth_sendRawTransaction"), "también se difunde al RPC normal");
ok(p.lastWinner === new URL(seq.url).host, "gana el secuenciador (más rápido)");
// secuenciador caído: gana el RPC
const dead = await node("seq", { fail: "sequencer unavailable", reads: false });
p = new FanoutProvider(rpc.url, [dead.url, rpc.url], 8453); signer = new ethers.NonceManager(w.connect(p));
await signer.sendTransaction({ to: w.address, data: "0x", gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
ok(p.lastWinner === new URL(rpc.url).host, "si el secuenciador falla, gana el RPC");
// ambos fallan con error propio de la tx: se propaga el mensaje
const bad1 = await node("seq", { fail: "max fee per gas less than block base fee", reads: false });
const bad2 = await node("rpc", { fail: "max fee per gas less than block base fee" });
p = new FanoutProvider(bad2.url, [bad1.url, bad2.url], 8453); signer = new ethers.NonceManager(w.connect(p));
let msg = ""; try { await signer.sendTransaction({ to: w.address, data: "0x", gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }); } catch (e) { msg = e.error?.message || e.message; }
ok(/base fee/.test(msg), "si todos fallan se propaga el error del nodo: " + msg.slice(0, 60));
for (const n of [seq, rpc, dead, bad1, bad2]) n.srv.close();
process.exit(0);
