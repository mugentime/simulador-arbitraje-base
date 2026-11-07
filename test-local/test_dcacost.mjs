// Costo del DCA: flujos de la wallet en recibos, clasificación, costo promedio, precio medio DCA, desglose y reporte con un provider simulado
import { ethers } from "ethers";
import { walletFlows, classify, ledger, dcaAvgPrice, breakdown, dcaCostReport, accrueFees, backfillFees, strategyPnl } from "../server/dcacost.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b));
const T = ethers.id("Transfer(address,address,uint256)");
const pad = (a) => ethers.zeroPadValue(a, 32);
const ME = "0x327526EC22821c0667d4A02FaEe50794281b965d", X = "0x1111111111111111111111111111111111111111", S = "0x2222222222222222222222222222222222222222", POOL = "0x3333333333333333333333333333333333333333", CLM = "0x4444444444444444444444444444444444444444", RP = "0x5555555555555555555555555555555555555555";
const tr = (token, from, to, v) => ({ address: token, topics: [T, pad(from), pad(to)], data: ethers.toBeHex(v, 32) });

// walletFlows
const fl = walletFlows([tr(S, ME, POOL, 10n * 10n ** 18n), tr(X, POOL, ME, 7n * 10n ** 15n), tr(X, POOL, CLM, 5n)], ME, [X, S]);
ok(fl[S.toLowerCase()] === -(10n ** 19n) && fl[X.toLowerCase()] === 7n * 10n ** 15n, "flujos: sale estable, entra X; ignora transferencias ajenas");

// classify
ok(classify("swap USDT→X", 0.0075, -10) === "compra", "swap estable→X = compra");
ok(classify("swap X→USDC", -0.00001, 0.75) === "venta", "swap X→estable = venta");
ok(classify("deposit CLM", -0.0038, 0) === "deposito", "deposit CLM = depósito");
ok(classify("approve token0→CLM", 0, 0) === null && classify("stake reward pool Beefy", 0, 0) === null, "approve/stake se ignoran");
ok(classify("swap nativo→USDC", 0, 10) === null && classify("swap ETH→USDC", 0, 10) === null, "nativo→estable no es compra de X");
ok(classify("withdraw CLM", 0.01, 5) === "retiro", "withdraw CLM = retiro");

// ledger: caso tipo ZEC (dep. 1 compra $10 a $1300, CLM toma la mitad, barrido deposita el resto; dep. 2 compra $19.52 a $1327.5)
const P1 = 1300, P2 = 1327.5;
const L = ledger([
  { type: "compra", x: 10 / P1, s: 10 }, { type: "deposito", x: 5.05 / P1, s: 0 },
  { type: "deposito", x: 4.95 / P1, s: 0 },
  { type: "compra", x: 19.52 / P2, s: 19.52 }, { type: "deposito", x: 19.52 / P2, s: 0 },
]);
ok(near(L.xIn, 10 / P1 + 19.52 / P2) && near(L.xCost, 29.52) && L.q < 1e-12, "todo el X comprado entró al vault con su costo");
const avg = L.xCost / L.xIn;
ok(near(avg, 29.52 / (10 / P1 + 19.52 / P2)), "precio medio = costo / unidades");
ok(avg > P1 && avg < P2, "precio medio entre los dos precios de compra");
// venta parcial a costo promedio
const L2 = ledger([{ type: "compra", x: 2, s: 200 }, { type: "venta", x: 1, s: 120 }, { type: "deposito", x: 1, s: 50 }]);
ok(near(L2.xCost, 100) && near(L2.sIn, 50) && L2.q === 0, "venta descuenta el inventario a costo promedio");
// depósito pagado con recompensas: no es capital invertido
const L3 = ledger([{ type: "ingresoX", x: 0.1, s: 0 }, { type: "deposito", x: 0.1, s: 1, reward: true }]);
ok(L3.xIn === 0 && L3.sIn === 0 && near(L3.rewardX, 0.1) && near(L3.rewardS, 1), "composición de recompensas no suma a lo invertido");
// retiro: el costo sale del vault con el X
const L4 = ledger([{ type: "compra", x: 1, s: 100 }, { type: "deposito", x: 1, s: 0 }, { type: "retiro", x: 0.5, s: 10 }, { type: "venta", x: 0.5, s: 60 }]);
ok(near(L4.xIn, 0.5) && near(L4.xCost, 50) && L4.q === 0, "retiro devuelve X a la wallet con su costo");

