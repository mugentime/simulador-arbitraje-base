// CLM sin el estable (p. ej. ZEC-BTCB en BSC, HIGH_APY_ANY_PAIR=1): entrada USDT→token0+token1 por rutas Uniswap v3 cotizadas y salida token0+token1→USDT
import { ethers } from "ethers";
import { Strategy } from "../server/strategy.mjs";
import { netOf, encodePath, pairSplit } from "../server/beefyclm.mjs";
import * as core from "../src/core.js";
import { chainByKey } from "../src/chains.js";
core.applyChain(chainByKey("bsc"));
process.env.HIGH_APY_ANY_PAIR = "1";
const N = netOf("bsc"); const S = N.stable;
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b));
// puros
ok(encodePath([S, N.wnative], [500]).length === 2 + 2 * (20 + 3 + 20), "ruta de un salto: 43 bytes");
const sp = pairSplit(30, 1 / 500, 1 / 75000, (1 / 75000) / (1 / 500)); // mismo valor en cada token
ok(near(sp.u0, 15) && near(sp.u1, 15), "reparto 50/50 por valor");
ok(pairSplit(30, 1, 1, 0).u0 === 30 && pairSplit(30, 1, 1, Infinity).u1 === 30, "solo token0 / solo token1");

const A = (n) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const RP = A(0x3001), CLM = A(0x3002), STRAT = A(0x3003), POOL = A(0x3004), ZEC = A(0x3005), BTCB = A(0x3006), FACT = A(0x3007);
const PX = { [ZEC.toLowerCase()]: 500, [BTCB.toLowerCase()]: 75000 };
const C = new ethers.Interface(["function wants() view returns (address,address)", "function strategy() view returns (address)", "function pool() view returns (address)", "function factory() view returns (address)",
  "function balances() view returns (uint256,uint256)", "function totalSupply() view returns (uint256)", "function previewDeposit(uint256,uint256) view returns (uint256,uint256,uint256,uint256,uint256)", "function deposit(uint256,uint256,uint256)", "function stake(uint256)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function earned(address) view returns (address[],uint256[])",
  "function withdraw(uint256)", "function previewWithdraw(uint256) view returns (uint256,uint256)", "function withdraw(uint256,uint256,uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const Q = new ethers.Interface(["function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)", "function exactInput((bytes,address,uint256,uint256)) payable returns (uint256)"]);
const me = ethers.Wallet.createRandom().address; const lc = (a) => a.toLowerCase();
const st = { eth: ethers.parseEther("0.01"), bal: {}, allow: {}, clm: { a0: 1000n * 10n ** 18n, a1: (1000n * 500n * 10n ** 18n) / 75000n, ts: 10n ** 24n } };
const B = (t) => st.bal[lc(t)] ?? 0n; const add = (t, v) => { st.bal[lc(t)] = B(t) + v; };
const sent = [];
const usd = (t) => (lc(t) === lc(S) ? 1 : PX[lc(t)]);
function swapOut(path, amtIn) {
  const hex = path.slice(2), tin = "0x" + hex.slice(0, 40), tout = "0x" + hex.slice(-40), fee = parseInt(hex.slice(40, 46), 16);
  if (hex.length !== 86 || fee !== 500) throw new Error("sin pool"); // solo pools directos de 0.05 %
  return BigInt(Math.floor(Number(amtIn) * usd(tin) / usd(tout) * 0.9995));
}
function exec(tx, write) {
  const to = lc(tx.to);
  if (to === lc(N.quoter)) { const [path, amt] = Q.parseTransaction({ data: tx.data }).args; return Q.encodeFunctionResult("quoteExactInput", [swapOut(path, amt), [], [], 0n]); }
  if (to === lc(N.router)) {
    const [path, rcpt, amt, min] = Q.parseTransaction({ data: tx.data }).args[0];
    const tin = "0x" + path.slice(2, 42), tout = "0x" + path.slice(-40);
    if ((st.allow[lc(tin) + lc(N.router)] ?? 0n) < amt) throw new Error("execution reverted: STF");
    const out = swapOut(path, amt); if (out < min) throw new Error("Too little received");
    if (write) { add(tin, -amt); add(tout, out); }
    return Q.encodeFunctionResult("exactInput", [out]);
  }
  const f = C.parseTransaction({ data: tx.data }); const r = (fn, v) => C.encodeFunctionResult(fn, v);
  if (f.name === "decimals") return r("decimals", [18]);
  if (f.name === "symbol") return r("symbol", [to === lc(ZEC) ? "ZEC" : to === lc(BTCB) ? "BTCB" : "USDT"]);
  if (f.name === "balanceOf") return r("balanceOf", [B(to)]);
  if (f.name === "allowance") return r("allowance", [st.allow[to + lc(f.args[1])] ?? 0n]);
  if (f.name === "approve") { if (write) st.allow[to + lc(f.args[0])] = f.args[1]; return r("approve", [true]); }
  if (to === lc(RP)) {
    if (f.name === "stake") { if (write) { add(CLM, -f.args[0]); add(RP, f.args[0]); } return "0x"; }
    if (f.name === "earned") return r("earned", [[], []]);
    if (f.name === "withdraw") { if (write) { add(RP, -f.args[0]); add(CLM, f.args[0]); } return "0x"; }
  }
  if (to === lc(CLM)) {
    const c = st.clm;
    if (f.name === "wants") return r("wants", [ZEC, BTCB]); if (f.name === "strategy") return r("strategy", [STRAT]);
    if (f.name === "balances") return r("balances", [c.a0, c.a1]); if (f.name === "totalSupply") return r("totalSupply", [c.ts]);
    if (f.name === "previewDeposit") { const [x0, x1] = f.args; const k0 = x0 * 10n ** 18n / c.a0, k1 = x1 * 10n ** 18n / c.a1, k = k0 < k1 ? k0 : k1; return r("previewDeposit", [k * c.ts / 10n ** 18n, k * c.a0 / 10n ** 18n, k * c.a1 / 10n ** 18n, 0n, 0n]); }
    if (f.name === "deposit") { const [x0, x1] = f.args; const k0 = x0 * 10n ** 18n / c.a0, k1 = x1 * 10n ** 18n / c.a1, k = k0 < k1 ? k0 : k1; const u0 = k * c.a0 / 10n ** 18n, u1 = k * c.a1 / 10n ** 18n, sh = k * c.ts / 10n ** 18n; if (write) { add(ZEC, -u0); add(BTCB, -u1); add(CLM, sh); c.a0 += u0; c.a1 += u1; c.ts += sh; } return "0x"; }
    if (f.name === "previewWithdraw") { const sh = f.args[0]; return r("previewWithdraw", [c.a0 * sh / c.ts, c.a1 * sh / c.ts]); }
    if (f.signature === "withdraw(uint256,uint256,uint256)") { const sh = f.args[0], o0 = c.a0 * sh / c.ts, o1 = c.a1 * sh / c.ts; if (write) { add(CLM, -sh); add(ZEC, o0); add(BTCB, o1); c.a0 -= o0; c.a1 -= o1; c.ts -= sh; } return "0x"; }
  }
  if (to === lc(STRAT)) return r("pool", [POOL]);
  if (to === lc(POOL)) return r("factory", [FACT]);
  throw new Error("sin respuesta " + to + " " + f.name);
}
const provider = { async getBalance() { return st.eth; }, async getFeeData() { return { maxFeePerGas: 10_000_000n }; }, async estimateGas(tx) { exec(tx, false); return 200_000n; }, async call(tx) { return exec(tx, false); }, async waitForTransaction() { return { status: 1, blockNumber: 1, gasUsed: 1n }; } };
const executor = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => { exec(tx, true); sent.push(tx); return { hash: "0x" + String(sent.length).padStart(64, "0") }; } }) };
globalThis.fetch = async (url) => ({ json: async () => String(url).endsWith("/gov-vaults") ? [{ id: "uniswap-cow-bsc-zec-btcb-rp", chain: "bsc", status: "active", earnContractAddress: RP, tokenAddress: CLM }] : [] });
const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
const logs = []; const diag = async (m) => logs.push(m);
Object.assign(process.env, { STRATEGY: "beefy-clm", STRATEGY_RUN: "par", STRATEGY_VAULT_ID: "uniswap-cow-bsc-zec-btcb-rp", STRATEGY_RESERVE_ETH: "0.0003" });
add(S, 30n * 10n ** 18n);
const s = new Strategy({ executor, provider, store, diag }); await s.init();
const { enterClm, exitClm } = await import("../server/beefyclm.mjs");
s.run = s.s.runs.par = { kind: "beefy-clm-dca", startedAt: 1, txs: [], status: "pendiente" };
s.dcaUsd = 30;
await enterClm(s, { ethUsd: 600 });
const r = s.run;
ok(r.noStable && B(RP) > 0n, `entrada en un par sin USDT: participaciones en el reward pool (${logs.at(-1)?.slice(0, 80)})`);
ok(B(S) === 0n, "se gastaron los 30 USDT");
const left = Number(B(ZEC)) / 1e18 * 500 + Number(B(BTCB)) / 1e18 * 75000;
ok(left < 0.1, `sobrante en la wallet < $0.10 (${left.toFixed(4)})`);
ok(r.txs.some((t) => /swap USDT→token0 \(500\)/.test(t.step)) && r.txs.some((t) => /swap USDT→token1 \(500\)/.test(t.step)), "swaps por la ruta directa de 0.05 % (la única con liquidez)");
// salida
s.run = s.s.runs["par-exit"] = { kind: "beefy-clm-exit", startedAt: 2, txs: [], status: "pendiente" };
await exitClm(s, { ethUsd: 600 });
const back = Number(B(S)) / 1e18;
ok(back > 29.9 && back < 30, `salida: ${back.toFixed(4)} USDT de vuelta (solo comisiones de swap)`);
ok(B(ZEC) < 10n ** 13n && B(BTCB) < 10n ** 11n, "salida: se vendieron los dos tokens");
console.log(fails ? `${fails} FALLAS` : "todo OK"); process.exit(fails ? 1 : 0);
