// Demo dinámico en Robinhood Chain (AI-WETH): DCA envolviendo ETH→WETH, retención de recompensas (no se reinvierten),
// rotación a otro vault ≥ ×1.5 APY durante 2 h con reinversión del capital. Nodo y API de Beefy simulados.
import { ethers } from "ethers";
import { Strategy } from "../server/strategy.mjs";
import { netOf } from "../server/beefyclm.mjs";
import * as core from "../src/core.js";
import { chainByKey } from "../src/chains.js";
core.applyChain(chainByKey("robinhood"));
const N = netOf("robinhood"); const W = N.stable;
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const A = (n) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const V = { a: { rp: A(0x3001), clm: A(0x3002), strat: A(0x3003), pool: A(0x3004), x: A(0x3005), id: "uniswap-cow-robinhood-weth-ai-rp" },
            b: { rp: A(0x4001), clm: A(0x4002), strat: A(0x4003), pool: A(0x4004), x: A(0x4005), id: "uniswap-cow-robinhood-weth-boner-rp" } };
const C = new ethers.Interface(["function wants() view returns (address,address)", "function strategy() view returns (address)", "function pool() view returns (address)", "function factory() view returns (address)", "function fee() view returns (uint24)", "function previewDeposit(uint256,uint256) view returns (uint256,uint256,uint256,uint256,uint256)", "function deposit(uint256,uint256,uint256)", "function deposit()", "function stake(uint256)", "function withdraw(uint256)", "function withdraw(uint256,uint256,uint256)", "function previewWithdraw(uint256) view returns (uint256,uint256)", "function earned(address) view returns (address[],uint256[])", "function getReward()", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
const U = new ethers.Interface(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"]);
const me = ethers.Wallet.createRandom().address; const lc = (a) => a.toLowerCase();
const E = 10n ** 18n;
const st = { eth: E / 50n, bal: {}, allow: {}, reward: { a: 0n, b: 0n } };
const B = (t) => st.bal[lc(t)] ?? 0n; const add = (t, v) => { st.bal[lc(t)] = B(t) + v; };
const RATE = 1000n; // 1 WETH = 1000 X
const byAddr = (a) => Object.values(V).find((v) => [v.rp, v.clm, v.strat, v.pool].map(lc).includes(lc(a)));
const sent = [];
function exec(tx, write) {
  const to = lc(tx.to);
  if (to === lc(N.router) && tx.data === C.getFunction("factory").selector) return C.encodeFunctionResult("factory", [ethers.getAddress(N.uniFactory)]);
  if (to === lc(N.router)) {
    const p = U.parseTransaction({ data: tx.data, value: tx.value ?? 0n }).args[0];
    if ((st.allow[lc(p[0]) + to] ?? 0n) < p[4]) throw new Error("STF");
    const out = lc(p[0]) === lc(W) ? p[4] * RATE : p[4] / RATE;
    if (write) { add(p[0], -p[4]); add(p[1], out); }
    return U.encodeFunctionResult("exactInputSingle", [out]);
  }
  const f = C.parseTransaction({ data: tx.data, value: tx.value ?? 0n }); const r = (fn, v) => C.encodeFunctionResult(fn, v);
  if (to === lc(N.quoter)) { const q = f.args[0]; return r("quoteExactInputSingle", [lc(q[0]) === lc(W) ? q[2] * RATE : q[2] / RATE, 0n, 0, 0n]); }
  if (to === lc(W) && f.name === "deposit") { if (write) { st.eth -= tx.value; add(W, tx.value); } return "0x"; }
  if (f.name === "balanceOf") return r("balanceOf", [st.bal[to + lc(f.args[0])] ?? B(to)]);
  if (f.name === "allowance") return r("allowance", [st.allow[to + lc(f.args[1])] ?? 0n]);
  if (f.name === "approve") { if (write) st.allow[to + lc(f.args[0])] = f.args[1]; return r("approve", [true]); }
  const v = byAddr(to); const k = v === V.a ? "a" : "b";
  if (to === lc(v.rp)) {
    if (f.name === "stake") { if (write) { add(v.clm, -f.args[0]); add(v.rp, f.args[0]); } return "0x"; }
    if (f.name === "withdraw") { if (write) { add(v.rp, -f.args[0]); add(v.clm, f.args[0]); } return "0x"; }
    if (f.name === "earned") return r("earned", [[v.x, W], [st.reward[k] * RATE / 2n, st.reward[k] / 2n]]);
    if (f.name === "getReward") { if (write) { add(v.x, st.reward[k] * RATE / 2n); add(W, st.reward[k] / 2n); st.reward[k] = 0n; } return "0x"; }
  }
  if (to === lc(v.clm)) {
    if (f.name === "wants") return r("wants", [W, v.x]); if (f.name === "strategy") return r("strategy", [v.strat]);
    if (f.name === "previewDeposit") return r("previewDeposit", [f.args[0] * 2n, f.args[0], f.args[0] * RATE, 0n, 0n]);
    if (f.name === "deposit") { if (write) { add(W, -f.args[0]); add(v.x, -f.args[1]); add(v.clm, f.args[0] * 2n); } return "0x"; }
    if (f.name === "previewWithdraw") return r("previewWithdraw", [f.args[0] / 2n, f.args[0] / 2n * RATE]);
    if (f.name === "withdraw") { if (write) { add(v.clm, -f.args[0]); add(W, f.args[0] / 2n); add(v.x, f.args[0] / 2n * RATE); } return "0x"; }
  }
  if (to === lc(v.strat)) return r("pool", [v.pool]);
  if (to === lc(v.pool)) return f.name === "factory" ? r("factory", [ethers.getAddress(N.uniFactory)]) : r("fee", [3000]);
  throw new Error("sin respuesta " + to + " " + f.name);
}
const provider = { async getBalance() { return st.eth; }, async getFeeData() { return { maxFeePerGas: 1000n }; }, async estimateGas(tx) { exec(tx, false); return 200_000n; }, async call(tx) { return exec(tx, false); }, async waitForTransaction() { return { status: 1, blockNumber: 1, gasUsed: 1n }; } };
const executor = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => { exec(tx, true); sent.push(tx); return { hash: "0x" + String(sent.length).padStart(64, "0") }; } }) };
const api = { apy: { [V.a.id]: { totalApy: 400 } }, tvl: { [V.a.id]: 60_000 }, bActive: false };
globalThis.fetch = async (url) => { const u = String(url); const j = u.endsWith("/gov-vaults") ? Object.values(V).filter((v) => v === V.a || api.bActive).map((v) => ({ id: v.id, name: v.id, chain: "robinhood", status: "active", earnContractAddress: v.rp, tokenAddress: v.clm }))
  : u.endsWith("/cow-vaults") ? Object.values(V).map((v) => ({ chain: "robinhood", earnContractAddress: v.clm, platformId: "uniswap" })) : u.endsWith("/apy/breakdown") ? api.apy : u.endsWith("/tvl") ? { 4663: api.tvl } : [];
  return { ok: true, json: async () => j }; };