// precio medio DCA puro
const d = dcaAvgPrice([{ usd: 10, price: 100 }, { usd: 10, price: 200 }, { usd: 10, price: null }]);
ok(near(d.price, 20 / (0.1 + 0.05)) && d.missing === 1, "precio medio DCA = media armónica ponderada");

// desglose: PnL = precio + comisiones + rango/IL
const b = breakdown({ L: { sIn: 10, xIn: 0.02, xCost: 26 }, prior: 4, price: 1200, valueUsd: 37.5, rewardsUsd: 0.3 });
ok(near(b.invested, 40) && near(b.hodl, 38) && near(b.priceEffect, -2) && near(b.rangeIl, -0.5) && near(b.pnl, -2.2), "desglose de PnL");
ok(near(b.priceEffect + b.fees + b.rangeIl, b.pnl), "la suma del desglose cuadra con el PnL");

// reporte con provider simulado: CLM ZEC(18, token0)/USDT(18, token1), ZEC a $1,277.69
const I = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function balances() view returns (uint256, uint256)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function earned(address) view returns (address[], uint256[])"]);
const E = 10n ** 18n, P = 1277.69;
const sqrt = BigInt(Math.round(Math.sqrt(P) * 2 ** 96));
const ans = (to, data) => {
  const f = I.parseTransaction({ data }).name, t = to.toLowerCase();
  const r = { decimals: [18], symbol: [t === X.toLowerCase() ? "ZEC" : "USDT"], slot0: [sqrt, 0], totalSupply: [100n * E], balances: [1n * E, 1000n * E],
    balanceOf: [t === RP.toLowerCase() ? 10n * E : 0n], earned: [[S], [E / 10n]] }[f];
  return I.encodeFunctionResult(f, r);
};
const rcs = {
  "0xa1": [tr(S, ME, POOL, 10n * E), tr(X, POOL, ME, BigInt(Math.round(10 / 1300 * 1e18)))],
  "0xa2": [tr(X, ME, CLM, BigInt(Math.round(10 / 1300 * 1e18)))],
  "0xb1": [tr(S, ME, POOL, 20n * E), tr(X, POOL, ME, BigInt(Math.round(20 / 1327.5 * 1e18)))],
  "0xb2": [tr(X, ME, CLM, BigInt(Math.round(20 / 1327.5 * 1e18)))],
};
const store = { m: {}, async get(k) { return this.m[k]; }, async set(k, v) { this.m[k] = v; } };
const meta = { vaultId: "zec-rp", vault: RP, gov: true, clm: CLM, x: X, usdcIs0: false, pool: POOL, status: "hecho" };
const s = {
  me: ME, store, net: { beefy: "bsc", stable: S, stableSym: "USDT", stableDec: 18, wnative: "0x6666666666666666666666666666666666666666" },
  provider: { call: async ({ to, data }) => ans(to, data), getTransactionReceipt: async (h) => ({ logs: rcs[h] }) },
  s: { runs: {
    "dca#1": { ...meta, startedAt: 1, usdcIn: String(10n * E), ratio: { rate: 1 / 1300 }, txs: [{ step: "approve swap USDT→X", hash: "0xa0" }, { step: "swap USDT→X", hash: "0xa1" }, { step: "deposit CLM", hash: "0xa2" }] },
    "dca#2": { ...meta, startedAt: 2, usdcIn: String(20n * E), ratio: { rate: 1 / 1327.5 }, txs: [{ step: "swap USDT→X", hash: "0xb1" }, { step: "deposit CLM", hash: "0xb2" }] },
  } },
};
rcs["0xa0"] = [];
const lines = await dcaCostReport(s);
console.log(lines.join("\n"));
const units = 10 / 1300 + 20 / 1327.5, avgP = 30 / units;
ok(lines.length === 2 && lines[1].startsWith("dca estrategia bsc") && lines[0].includes("2 depósitos DCA ($30.00)"), "reporte: 2 depósitos de $30");
const dcaP = 30 / (10 / 1300 + 20 / 1327.5);
ok(lines[0].includes(`precio medio de entrada DCA $${dcaP.toLocaleString("en-US", { maximumFractionDigits: 2 })}`), `reporte: precio medio de entrada ${dcaP.toFixed(2)}`);
ok(lines[0].includes("invertido $30.00"), "reporte: invertido $30");
// valor: 10 % del CLM = 0.1 ZEC + 100 USDT
ok(lines[0].includes(`valor $${(0.1 * P + 100).toFixed(2)}`) && lines[0].includes("recompensas $0.10"), "reporte: valor del CLM y recompensas");
ok(store.m.dcaCostRc && store.m.dcaCostRc["0xb1"], "recibos en caché");
// comisiones estimadas
const a = accrueFees({ at: 0, usd: 0 }, { now: 3600_000, valueUsd: 100, apy: 3.65 });
ok(near(a.usd, 100 * (Math.pow(4.65, 1 / 8760) - 1), 1e-6), "comisiones de 1 h a APY 365 %");
ok(accrueFees({ at: 0, usd: 1 }, { now: 10 * 3600_000, valueUsd: 100, apy: 3.65 }).usd < 1 + 100 * (Math.pow(4.65, 3 / 8760) - 1), "máx. 2 h por lectura (huecos no inflan)");
const bf = backfillFees([{ at: "2026-11-07T00:00:00Z", positions: [{ id: "v", valueUsd: 30, apyPct: 1000 }] }, { at: "2026-11-07T01:00:00Z", positions: [{ id: "v", valueUsd: 30, apyPct: 1000 }] }, { at: "2026-11-07T02:00:00Z", positions: [{ id: "w", valueUsd: 9 }] }], "v");
ok(bf && bf.since === "2026-11-07T00:00:00.000Z" && near(bf.usd, 30 * (Math.pow(11, 1 / 8760) - 1), 1e-5), "relleno desde la serie horaria");
// PnL de la estrategia con depósitos diarios y cambio de vault (A sale, su capital entra a B)
const day = 86400_000, T0 = Date.parse("2026-11-01T00:00:00Z");
const LA = ledger([{ type: "compra", x: 0.01, s: 10 }, { type: "deposito", x: 0.01, s: 10 }, { type: "compra", x: 0.01, s: 10 }, { type: "deposito", x: 0.01, s: 0 }, { type: "retiro", x: 0.02, s: 9 }, { type: "venta", x: 0.02, s: 19 }]);
const LB = ledger([{ type: "deposito", x: 0, s: 28 }, { type: "deposito", x: 0, s: 10 }]);
const st = strategyPnl([
  { newMoney: 30, L: LA, valueUsd: 0, rewardsUsd: 0, feesUsd: 0.5, price: 1000, deps: [{ at: T0, usd: 20 }, { at: T0 + day, usd: 10 }] },
  { newMoney: 10, L: LB, valueUsd: 38.4, rewardsUsd: 0.1, feesUsd: 0.2, price: 1, deps: [{ at: T0 + 2 * day, usd: 10 }] },
], [{ at: new Date(T0).toISOString(), usd: 5 }], T0 + 3 * day);
// aportado 45; estable sobrante = (30−20+19−20+9) + (10−0+0−38+0) = 18 − 28 = −10 → 0 (los 28 de B vienen de A); valor 38.4+0.1
ok(near(st.aportado, 45) && near(st.sobranteS, 0) && near(st.valor, 38.5) && near(st.pnl, -6.5), "estrategia: aportado, valor y PnL con cambio de vault");
ok(near(st.capDias, 5 * 3 + 20 * 3 + 10 * 2 + 10 * 1) && near(st.anualPct, -6.5 / 105 * 365 * 100) && near(st.diarioPct, -6.5 / 105 * 100), "capital-día y rendimiento anualizado ponderan cada depósito por sus días");
ok(near(st.comisiones, 0.7) && near(st.precio, -7.2), "desglose comisiones / precio");
// estable depositado de más (ya estaba en la wallet) cuenta como aportado
const st2 = strategyPnl([{ newMoney: 20, L: ledger([{ type: "deposito", x: 0, s: 26.12 }]), valueUsd: 26.1, rewardsUsd: 0, feesUsd: 0, price: 1, deps: [{ at: T0, usd: 10 }, { at: T0 + day, usd: 10 }] }], [{ at: new Date(T0).toISOString(), usd: 4.75 }], T0 + 2 * day);
ok(near(st2.aportado, 30.87) && near(st2.extra, 6.12) && near(st2.pnl, 26.1 - 30.87), "estable extra de la wallet suma al aportado");
console.log(fails ? `${fails} FALLAS` : "todo OK"); process.exit(fails ? 1 : 0);
