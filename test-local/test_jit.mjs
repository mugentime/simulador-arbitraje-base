// Prueba del modelo JIT con un pool v3 sintético (WBNB/USDT, ambos 18 decimales, precio 600 USDT/WBNB).
import { evaluateJit, buildUsdPrices } from "../server/jit.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const WBNB = { address: "0x" + "b".repeat(40), decimals: 18, sym: "WETH" }, USDT = { address: "0x" + "c".repeat(40), decimals: 18, sym: "USDT" };
const USDC = { address: "0x" + "a".repeat(40), decimals: 18, sym: "USDC" };
const price = 600; // token1 (USDT) por token0 (WBNB), mismos decimales
const sqrtP = Math.sqrt(price);
const pool = (fee, ts, L) => ({ kind: "v3", token0: WBNB, token1: USDT, feePips: BigInt(fee), tickSpacing: ts, sqrtPriceX96: BigInt(Math.round(sqrtP * 2 ** 96)), liquidity: BigInt(Math.round(L)), reserve0: BigInt(Math.round(L / sqrtP)), reserve1: BigInt(Math.round(L * sqrtP)) });
// precios: USDT vía pool USDT/USDC 1:1 profundo
const stable = { kind: "v2", token0: USDC, token1: USDT, reserve0: 10n ** 24n, reserve1: 10n ** 24n };
const p25 = pool(2500, 50, 2e22); // liquidez moderada
const prices = buildUsdPrices([stable, p25], { USDC, WETH: WBNB }, price);
ok(Math.abs(prices.get(USDT.address) - 1) < 1e-9, "USDT valorado a $1 vía pool estable");
const amt = BigInt(Math.round(50_000 / price * 1e18)); // víctima vende $50k de WBNB
const r = evaluateJit(p25, WBNB.address, amt, { prices, gasUsd: 0.05, borrowBps: 5 });
console.log(r);
ok(r && Math.abs(r.swapUsd - 50000) < 1, "tamaño del swap en USD");
ok(r.feeUsd <= 50000 * 0.0025 + 1e-6, "la comisión capturada no supera la comisión total de la víctima");
ok(r.invOptUsd >= 0, "a precio previo el inventario no pierde (la víctima paga el deslizamiento)");
ok(r.invUsd <= 0, "a precio posterior el inventario pierde (pérdida impermanente)");
ok(r.netUsd <= r.netOptUsd, "el neto conservador nunca supera al optimista");
// swap pequeño: el gas y el préstamo se lo comen
const small = evaluateJit(p25, WBNB.address, BigInt(Math.round(20 / price * 1e18)), { prices, gasUsd: 0.05, borrowBps: 5 });
ok(small.netUsd < 0, "swap de $20: neto negativo (" + small.netUsd.toFixed(4) + ")");
// sin precio conocido: no aplica
ok(evaluateJit(p25, WBNB.address, amt, { prices: new Map() }) === null, "sin precios no se evalúa");
// dirección contraria (compra WBNB con USDT)
const r2 = evaluateJit(p25, USDT.address, BigInt(50_000e18), { prices, gasUsd: 0.05 });
ok(r2 && r2.feeUsd > 0 && Math.abs(r2.swapUsd - 50000) < 1, "dirección USDT→WBNB también se evalúa");