const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
const logs = []; const diag = async (m) => logs.push(m);
Object.assign(process.env, { STRATEGY: "beefy-clm-dca", STRATEGY_RUN: "demo", STRATEGY_VAULT_ID: "auto", STRATEGY_DYNAMIC: "1", STRATEGY_RESERVE_ETH: "0.0003", DCA_USD: "10", DCA_EVERY_H: "24", HIGH_APY_MIN_TVL: "20000", PROFIT_EVERY_H: "6" });
const s = new Strategy({ executor, provider, store, diag }); await s.init();
const tick = async (ms = 0) => { s.autoAt -= ms; s.retryAt = 0; if (mem.strategy?.dca?.demo) { mem.strategy.dca.demo.lastAt -= ms; if (mem.strategy.dca.demo.profitAt) mem.strategy.dca.demo.profitAt -= ms; for (const h of Object.values(mem.strategy.dca.demo.holdings ?? {})) { if (h.rotateSince) h.rotateSince -= ms; if (h.badSince) h.badSince -= ms; } } if (mem.strategy) s.s = mem.strategy; await s.onBlock({ ethUsd: 2000 }); };
for (let i = 0; i < 3; i++) await tick();
const d = () => mem.strategy.dca.demo;
ok(d().target === V.a.id, `destino AI-WETH (${d().target})`);
ok(d().n === 1 && B(V.a.rp) === 5n * E / 1000n && B(W) === 0n, `primer depósito: $10 = 0.005 WETH envuelto → reward pool ${B(V.a.rp)} (${JSON.stringify(Object.values(mem.strategy.runs).map((r) => r.error).filter(Boolean))})`);
ok(sent.some((t) => lc(t.to) === lc(W) && t.value === 5n * E / 1000n), "envolvió solo lo necesario (0.005 ETH)");
// recompensas → retenidas
st.reward.a = E / 1000n; // 0.001 WETH en valor: mitad en X, mitad en WETH
await tick(7 * 3600_000);
ok(BigInt(d().retained ?? 0) === E / 1000n, `ganancia retenida ${d().retained} (0.001 WETH)`);
ok(B(V.a.x) === 0n && B(W) === E / 1000n, `recompensa en X cambiada a WETH y apartada (wallet ${B(W)} WETH)`);
// el siguiente depósito no usa lo retenido
await tick(25 * 3600_000); await tick();
ok(d().n === 2 && B(W) === E / 1000n, `segundo depósito sin tocar lo retenido (wallet ${ethers.formatEther(B(W))} WETH, n=${d().n})`);
// rotación: aparece B con APY ×2 sostenido 2 h → sale de A y reinvierte en B
api.bActive = true; api.apy[V.b.id] = { totalApy: 900 }; api.tvl[V.b.id] = 50_000;
await tick(3600_001); await tick(2 * 3600_001); await tick(); await tick();
ok(B(V.a.rp) === 0n && d().holdings[V.a.id].closed, `salió de AI-WETH (${d().holdings[V.a.id].exitWhy})`);
ok(d().target === V.b.id && B(V.b.rp) > 0n && d().redeploy === "0", `capital reinvertido en el nuevo destino (rp B ${B(V.b.rp)})`);
ok(B(W) >= E / 1000n, `lo retenido sigue en la wallet (${ethers.formatEther(B(W))} WETH)`);
console.log(logs.filter((l) => /dinámica|auto:/.test(l)).join("\n"));
console.log(fails ? "HAY FALLAS" : "todo OK"); process.exit(fails ? 1 : 0);
