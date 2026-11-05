// beefy-clm con nodo simulado: resolución del vault, ETH→USDC, USDC→X en proporción, CLM no calm → reintento, depósito y vault; salida.
import { ethers } from "ethers";
import { Strategy, BASE } from "../server/strategy.mjs";
import { swapFraction, SLIP_ROUTERS } from "../server/beefyclm.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
// X vale 100 USDC (r = 0.01 X/USDC en crudo con mismos decimales), CLM con 50/50 en valor: balX=1, balU=100 → swap la mitad
ok(Math.abs(swapFraction(0.01, 1, 100) - 0.5) < 1e-9, "50/50 en valor → cambia la mitad");
ok(swapFraction(0.01, 0, 100) === 0 && swapFraction(0.01, 1, 0) === 1, "extremos");

const A = (n) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const VAULT = A(0x1001), CLM = A(0x1002), STRAT = A(0x1003), POOL = A(0x1004), X = A(0x1005);
const FACT = Object.keys(SLIP_ROUTERS)[2], ROUTER = SLIP_ROUTERS[FACT];
const C = new ethers.Interface(["function wants() view returns (address,address)", "function strategy() view returns (address)", "function pool() view returns (address)", "function factory() view returns (address)", "function tickSpacing() view returns (int24)", "function balances() view returns (uint256,uint256)", "function previewDeposit(uint256,uint256) view returns (uint256,uint256,uint256,uint256,uint256)", "function deposit(uint256,uint256,uint256)", "function previewWithdraw(uint256) view returns (uint256,uint256)", "function withdraw(uint256,uint256,uint256)", "function want() view returns (address)", "function deposit(uint256)", "function withdrawAll()", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)"]);
const U = new ethers.Interface(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)", "function multicall(bytes[]) payable returns (bytes[])"]);
const me = ethers.Wallet.createRandom().address;
const lc = (a) => a.toLowerCase();
const st = { eth: ethers.parseEther("0.01063"), bal: {}, allow: {}, calmFails: 2 };
const B = (t) => st.bal[lc(t)] ?? 0n; const add = (t, v) => { st.bal[lc(t)] = B(t) + v; };
const ETHUSD = 3300n;
const sent = [];
function exec(tx, write) {
  const to = lc(tx.to);
  if (to === lc(BASE.ROUTER)) {
    const f = U.parseTransaction({ data: tx.data, value: tx.value ?? 0n });
    if (f.name === "multicall") { if (write) { const p = U.parseTransaction({ data: f.args[0][0] }).args[0]; add(BASE.USDC, -p[4]); st.eth += p[4] * 10n ** 12n / ETHUSD; } return U.encodeFunctionResult("multicall", [[]]); }
    const p = f.args[0];
    if (lc(p[0]) === lc(BASE.WETH)) { const out = p[4] * ETHUSD / 10n ** 12n; if (write) add(BASE.USDC, out); return U.encodeFunctionResult("exactInputSingle", [out]); }
    const out = p[4] * 10n ** 12n / ETHUSD; return U.encodeFunctionResult("exactInputSingle", [out]);
  }
  const f = C.parseTransaction({ data: tx.data, value: tx.value ?? 0n }); const r = (fn, v) => C.encodeFunctionResult(fn, v);
  if (f.name === "balanceOf") return r("balanceOf", [B(to)]);
  if (f.name === "allowance") return r("allowance", [st.allow[to + lc(f.args[1])] ?? 0n]);
  if (f.name === "approve") { if (write) st.allow[to + lc(f.args[0])] = f.args[1]; return r("approve", [true]); }
  if (to === lc(VAULT)) { if (f.name === "want") return r("want", [CLM]); if (f.name === "deposit") { if (write) { add(CLM, -f.args[0]); add(VAULT, f.args[0]); } return "0x"; } if (f.name === "withdrawAll") { if (write) { add(CLM, B(VAULT)); st.bal[lc(VAULT)] = 0n; } return "0x"; } }
  if (to === lc(CLM)) {
    if (f.name === "wants") return r("wants", [BASE.USDC, X]); if (f.name === "strategy") return r("strategy", [STRAT]);
    if (f.name === "balances") return r("balances", [1_000_000_000n, 10n * 10n ** 18n]); // 1000 USDC y 10 X (X = $100) → 50/50
    if (f.name === "previewDeposit") return r("previewDeposit", [f.args[0] + f.args[1] / 10n ** 10n, f.args[0], f.args[1], 0n, 0n]);
    if (f.name === "deposit") { if (st.calmFails-- > 0) throw new Error("execution reverted: NotCalm"); if (write) { add(BASE.USDC, -f.args[0]); add(X, -f.args[1]); add(CLM, f.args[0] + f.args[1] / 10n ** 10n); } return "0x"; }
    if (f.name === "previewWithdraw") return r("previewWithdraw", [f.args[0] / 2n, f.args[0] / 2n * 10n ** 10n]);
    if (f.name === "withdraw") { if (write) { add(CLM, -f.args[0]); add(BASE.USDC, f.args[1]); add(X, f.args[2]); } return "0x"; }
  }
  if (to === lc(STRAT)) return r("pool", [POOL]);
  if (to === lc(POOL)) return f.name === "factory" ? r("factory", [ethers.getAddress(FACT)]) : r("tickSpacing", [100]);
  if (to === lc(ROUTER)) { const p = f.args[0]; const toX = lc(p[0]) === lc(BASE.USDC); const out = toX ? p[5] * 10n ** 12n / 100n : p[5] * 100n / 10n ** 12n; if (write) { add(p[0], -p[5]); add(p[1], out); } return r("exactInputSingle", [out]); }
  throw new Error("sin respuesta " + to + " " + f.name);
}
const provider = { async getBalance() { return st.eth; }, async getFeeData() { return { maxFeePerGas: 10_000_000n }; }, async estimateGas(tx) { exec(tx, false); return 200_000n; }, async call(tx) { return exec(tx, false); }, async waitForTransaction() { return { status: 1, blockNumber: 1, gasUsed: 1n }; } };
const executor = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => { exec(tx, true); st.eth -= (tx.value ?? 0n) + 2_000_000_000n; sent.push(tx.to); return { hash: "0x" + String(sent.length).padStart(64, "0") }; } }) };
globalThis.fetch = async () => ({ json: async () => [{ id: "aero-cow-base-usdc-nvdac-vault", chain: "base", status: "active", earnContractAddress: VAULT, tokenAddress: CLM }] });
const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
const logs = []; const diag = async (m) => logs.push(m);
process.env.STRATEGY = "beefy-clm"; process.env.STRATEGY_RUN = "c1";
const s = new Strategy({ executor, provider, store, diag }); await s.init();
await s.onBlock({ ethUsd: 3300 });
ok(mem.strategy.runs.c1.status === "pendiente" && mem.strategy.runs.c1.retries === 1, `CLM no calm → reintento (${mem.strategy.runs.c1.lastRetry?.slice(0, 50)})`);
const nBefore = sent.length;
s.retryAt = 0; await s.onBlock({ ethUsd: 3300 }); s.retryAt = 0; await s.onBlock({ ethUsd: 3300 });
const run = mem.strategy.runs.c1;
ok(run.status === "hecho", `estado ${run.status} ${run.error ?? ""}`);
ok(run.txs.filter((t) => t.step === "swap nativo→USDC").length === 1, "el swap ETH→USDC no se repite tras los reintentos");
ok(B(VAULT) > 0n && B(CLM) === 0n, `participaciones en el vault ${B(VAULT)}`);
ok(B(BASE.USDC) < 1_000_000n && B(X) < 10n ** 16n, `sobrante USDC ${B(BASE.USDC)} X ${B(X)}`);
ok(st.eth >= ethers.parseEther("0.002"), `reserva ${ethers.formatEther(st.eth)}`);
console.log(run.txs.map((t) => t.step).join(" → "));
process.env.STRATEGY = "beefy-clm-exit"; process.env.STRATEGY_RUN = "c2";
const e = new Strategy({ executor, provider, store, diag }); await e.init(); await e.onBlock({ ethUsd: 3300 });
const ex = mem.strategy.runs.c2;
ok(ex.status === "hecho" && B(VAULT) === 0n, `salida ${ex.status} ${ex.error ?? ""} · ETH ${ethers.formatEther(st.eth)}`);
console.log(ex.txs.map((t) => t.step).join(" → "));
console.log(fails ? `${fails} FALLAS` : "todo OK"); process.exit(fails ? 1 : 0);
