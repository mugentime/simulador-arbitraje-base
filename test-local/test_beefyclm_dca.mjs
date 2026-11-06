// beefy-clm-dca: depósito periódico de $10 en un CLM de Uniswap v3 con reward pool (cbBTC-USDC), nodo simulado.
// Cubre: resolución vía /gov-vaults, cotización con QuoterV2, swaps en SwapRouter02, stake en el reward pool,
// uso del USDC de la wallet antes que el ETH, espera al siguiente periodo, y "sin fondos" → reintento por hora.
import { ethers } from "ethers";
import { Strategy, BASE } from "../server/strategy.mjs";
import { UNI_FACTORY, UNI_QUOTER, ethForUsdc } from "../server/beefyclm.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
ok(ethForUsdc(10_000_000n, 3300) === ethers.parseEther((10 / 3300 * 1.01).toFixed(18)), "ETH para $10 con 1 % de margen");

const A = (n) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const RP = A(0x2001), CLM = A(0x2002), STRAT = A(0x2003), POOL = A(0x2004), CBBTC = A(0x2005);
const C = new ethers.Interface(["function wants() view returns (address,address)", "function strategy() view returns (address)", "function pool() view returns (address)", "function factory() view returns (address)", "function fee() view returns (uint24)", "function balances() view returns (uint256,uint256)", "function previewDeposit(uint256,uint256) view returns (uint256,uint256,uint256,uint256,uint256)", "function deposit(uint256,uint256,uint256)", "function stake(uint256)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
const U = new ethers.Interface(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"]);
const me = ethers.Wallet.createRandom().address; const lc = (a) => a.toLowerCase();
const st = { eth: ethers.parseEther("0.01063"), bal: {}, allow: {} };
const B = (t) => st.bal[lc(t)] ?? 0n; const add = (t, v) => { st.bal[lc(t)] = B(t) + v; };
const ETHUSD = 3300n, BTCUSD = 100_000n; // cbBTC 8 decimales
const usdcToBtc = (u) => u * 100n / BTCUSD; // 6 dec → 8 dec
const sent = [];
const pd = (a0, a1) => { const u0 = a0 < a1 * 1000n / 1n ? a0 : a1 * 1000n / 1n; return [u0 * 2n, u0, u0 * 1n / 1000n]; };
function exec(tx, write) {
  const to = lc(tx.to);
  if (to === lc(BASE.ROUTER) && tx.data === C.getFunction("factory").selector) return C.encodeFunctionResult("factory", [ethers.getAddress(UNI_FACTORY)]);
  if (to === lc(BASE.ROUTER)) {
    const p = U.parseTransaction({ data: tx.data, value: tx.value ?? 0n }).args[0];
    let out;
    if (lc(p[0]) === lc(BASE.WETH)) { out = p[4] * ETHUSD / 10n ** 12n; if (write) add(BASE.USDC, out); }
    else { if ((st.allow[lc(p[0]) + lc(BASE.ROUTER)] ?? 0n) < p[4]) throw new Error("execution reverted: STF"); out = usdcToBtc(p[4]); if (out < p[5]) throw new Error("Too little received"); if (write) { add(BASE.USDC, -p[4]); add(CBBTC, out); } }
    return U.encodeFunctionResult("exactInputSingle", [out]);
  }
  const f = C.parseTransaction({ data: tx.data }); const r = (fn, v) => C.encodeFunctionResult(fn, v);
  if (to === lc(UNI_QUOTER)) { const q = f.args[0]; ok(Number(q[3]) === 500, "QuoterV2 con la comisión del pool"); return r("quoteExactInputSingle", [usdcToBtc(q[2]), 0n, 0, 0n]); }
  if (f.name === "balanceOf") return r("balanceOf", [B(to)]);
  if (f.name === "allowance") return r("allowance", [st.allow[to + lc(f.args[1])] ?? 0n]);
  if (f.name === "approve") { if (write) st.allow[to + lc(f.args[0])] = f.args[1]; return r("approve", [true]); }
  if (to === lc(RP) && f.name === "stake") { if (write) { add(CLM, -f.args[0]); add(RP, f.args[0]); } return "0x"; }
  if (to === lc(CLM)) {
    if (f.name === "wants") return r("wants", [BASE.USDC, CBBTC]); if (f.name === "strategy") return r("strategy", [STRAT]);
    if (f.name === "balances") return r("balances", [500_000_000_000n, 500_000_000n]); // $500k USDC y 5 cbBTC ($500k) → 50/50
    if (f.name === "previewDeposit") return r("previewDeposit", [f.args[0] + f.args[1] * 1000n, f.args[0], f.args[1], 0n, 0n]);
    if (f.name === "deposit") { if (write) { add(BASE.USDC, -f.args[0]); add(CBBTC, -f.args[1]); add(CLM, f.args[0] + f.args[1] * 1000n); } return "0x"; }
  }
  if (to === lc(STRAT)) return r("pool", [POOL]);
  if (to === lc(POOL)) return f.name === "factory" ? r("factory", [ethers.getAddress(UNI_FACTORY)]) : r("fee", [500]);
  throw new Error("sin respuesta " + to + " " + f.name);
}
const provider = { async getBalance() { return st.eth; }, async getFeeData() { return { maxFeePerGas: 10_000_000n }; }, async estimateGas(tx) { exec(tx, false); return 200_000n; }, async call(tx) { return exec(tx, false); }, async waitForTransaction() { return { status: 1, blockNumber: 1, gasUsed: 1n }; } };
const executor = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => { exec(tx, true); st.eth -= (tx.value ?? 0n) + 2_000_000_000n; sent.push(tx); return { hash: "0x" + String(sent.length).padStart(64, "0") }; } }) };
globalThis.fetch = async (url) => ({ json: async () => String(url).endsWith("/gov-vaults") ? [{ id: "uniswap-cow-base-usdc-cbbtc-rp", chain: "base", status: "active", earnContractAddress: RP, tokenAddress: CLM }] : [] });
const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
const logs = []; const diag = async (m) => logs.push(m);
Object.assign(process.env, { STRATEGY: "beefy-clm-dca", STRATEGY_RUN: "cbbtc", STRATEGY_VAULT_ID: "uniswap-cow-base-usdc-cbbtc-rp", DCA_USD: "10", DCA_EVERY_H: "24" });
const s = new Strategy({ executor, provider, store, diag }); await s.init();
await s.onBlock({ ethUsd: 3300 });
const d = () => mem.strategy.dca.cbbtc;
ok(d().n === 1 && d().totalUsd === 10, `primer depósito hecho (${mem.strategy.runs["cbbtc#1"]?.error ?? mem.strategy.runs["cbbtc#1"]?.status})`);
ok(B(RP) > 0n && B(BASE.USDC) <= 110_000n && B(CBBTC) <= 1n, `en el reward pool ${B(RP)}, sobrante USDC (margen 1 %, se usa en el siguiente) ${B(BASE.USDC)} cbBTC ${B(CBBTC)}`);
const ethSpent = ethers.parseEther("0.01063") - st.eth;
ok(ethSpent > ethers.parseEther("0.0030") && ethSpent < ethers.parseEther("0.0032"), `ETH usado ≈ $10: ${ethers.formatEther(ethSpent)}`);
ok(logs.some((l) => l.includes("Uniswap v3 fee 500")) && logs.some((l) => l.includes("depósito 1 de $10")), "diag de resolución y depósito");
// mismo día: no deposita otra vez
const n0 = sent.length; await s.onBlock({ ethUsd: 3300 }); ok(sent.length === n0, "espera al siguiente periodo");
// USDC ya en la wallet: no cambia ETH
mem.strategy.dca.cbbtc.lastAt -= 25 * 3600_000; s.s = mem.strategy; add(BASE.USDC, 10_000_000n);
const ethBefore = st.eth; await s.onBlock({ ethUsd: 3300 });
ok(d().n === 2 && !sent.slice(n0).some((t) => (t.value ?? 0n) > 0n) && st.eth < ethBefore, "segundo depósito con el USDC de la wallet, sin vender ETH");
// sin fondos: reintento por hora, sin error permanente
mem.strategy.dca.cbbtc.lastAt -= 25 * 3600_000; s.s = mem.strategy; st.eth = ethers.parseEther("0.0021");
await s.onBlock({ ethUsd: 3300 });
ok(d().n === 2 && s.retryAt > Date.now() + 3500_000 && logs.some((l) => l.includes("fondos insuficientes")), "sin fondos → reintento en 1 h");
// barrido: X sobrante en la wallet → se rebalancea y deposita sin esperar al siguiente día
st.eth = ethers.parseEther("0.01"); add(CBBTC, 5000n); const rpBefore = B(RP); s.retryAt = 0;
process.env.DCA_SWEEP = "s1"; await s.onBlock({ ethUsd: 3300 });
ok(mem.strategy.dca.cbbtc.sweptTag === "s1" && B(RP) > rpBefore && B(CBBTC) < 100n, `barrido: cbBTC en wallet ${B(CBBTC)}, reward pool +${B(RP) - rpBefore}`);
await s.onBlock({ ethUsd: 3300 }); ok(Object.keys(mem.strategy.runs).filter((k) => k.includes("-sweep-")).length === 1, "el barrido no se repite");
delete process.env.DCA_SWEEP;
console.log(fails ? "HAY FALLAS" : "todo OK");
process.exit(fails ? 1 : 0);
