import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import { openSizing, token0Share, NLP } from "../server/neutrallp.mjs";
import { NLP2, NeutralLp2, openBorrows, xlendToRevertAmount, revertToXlendAmount, netExposure, closeSwap } from "../server/neutrallp2.mjs";
import { rangeTicks, amountsFor } from "../server/revertloan.mjs";
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
// tamaño espejo de la v1: $50, 78 % / 72.5 %
const o = openSizing(50, 0.78, 0.725);
near(o.V, 39 / (1 - 0.78 * 0.725)); near(o.F, 0.725 * o.V); near(o.A, 50 + o.F);
assert.ok(o.V / o.A <= 0.80, "la deuda cabe en el 80 % que XLend deja pedir contra USDC");
// préstamos en la proporción del rango: su valor suma V y el LP queda cubierto moneda por moneda
const eth = 1960, btc = 69000, px = eth / btc / 1e10, sqrtP = Math.sqrt(px), tick = Math.round(Math.log(px) / Math.log(1.0001));
const { lower, upper } = rangeTicks(tick, 2, 10);
const w0 = token0Share(sqrtP, lower, upper); assert.ok(w0 > 0.4 && w0 < 0.6, `w0 ${w0}`);
const b = openBorrows(o.V, eth, btc, w0);
near(Number(b.borrow0) / 1e18 * eth + Number(b.borrow1) / 1e8 * btc, o.V, 1e-4);
const L = Number(b.borrow0) / amountsFor(1, sqrtP, lower, upper).a0, am = amountsFor(L, sqrtP, lower, upper);
near(am.a1, Number(b.borrow1), 2e-3); // el cbBTC pedido es el que pide el rango para ese WETH
const n0 = netExposure({ x0: am.a0, x1: am.a1, d0: Number(b.borrow0), d1: Number(b.borrow1), eth, btc });
assert.ok(Math.abs(n0.eth) < 0.2 && Math.abs(n0.btc) < 0.2 && Math.abs(n0.sum) < 0.2, JSON.stringify(n0));
// en el borde superior del rango (WETH sube contra cbBTC) el LP es todo cbBTC: neto ETH −, neto BTC +, suma pequeña
const sqrtUp = Math.sqrt(1.0001 ** upper), amUp = amountsFor(L, sqrtUp, lower, upper), pxUp = sqrtUp * sqrtUp;
const nUp = netExposure({ x0: amUp.a0, x1: amUp.a1, d0: Number(b.borrow0), d1: Number(b.borrow1), eth: btc * pxUp * 1e10, btc });
assert.ok(nUp.eth < -40 && nUp.btc > 40 && Math.abs(nUp.sum) < 0.02 * o.V, JSON.stringify(nUp));
// saludes y traspasos (lt 0.85)
const x0 = { rColl: NLP.REVERT_CF * o.V, rDebt: o.F, xColl: o.A, xDebt: o.V, lt: 0.85 };
const hR = (x) => x.rColl / x.rDebt, hX = (x) => x.lt * x.xColl / x.xDebt;
near(hR(x0), 0.775 / 0.725); near(hX(x0), 0.85 / 0.78);
const d = { ...x0, rColl: x0.rColl * 0.96, xDebt: x0.xDebt * 0.96 }; assert.ok(hR(d) < 1.04);
const a1 = xlendToRevertAmount(d, 1.075, 1.06); assert.ok(a1 > 0);
const ad = { ...d, rDebt: d.rDebt - a1, xColl: d.xColl - a1 }; near(hR(ad), 1.075, 1e-9); assert.ok(hX(ad) >= 1.06 - 1e-9);
const u = { ...x0, rColl: x0.rColl * 1.05, xDebt: x0.xDebt * 1.05 }; assert.ok(hX(u) < 1.05);
const a2 = revertToXlendAmount(u, 1.09, 1.045); assert.ok(a2 > 0);
const au = { ...u, rDebt: u.rDebt + a2, xColl: u.xColl + a2 }; assert.ok(hX(au) > hX(u) && hX(au) <= 1.09 + 1e-9 && hR(au) >= 1.045 - 1e-9);
assert.equal(xlendToRevertAmount({ ...d, xColl: 1.06 * d.xDebt / 0.85 }, 1.075, 1.06), 0);
// swap de cierre: en el borde superior sobra cbBTC y falta WETH → vende cbBTC
const cs = closeSwap({ x0: amUp.a0, x1: amUp.a1, d0: Number(b.borrow0), d1: Number(b.borrow1), px: pxUp }, 80);
assert.equal(cs.sellToken0, false); assert.ok(cs.amountIn > 0n && cs.amountIn <= BigInt(Math.floor(amUp.a1 - Number(b.borrow1))) + 1n && cs.minOut > 0n);
const cs0 = closeSwap({ x0: 10, x1: 10, d0: 5, d1: 5, px: pxUp }); assert.equal(cs0.amountIn, 0n);
// el ABI del contrato acepta lo que arma el módulo
const ART = JSON.parse(fs.readFileSync(new URL("../server/artifacts/NeutralLpManagerV2.json", import.meta.url))), M = new ethers.Interface(ART.abi);
M.encodeFunctionData("open", [{ usdcIn: 50_000000n, borrow0: b.borrow0, borrow1: b.borrow1, tickLower: lower, tickUpper: upper, deadline: 1n }, 65_000000n]);
M.encodeFunctionData("recenter", [{ tokenId: 1n, tickLower: lower, tickUpper: upper, sellToken0: true, swapAmountIn: 1n, swapMinOut: 1n, deadline: 1n }, 1n]);
M.encodeFunctionData("deleverage", [{ tokenId: 1n, liquidity: 1n, withdrawUsdc: 1n, sellToken0: cs.sellToken0, swapAmountIn: cs.amountIn, swapMinOut: cs.minOut, close: true, deadline: 1n }, 1n]);
for (const [f, a] of [["xlendToRevert", [1n, 1n]], ["revertToXlend", [1n, 1n]], ["trimDebt", [NLP.CBBTC, 1n, 0n]], ["xlendWithdraw", [NLP.USDC, ethers.MaxUint256]], ["sweep", [NLP.USDC, 0n]]]) M.encodeFunctionData(f, a);
M.encodeDeploy([NLP.USDC, NLP.VAULT, NLP.NPM, NLP.MORPHO, NLP.ROUTER, NLP2.XPOOL, NLP.USDC, NLP.WETH, NLP.CBBTC, NLP.FEE, NLP2.DEBT_WETH, NLP2.DEBT_CBBTC]);
assert.ok((ART.bytecode.length - 2) / 2 < 24576);
// configuración: toma los umbrales de la v1 cuando no hay NLP2_*
Object.assign(process.env, { NLP_REVERT_TRIGGER: "1.04", NLP_COMET_TRIGGER: "1.05", NLP_EMERGENCY: "1.025", NLP_COMET_LTV: "0.78", NLP_REVERT_LTV: "0.725", NLP_REVERT_TARGET: "1.07", NLP2_OPEN: "t" });
const m = new NeutralLp2({ executor: null, provider: null, store: null, diag: async () => {} });
assert.deepEqual([m.cfg.a, m.cfg.r, m.cfg.revertTrigger, m.cfg.xlendTrigger, m.cfg.emergency, m.cfg.revertTarget, m.cfg.usd], [0.78, 0.725, 1.04, 1.05, 1.025, 1.07, 50]);
m.s = { tokenId: "1", recenters: 0, transfers: 0, deleverages: 0, entry: { usd: 50 }, last: { lp: 89.7, inRange: true, rDebt: 65.07, revert: 1.069, xColl: 115.07, d0: 0.0229, d1: 0.00065, debtUsd: 89.7, xlend: 1.09, rates: { weth: 0.505, btc: 0.127 }, net: n0, fees: 0.01, feeDays: 0.1, feeAprCap: 73, feeAprLp: 40, equity: 49.9, eth, btc } };
assert.match(m.line(), /^lp-neutral2: #1 · LP \$89\.70 en rango · Revert deuda \$65\.07 salud 1\.069 · XLend colateral \$115\.07 deuda .* WETH \+ .* cbBTC .* salud 1\.090 · tasas WETH 0\.51 % cbBTC 0\.13 % · neto ETH .* · comisiones por cobrar \$0\.010 en 2\.4 h = 73 % anual sobre el capital \(40 % sobre el LP\) · capital \$49\.90 \(inicio \$50, -0\.20 %\)/);
console.log("test_neutrallp2: ok", { V: o.V.toFixed(2), F: o.F.toFixed(2), A: o.A.toFixed(2), w0: w0.toFixed(3), borrow0: ethers.formatEther(b.borrow0), borrow1: ethers.formatUnits(b.borrow1, 8), down4: a1.toFixed(2), up5: a2.toFixed(2), netBorde: [nUp.eth.toFixed(1), nUp.btc.toFixed(1), nUp.sum.toFixed(2)] });
