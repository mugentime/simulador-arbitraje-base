// Ciclos de 4 saltos y saltos repartidos entre dos pools del mismo par.
import fs from "node:fs";
import { ethers } from "ethers";
import * as core from "../src/core.js";
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const T = (sym, i) => ({ sym, address: "0x" + String(i).repeat(40).slice(0, 40), decimals: 18 });
const W = T("WETH", 1), U = T("USDC", 2), A = T("AAA", 3), B = T("BBB", 4);
const v2 = (addr, t0, t1, r0, r1, dex = "Uniswap v2") => ({ address: addr, kind: "v2", dex, token0: t0, token1: t1, reserve0: r0, reserve1: r1, feeBps: 30, feePips: 3000n });
const E = 10n ** 18n;
// cuadrado W→U→A→B→W (sin atajos de 2 o 3 saltos que cierren)
const pools = [v2("0xp1", W, U, 100n * E, 300000n * E), v2("0xp2", U, A, 300000n * E, 300000n * E), v2("0xp3", A, B, 300000n * E, 300000n * E), v2("0xp4", B, W, 300000n * E, 106n * E)];
let cyc = core.enumerateCycles(pools, ["WETH"], 4, 15000, 100);
ok(cyc.some((c) => c.route.length === 4), "encuentra el ciclo de 4 saltos");
ok(core.enumerateCycles(pools, ["WETH"], 3).every((c) => c.route.length <= 3), "con maxHops=3 no hay de 4");
// reparto: el mismo pool barato duplicado (dos pools idénticos) → repartir 50/50 debe dar más que uno solo
const a = v2("0xa1", W, U, 10n * E, 30000n * E), b = v2("0xa2", W, U, 10n * E, 30000n * E);
const sp = core.makeSplit(a, b, 5000);
const x = 2n * E;
ok(core.swapOut(sp, W.address, x) > core.swapOut(a, W.address, x), "repartir entre dos pools iguales reduce el deslizamiento");
ok(core.swapOut(sp, W.address, x) === core.swapOut(a, W.address, x / 2n) + core.swapOut(b, W.address, x - x / 2n), "reparto = suma de partes (resto a la última)");
ok(core.routePools([a, sp]).length === 3, "routePools cuenta las partes");
// evaluateAll mejora una ruta rentable con reparto cuando hay un segundo pool del mismo par
const cheap = v2("0x00000000000000000000000000000000000000c1", W, U, 20n * E, 66000n * E, "DEX barato"); // 3300 USDC/WETH: vende WETH caro aquí
const pricey = v2("0x00000000000000000000000000000000000000c2", W, U, 50n * E, 150000n * E, "DEX caro");  // 3000 USDC/WETH: compra WETH aquí
const twin = v2("0x00000000000000000000000000000000000000c3", W, U, 20n * E, 66000n * E, "DEX barato 2");
const lenders = [{ name: "Morpho Blue", ok: true, feeBps: 0n, liquidity: { WETH: 1000n * E } }];
const gas = { baseFee: 10n ** 7n, priority: 10n ** 6n, l1Fee: 0n };
const allPools = [cheap, pricey, twin];
const cycles = core.enumerateCycles(allPools, ["WETH"], 2);
const res = core.evaluateAll({ pools: allPools, cycles, lenders, gas, ethUsd: 3000 });
const best = res[0];
ok(best.profitable, "hay ruta rentable");
ok(best.split === true && best.route.some((p) => p.kind === "split"), "la mejor ruta usa un salto repartido");
ok(best.hops === 3, "gas cuenta 3 swaps (2 saltos, uno repartido en 2)");
// codificación del plan con el ABI del contrato nuevo
const ART = JSON.parse(fs.readFileSync(new URL("../server/artifacts/ArbExecutor.json", import.meta.url)));
const ex = Object.create(Executor.prototype); ex.iface = new ethers.Interface(ART.abi);
const plan = ex.buildPlan({ ...best, startTok: W }, [{ name: "Morpho Blue", address: "0x" + "9".repeat(40) }], 3000);
ok(plan && plan.hops.some((h) => h[0] === 5), "el plan lleva un salto SPLIT (kind 5)");
const data = ex.iface.encodeFunctionData("execute", [[plan.source, plan.lender, plan.token, plan.amount, plan.minProfit, plan.hops]]);
const dec = ex.iface.decodeFunctionData("execute", data)[0];
const h5 = dec[5].find((h) => Number(h[0]) === 5);
const [parts, bps] = ethers.AbiCoder.defaultAbiCoder().decode(["tuple(uint8,address,address,address,uint16,uint24,int24,bytes)[]", "uint16[]"], h5[7]);
ok(parts.length === 2 && Number(bps[0]) + Number(bps[1]) === 10000, "extra decodifica partes y bps que suman 10000");
