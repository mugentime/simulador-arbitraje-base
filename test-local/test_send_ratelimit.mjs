// Prueba: un RPC de envío con 429 (cuota agotada) no debe retrasar el envío con los reintentos de ethers,
// y se salta en los envíos siguientes.
import http from "node:http";
import { ethers } from "ethers";
import { FanoutProvider, noRetryRequest, RATE_LIMIT_RE, sendBackoffMin } from "../server/executor.mjs";
process.on("unhandledRejection", () => {}); // el servidor registra estas como "promesa rechazada"
const hits = { lim: 0, ok: 0 };
function node(name, limited) {
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const j = JSON.parse(b); hits[name]++;
      if (limited) { res.statusCode = 429; return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: 429, message: "Monthly capacity limit exceeded." } })); }
      const r = j.method === "eth_chainId" ? "0x2105" : j.method === "eth_getTransactionCount" ? "0x7" : j.method === "eth_sendRawTransaction" ? ethers.keccak256(j.params[0]) : "0x0";
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: r }));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const lim = await node("lim", true), good = await node("ok", false);
// 1) lectura por un RPC en 429: falla rápido (sin 12 reintentos con espera exponencial)
let t0 = Date.now(), msg = "";
try { await new ethers.JsonRpcProvider(noRetryRequest(lim.url), 8453, { staticNetwork: true }).getTransactionCount(ethers.ZeroAddress); } catch (e) { msg = e.shortMessage || e.message; }
ok(Date.now() - t0 < 1000, `429 falla en ${Date.now() - t0} ms (antes: reintentos de segundos/minutos)`);
ok(hits.lim <= 2, `el nodo en 429 recibe ${hits.lim} petición(es), no 12`);
ok(RATE_LIMIT_RE.test(msg), `el mensaje se reconoce como límite de cuota: "${msg.slice(0, 60)}"`);
// 2) flujo de Executor.withSender: primero el limitado, luego el bueno; el segundo envío ya no toca el limitado
const { Executor } = await import("../server/executor.mjs").catch(() => ({}));
const ex = Executor ? Object.create(Executor.prototype) : null;
if (ex) {
  ex.sendRpcs = [lim.url, good.url]; ex.sendIdx = 0; ex.sendBad = new Map(); ex.diag = async (m) => console.log("  diag:", m);
  ex.wallet = ethers.Wallet.createRandom();
  const send = (w) => w.sendTransaction({ to: ex.wallet.address, data: "0x", gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  t0 = Date.now(); await ex.withSender(send);
  ok(Date.now() - t0 < 1500, `primer envío (con rotación) en ${Date.now() - t0} ms`);
  const before = hits.lim; ex.sendIdx = 0; ex.sendProv = null; // como tras reiniciar el índice
  await ex.withSender(send);
  ok(hits.lim === before, "el RPC en 429 se salta en el siguiente envío");
  const until = ex.sendBad.get(lim.url) - Date.now();
  ok(until > 600 * 60e3, `cuota mensual agotada: se salta ${(until / 3600e3).toFixed(1)} h (antes 30 min: cada envío horario volvía a tocarlo)`);
} else console.log("(Executor no exportado: se omite la parte 2)");
ok(sendBackoffMin("exceeded maximum retry limit", {}) === 30, "429 genérico: 30 min");
ok(sendBackoffMin("x Monthly capacity limit exceeded.", {}) === 720, "cuota mensual: 720 min");
ok(sendBackoffMin("execution reverted", {}) === 0, "error de la tx: no se salta el RPC");
lim.srv.close(); good.srv.close();
console.log("TODO OK");
