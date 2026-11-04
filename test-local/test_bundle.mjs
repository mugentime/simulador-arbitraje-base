// Envío por bundles: builders locales simulados. (1) builder que acepta pero no incluye → sin costo de gas;
// (2) builder que incluye (reenvía la tx a la cadena) → confirmada con beneficio.
import { ethers } from "ethers";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import * as W from "./site/worker.js";
import * as core from "./site/core.js";

const PORT = 8562, BPORT = 8563;
process.env.SEND_RPC = "http://127.0.0.1:" + PORT;
process.env.BUNDLE_SEND = "1";
process.env.MAX_GAS_USD = "5";
let mode = "drop"; const seen = [];
const builder = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const j = JSON.parse(body); seen.push({ mode, j });
  if (req.url === "/bad") { res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "simulated reject" } })); return; }
  if (mode === "include") {
    for (const raw of j.params[0].txs) await fetch(`http://127.0.0.1:${PORT}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) });
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xbundle" }));
}).listen(BPORT);
process.env.BUNDLE_BUILDERS = `local=http://127.0.0.1:${BPORT}/ok,malo=http://127.0.0.1:${BPORT}/bad`;
const { Executor } = await import("/home/claude/simulador-arbitraje-base/server/executor.mjs");

const anvil = spawn(process.env.HOME + "/.foundry/bin/anvil", ["--port", String(PORT), "--chain-id", "8453", "--silent", "--base-fee", "5000000", "--hardfork", "cancun"]);
await new Promise((r) => setTimeout(r, 4000));
let ok = true; const check = (c, m) => { console.log((c ? "OK  " : "FAIL") + " " + m); ok &&= c; };
const mem = new Map();
const store = { get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : null), set: async (k, v) => { mem.set(k, structuredClone(v)); } };
const diag = async (m) => console.log("  diag:", m);
try {
  execFileSync("node", ["setup_local.mjs"], { env: { ...process.env, PORT: String(PORT) } });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { staticNetwork: true });
  process.env.PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const fs = await import("node:fs");
  const art = (f, n) => JSON.parse(fs.readFileSync(`/home/claude/flasharb/out/${f}/${n}.json`));
  const signer = await provider.getSigner(0);
  const morpho = await new ethers.ContractFactory(art("Mocks.sol", "MockMorpho").abi, art("Mocks.sol", "MockMorpho").bytecode.object, signer).deploy();
  await morpho.waitForDeployment();
  await provider.send("anvil_setCode", [core.LENDERS[0].address, await provider.getCode(await morpho.getAddress())]);
  const ex = new Executor({ provider, store, diag, mode: "live", autoDeploy: true });
  await ex.init();
  check(ex.limits.bundleSend, "modo bundle activo");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  await new Promise((r) => setTimeout(r, 1500)); // despliegues de init (contrato, Quoter) ya minados
  await provider.send("evm_mine", []);
  const nonceBefore = await provider.getTransactionCount(wallet.address, "latest");
  const run = async (ms) => {
    const miner = setInterval(() => provider.send("evm_mine", []).catch(() => {}), 500);
    await W.runWorker({ ethers, provider, store, deadlineMs: Date.now() + ms, pollMs: 200, flushEvery: 1, ltHours: 0, onBlock: (ctx) => ex.onBlock(ctx) });
    clearInterval(miner);
  };
  // 1) el builder no incluye: el bundle caduca, sin gas gastado
  await run(7000);
  let p = mem.get("phase1");
  const nonceMid = await provider.getTransactionCount(wallet.address, "latest");
  check(seen.some((x) => x.j.method === "eth_sendBundle" && x.j.params[0].txs.length === 1 && Array.isArray(x.j.params[0].revertingTxHashes) && x.j.params[0].maxBlockNumber > 0), "el builder recibe eth_sendBundle con 1 tx, revertingTxHashes vacío y maxBlockNumber");
  check((p.bundlesMissed ?? 0) >= 1 && p.confirmed === 0 && p.reverted === 0, `bundle no incluido detectado: ${p.bundlesMissed} caducados, ${p.confirmed} confirmados`);
  check(nonceMid === nonceBefore, `ninguna transacción minada (sin gas gastado) mientras el builder no incluye: nonce ${nonceBefore} → ${nonceMid}`);
  // 2) back-run por mempool: una "víctima" que pasa por un router conocido; el watcher modela su swap y envía
  //    el bundle [víctima, nosotros]. El builder local incluye nuestra tx (la de la víctima no tiene fondos: se ignora).
  {
    const { MempoolWatcher, ROUTERS } = await import("/home/claude/simulador-arbitraje-base/server/mempool.mjs");
    const ROUTER = "0x00000000000000000000000000000000000c0de1";
    ROUTERS.base = [{ address: ROUTER, dex: "PancakeSwap v2", kind: "v2" }];
    mode = "include";
    const uni = await W.buildUniverse(ethers, provider, { ltHours: 0 });
    const lenders = await core.readLenders(ethers, provider);
    const gas = await core.readGas(ethers, provider);
    const mw = new MempoolWatcher({ wsUrls: ["ws://127.0.0.1:1"], executor: ex, diag, minUsd: 0.01 });
    mw.setUniverse(uni.pools, uni.cycles); mw.setContext({ gas, ethUsd: 3100, lenders });
    const victim = ethers.Wallet.createRandom();
    const I = new ethers.Interface(["function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"]);
    const data = I.encodeFunctionData("swapExactTokensForTokens", [100n * 10n ** 6n, 1n, [core.TOKENS.USDC.address, core.TOKENS.WETH.address], victim.address, 9999999999n]);
    const raw = await victim.signTransaction({ type: 2, chainId: 8453n, nonce: 0, gasLimit: 200000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, to: ROUTER, data });
    const t = ethers.Transaction.from(raw);
    const rpcObj = { hash: t.hash, type: "0x2", chainId: "0x2105", nonce: "0x0", gas: "0x30d40", to: ROUTER, value: "0x0", input: data, r: t.signature.r, s: t.signature.s, v: "0x" + t.signature.yParity.toString(16), maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x5f5e100", accessList: [] };
    for (let i = 0; i < 6; i++) await provider.send("evm_mine", []);
    const nBundles = seen.length;
    await mw.onTx(rpcObj);
    console.log("  mempool:", JSON.stringify(mw.m));
    const sentB = seen.slice(nBundles).find((x) => x.j.params[0].txs.length === 2);
    check(mw.m.decoded === 1 && mw.m.modeled === 1 && mw.m.profitable === 1 && mw.m.bundles === 1, "watcher: decodifica, modela, encuentra back-run y envía bundle");
    check(sentB && sentB.j.params[0].txs[0] === raw, "el bundle lleva primero la tx de la víctima (idéntica) y después la nuestra");
    for (let i = 0; i < 2; i++) await provider.send("evm_mine", []);
    await ex.reconcile(3100);
    const p3 = mem.get("phase1");
    check(p3.confirmed >= 1 && (p3.backruns ?? 0) >= 1, `back-run confirmado (${p3.confirmed} confirmadas, ${p3.backruns} back-runs)`);
  }
  // 3) el builder incluye (ruta normal, sin víctima)
  mode = "include";
  const usdc = new ethers.Contract(core.TOKENS.USDC.address, ["function balanceOf(address) view returns (uint256)"], provider);
  const before = await usdc.balanceOf(wallet.address);
  await run(9000);
  p = mem.get("phase1");
  const after = await usdc.balanceOf(wallet.address);
  console.log("  recent:", JSON.stringify(p.recent.slice(0, 3).map((x) => [x.ok, x.netUsd, x.sent])));
  check(p.confirmed >= 1 && p.reverted === 0, `bundle incluido y confirmado (${p.confirmed})`);
  check(after > before || p.realizedUsd > 0, `beneficio llegó a la wallet: +${Number(after - before) / 1e6} USDC, realizado $${p.realizedUsd.toFixed(4)}`);
  check(!JSON.stringify(p).includes(process.env.PRIVATE_KEY.slice(4, 20)), "la llave nunca aparece en lo guardado");
} catch (e) { console.error(e); ok = false; }
anvil.kill(); builder.close();
process.exit(ok ? 0 : 1);
