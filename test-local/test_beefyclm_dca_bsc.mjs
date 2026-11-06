// beefy-clm-dca en BNB Chain: $10 diarios en ZEC-USDT (Uniswap v3 BSC, USDT de 18 decimales), sin vender BNB; nodo simulado.
// Cubre: resolución vía /gov-vaults, cotización con QuoterV2, swaps en SwapRouter02, stake en el reward pool,
// uso del USDC de la wallet antes que el ETH, espera al siguiente periodo, y "sin fondos" → reintento por hora.
import { ethers } from "ethers";
import { Strategy, BASE } from "../server/strategy.mjs";
import { netOf } from "../server/beefyclm.mjs";
import * as core from "../src/core.js";
import { chainByKey } from "../src/chains.js";
core.applyChain(chainByKey("bsc"));
const N = netOf("bsc"); const UNI_FACTORY = N.uniFactory, UNI_QUOTER = N.quoter; const STABLE = N.stable;
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };

const A = (n) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const RP = A(0x2001), CLM = A(0x2002), STRAT = A(0x2003), POOL = A(0x2004), CBBTC = A(0x2005);
const C = new ethers.Interface(["function wants() view returns (address,address)", "function strategy() view returns (address)", "function pool() view returns (address)", "function factory() view returns (address)", "function fee() view returns (uint24)", "function balances() view returns (uint256,uint256)", "function previewDeposit(uint256,uint256) view returns (uint256,uint256,uint256,uint256,uint256)", "function deposit(uint256,uint256,uint256)", "function stake(uint256)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
const U = new ethers.Interface(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"]);
const me = ethers.Wallet.createRandom().address; const lc = (a) => a.toLowerCase();
const st = { eth: ethers.parseEther("0.0015"), bal: {}, allow: {} };
const B = (t) => st.bal[lc(t)] ?? 0n; const add = (t, v) => { st.bal[lc(t)] = B(t) + v; };
const ZECUSD = 500n;
const usdcToBtc = (u) => u / ZECUSD; // USDT 18 dec → ZEC 18 dec
const sent = [];
const pd = (a0, a1) => { const u0 = a0 < a1 * 500n / 1n ? a0 : a1 * 500n / 1n; return [u0 * 2n, u0, u0 * 1n / 500n]; };
function exec(tx, write) {
  const to = lc(tx.to);
  if (to === lc(N.router) && tx.data === C.getFunction("factory").selector) return C.encodeFunctionResult("factory", [ethers.getAddress(UNI_FACTORY)]);
  if (to === lc(N.router)) {
    const p = U.parseTransaction({ data: tx.data, value: tx.value ?? 0n }).args[0];
    let out;
    if (lc(p[0]) === lc(N.wnative)) throw new Error("no debe vender BNB");
    else { if ((st.allow[lc(p[0]) + lc(N.router)] ?? 0n) < p[4]) throw new Error("execution reverted: STF"); out = usdcToBtc(p[4]); if (out < p[5]) throw new Error("Too little received"); if (write) { add(STABLE, -p[4]); add(CBBTC, out); } }
    return U.encodeFunctionResult("exactInputSingle", [out]);
  }
  const f = C.parseTransaction({ data: tx.data }); const r = (fn, v) => C.encodeFunctionResult(fn, v);
  if (to === lc(UNI_QUOTER)) { const q = f.args[0]; ok(Number(q[3]) === 500, "QuoterV2 de BSC con la comisión del pool"); return r("quoteExactInputSingle", [usdcToBtc(q[2]), 0n, 0, 0n]); }
  if (f.name === "balanceOf") return r("balanceOf", [B(to)]);
  if (f.name === "allowance") return r("allowance", [st.allow[to + lc(f.args[1])] ?? 0n]);
  if (f.name === "approve") { if (write) st.allow[to + lc(f.args[0])] = f.args[1]; return r("approve", [true]); }
  if (to === lc(RP) && f.name === "stake") { if (write) { add(CLM, -f.args[0]); add(RP, f.args[0]); } return "0x"; }
  if (to === lc(CLM)) {
    if (f.name === "wants") return r("wants", [STABLE, CBBTC]); if (f.name === "strategy") return r("strategy", [STRAT]);
    if (f.name === "balances") return r("balances", [500_000n * 10n ** 18n, 1000n * 10n ** 18n]); // $500k USDT y 1000 ZEC ($500k) → 50/50
    if (f.name === "previewDeposit") return r("previewDeposit", [f.args[0] + f.args[1] * 500n, f.args[0], f.args[1], 0n, 0n]);
    if (f.name === "deposit") { if (write) { add(STABLE, -f.args[0]); add(CBBTC, -f.args[1]); add(CLM, f.args[0] + f.args[1] * 500n); } return "0x"; }
  }
  if (to === lc(STRAT)) return r("pool", [POOL]);
  if (to === lc(POOL)) return f.name === "factory" ? r("factory", [ethers.getAddress(UNI_FACTORY)]) : r("fee", [500]);
  throw new Error("sin respuesta " + to + " " + f.name);
}
const provider = { async getBalance() { return st.eth; }, async getFeeData() { return { maxFeePerGas: 10_000_000n }; }, async estimateGas(tx) { exec(tx, false); return 200_000n; }, async call(tx) { return exec(tx, false); }, async waitForTransaction() { return { status: 1, blockNumber: 1, gasUsed: 1n }; } };
const executor = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => { exec(tx, true); st.eth -= (tx.value ?? 0n) + 2_000_000_000n; sent.push(tx); return { hash: "0x" + String(sent.length).padStart(64, "0") }; } }) };
globalThis.fetch = async (url) => ({ json: async () => String(url).endsWith("/gov-vaults") ? [{ id: "uniswap-cow-bsc-zec-usdt-rp", chain: "bsc", status: "active", earnContractAddress: RP, tokenAddress: CLM }] : [] });
const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
const logs = []; const diag = async (m) => logs.push(m);
Object.assign(process.env, { STRATEGY: "beefy-clm-dca", STRATEGY_RUN: "cbbtc", STRATEGY_VAULT_ID: "uniswap-cow-bsc-zec-usdt-rp", STRATEGY_RESERVE_ETH: "0.0003", DCA_USD: "10", DCA_EVERY_H: "24" });
add(STABLE, 25n * 10n ** 18n);
const s = new Strategy({ executor, provider, store, diag }); await s.init();
await s.onBlock({ ethUsd: 3300 });
const d = () => mem.strategy.dca.cbbtc;
ok(d().n === 1 && d().totalUsd === 10, `primer depósito hecho (${mem.strategy.runs["cbbtc#1"]?.error ?? mem.strategy.runs["cbbtc#1"]?.status})`);
ok(B(RP) > 0n && B(STABLE) === 15n * 10n ** 18n && B(CBBTC) <= 1n, `reward pool ${B(RP)}, quedan ${ethers.formatUnits(B(STABLE), 18)} USDT`);
ok(logs.some((l) => l.includes("Uniswap v3 fee 500")), "resolución con la fábrica Uniswap v3 de BSC");
mem.strategy.dca.cbbtc.lastAt -= 25 * 3600_000; s.s = mem.strategy; await s.onBlock({ ethUsd: 650 });
ok(d().n === 2 && B(STABLE) === 5n * 10n ** 18n, "segundo día con el USDT restante");
mem.strategy.dca.cbbtc.lastAt -= 25 * 3600_000; s.s = mem.strategy; await s.onBlock({ ethUsd: 650 });
ok(d().n === 2 && logs.some((l) => l.includes("no se vende el nativo")), "sin USDT suficiente → espera fondos, no vende BNB");
console.log(fails ? "HAY FALLAS" : "todo OK");
process.exit(fails ? 1 : 0);
