// Estrategia revert-usdc con nodo simulado: entrada (swap → approve → deposit), reserva de gas, idempotencia y salida.
import { ethers } from "ethers";
import { Strategy, BASE, spendable, minOut } from "../server/strategy.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const E = (x) => ethers.parseEther(x);
ok(spendable(E("0.01063"), E("0.002"), E("0.0002")) === E("0.00843"), "usa saldo − reserva − colchón");
ok(spendable(E("0.001"), E("0.002"), 0n) === 0n, "nunca negativo");
ok(minOut(1000n, 50, 1000n) === 995n, "min out con 0.5 %");
let threw = false; try { minOut(900n, 50, 1000n); } catch { threw = true; } ok(threw, "rechaza cotización >2 % peor que la referencia");

const I = new ethers.Interface(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function asset() view returns (address)", "function deposit(uint256,address) returns (uint256)", "function redeem(uint256,address,address) returns (uint256)", "function maxDeposit(address) view returns (uint256)", "function multicall(bytes[]) payable returns (bytes[])"]);
const me = ethers.Wallet.createRandom().address;
const st = { eth: E("0.01063"), usdc: 0n, allow: { vault: 0n, router: 0n }, shares: 0n };
const ETHUSD = 3300;
const quote = (wei) => wei * BigInt(ETHUSD * 1e6) / 10n ** 18n;
const sent = [];
const provider = {
  async getBalance() { return st.eth; },
  async getFeeData() { return { maxFeePerGas: 10_000_000n }; },
  async estimateGas() { return 150_000n; },
  async call(tx) {
    const f = I.parseTransaction({ data: tx.data, value: tx.value ?? 0n }); const to = tx.to.toLowerCase();
    const r = (v) => I.encodeFunctionResult(f.name, v);
    if (f.name === "asset") return r([BASE.USDC]);
    if (f.name === "balanceOf") return r([to === BASE.USDC.toLowerCase() ? st.usdc : st.shares]);
    if (f.name === "allowance") return r([f.args[1].toLowerCase() === BASE.VAULT.toLowerCase() ? st.allow.vault : st.allow.router]);
    if (f.name === "maxDeposit") return r([10n ** 30n]);
    if (f.name === "exactInputSingle") return r([quote(f.args[0][4])]);
    if (f.name === "deposit") { if (st.allow.vault < f.args[0]) throw new Error("execution reverted: allowance"); return r([f.args[0]]); }
    if (f.name === "approve") return r([true]);
    if (f.name === "redeem") return r([f.args[0]]);
    if (f.name === "multicall") return r([[]]);
    throw new Error("sin respuesta " + f.name);
  },
  async waitForTransaction(h) { return { status: 1, blockNumber: 1, gasUsed: 100000n }; },
};
const apply = (tx) => {
  const f = I.parseTransaction({ data: tx.data, value: tx.value ?? 0n });
  st.eth -= (tx.value ?? 0n) + 1_000_000_000n;
  if (f.name === "exactInputSingle") st.usdc += quote(tx.value);
  if (f.name === "approve") st.allow.vault = f.args[1];
  if (f.name === "deposit") { st.usdc -= f.args[0]; st.shares += f.args[0]; }
  sent.push(f.name); return { hash: "0x" + String(sent.length).padStart(64, "0") };
};
const executor = { wallet: { address: me }, mode: "live", withSender: async (fn) => fn({ sendTransaction: async (tx) => apply(tx) }) };
const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
const logs = []; const diag = async (m) => logs.push(m);
process.env.STRATEGY = "revert-usdc"; process.env.STRATEGY_RUN = "t1";
const s = new Strategy({ executor, provider, store, diag }); await s.init();
await s.onBlock({ ethUsd: ETHUSD });
ok(sent.join(",") === "exactInputSingle,approve,deposit", `secuencia ${sent.join(",")}`);
ok(mem.strategy.runs.t1.status === "hecho", `estado ${mem.strategy.runs.t1.status} ${mem.strategy.runs.t1.error ?? ""}`);
ok(st.eth >= E("0.002"), `reserva respetada (${ethers.formatEther(st.eth)} ETH)`);
ok(st.shares === quote(E("0.00843")) && st.usdc === 0n, `depositado ${ethers.formatUnits(st.shares, 6)} USDC`);
ok(mem.strategy.runs.t1.txs.length === 3, "3 hashes registrados");
const s2 = new Strategy({ executor, provider, store, diag }); await s2.init(); await s2.onBlock({ ethUsd: ETHUSD });
ok(sent.length === 3, "misma etiqueta tras reinicio: no repite");
// referencia mala → no envía
st.eth = E("0.01"); sent.length = 0; process.env.STRATEGY_RUN = "t2";
const s3 = new Strategy({ executor, provider, store, diag }); await s3.init(); await s3.onBlock({ ethUsd: 4000 });
ok(sent.length === 0 && mem.strategy.runs.t2.status === "error", `precio >2 % peor que la referencia: no envía (${mem.strategy.runs.t2.error})`);
console.log(fails ? `${fails} FALLAS` : "todo OK"); process.exit(fails ? 1 : 0);
