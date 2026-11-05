// LpLending en BSC con un nodo simulado: descubre el mercado Smart Lending (API caída → LISTA_SMART_MARKETS),
// lee eventos Borrow/SupplyCollateral/Liquidate, mide la salud y abre un episodio para la posición liquidable.
import { ethers } from "ethers";
import * as core from "../src/core.js";
import { chainByKey } from "../src/chains.js";
import { LpLending, MOOLAH_BSC } from "../server/lplending.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };

core.applyChain(chainByKey("bsc"));
const ID = "0x" + "ab".repeat(32);
const LOAN = "0x55d398326f99059fF775485246999027B3197955", COL = "0x627B5567458A76e6B6a6a6BBe3FcFF7f81821a58";
const ORACLE = "0xcC93CB664Ed2aBf4f428440a7868FdC3C30E5a1b", DEX = "0xd77e86779022227226377dc30d03cf1c78439acf".toLowerCase(), IRM = "0x5F9f9173B405C6CEAfa7f98d09e4B8447e9797E6";
const C0 = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", C1 = LOAN;
const U1 = "0x1111111111111111111111111111111111111111", U2 = "0x2222222222222222222222222222222222222222", LQ = "0x3333333333333333333333333333333333333333";
process.env.LISTA_SMART_MARKETS = ID; process.env.LISTA_API = "http://127.0.0.1:9"; // API inalcanzable

const I = new ethers.Interface([
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function getPrice((address,address,address,address,uint256)) view returns (uint256)",
  "function getLiquidationWhitelist(bytes32) view returns (address[])",
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
  "function TOKEN() view returns (address)", "function dex() view returns (address)", "function coins(uint256) view returns (address)",
  "function get_virtual_price() view returns (uint256)", "function fee() view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
]);
const M3 = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"]);
const E18 = 10n ** 18n;
let vp = E18;
const pos = { [U1.toLowerCase()]: [0n, 950n * E18, 1000n * E18], [U2.toLowerCase()]: [0n, 975n * E18, 1000n * E18] }; // shares = assets (1:1)
function answer(to, data) {
  const f = I.parseTransaction({ data }); const t = to.toLowerCase(); const r = (v) => I.encodeFunctionResult(f.name, v);
  if (t === MOOLAH_BSC.toLowerCase()) {
    if (f.name === "idToMarketParams") return r([LOAN, COL, ORACLE, IRM, 965n * 10n ** 15n]);
    if (f.name === "market") return r([5000n * E18, 5000n * E18, 1925n * E18, 1925n * E18, 1n, 0n]);
    if (f.name === "getPrice") return r([10n ** 36n]);
    if (f.name === "position") return r(pos[f.args[1].toLowerCase()] ?? [0n, 0n, 0n]);
    if (f.name === "getLiquidationWhitelist") return r([[]]);
  }
  if (t === ORACLE.toLowerCase()) { if (f.name === "TOKEN") return r([COL]); if (f.name === "dex") return r([DEX]); }
  if (t === DEX) { if (f.name === "coins") return r([f.args[0] === 0n ? C0 : C1]); if (f.name === "fee") return r([1_000_000n]); if (f.name === "get_virtual_price") return r([vp]); }
  if (t === IRM.toLowerCase() && f.name === "borrowRateView") return r([BigInt(Math.round(0.03 / 31_536_000 * 1e18))]);
  if (f.name === "symbol") return r([t === C0.toLowerCase() ? "USDC" : "USDT"]);
  if (f.name === "decimals") return r([18]);
  throw new Error("sin respuesta " + f.name);
}
const provider = { async call({ to, data }) {
  if (to !== core.MULTICALL3) throw new Error("solo multicall");
  const [calls] = M3.decodeFunctionData("aggregate3", data);
  return M3.encodeFunctionResult("aggregate3", [calls.map((c) => { try { return [true, answer(c.target, c.callData)]; } catch { return [false, "0x"]; } })]);
} };
const ev = (name, args, block) => { const e = I.encodeEventLog(I.getEvent(name), args); return { ...e, blockNumber: block, transactionHash: "0x" + block.toString(16).padStart(64, "0") }; };
const logsProvider = { async getLogs({ fromBlock, toBlock, topics }) {
  ok(topics[1][0] === ID, `getLogs filtra por id de mercado (${fromBlock}–${toBlock})`);
  const all = [ev("SupplyCollateral", [ID, ORACLE, U1, 1000n * E18], 990), ev("Borrow", [ID, ORACLE, U2, U2, 975n * E18, 975n * E18], 995), ev("Liquidate", [ID, LQ, U2, 10n * E18, 10n * E18, 10n * E18, 0n, 0n], 998)];
  return all.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
} };
const mem = new Map(); const store = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } };
const diags = []; const diag = async (m) => { diags.push(m); };

process.env.LPL_BACKFILL_BLOCKS = "50";
const lp = new LpLending({ provider, logsProvider, store, diag });
await lp.init();
await lp.onBlock({ block: 1000, ts: 1_000_000, ethUsd: 600 });
const L = lp.s.lista;
ok(!lp.s.lastError, `sin error (${lp.s.lastError ?? "—"})`);
ok(L.markets.length === 1 && L.markets[0].coinSymbols.join("-") === "USDC-USDT", `mercado: ${L.markets[0]?.label}`);
ok(L.markets[0].poolFeeBps === 1, "comisión del pool 1e6/1e10 → 1 bps");
ok(lp.borrowers.size === 2, `prestatarios descubiertos por eventos: ${lp.borrowers.size}`);
ok(L.seenCount === 1 && L.seen[0].liquidator === LQ, "liquidación ajena registrada");
ok(L.positions === 2 && L.liquidatable === 1 && L.candidates[0].user === U2, `liquidables ${L.liquidatable} (HF mín ${L.minHf?.toFixed(4)})`);
ok(Math.abs(L.markets[0].borrowApy - Math.expm1(0.03)) < 1e-6, `tasa de préstamo ${(L.markets[0].borrowApy * 100).toFixed(2)} %`);
ok(L.markets[0].lpApr === null, "APR del LP sin dato hasta tener 6 h de virtual price");
ok(diags.some((d) => d.includes("posición liquidable")) && lp.s.opportunities === 1, "episodio abierto y anunciado");
// 7 h después, vp +0.007 % → APR ≈ 0.07 %·(24/7)·365… y aparece la tabla de apalancamiento
vp = E18 + 7n * 10n ** 13n;
await lp.onBlock({ block: 1300, ts: 1_000_000 + 7 * 3600, ethUsd: 600 });
const m = lp.s.lista.markets[0];
ok(m.lpApr > 0.08 && m.lpApr < 0.09, `APR del LP por virtual price ${(m.lpApr * 100).toFixed(2)} %`);
ok(m.leverage && m.leverage.lMaxSafe > 18 && m.leverage.rows.length >= 5, `tabla de apalancamiento hasta ${m.leverage?.lMaxSafe.toFixed(1)}x`);
ok(lp.s.opportunities === 1, "el mismo episodio no se cuenta dos veces");
ok(/Lista 1 mercados/.test(lp.line()), lp.line().slice(0, 160));
process.exit(fails ? 1 : 0);
