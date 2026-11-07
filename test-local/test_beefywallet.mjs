// Beefy wallet: monto subyacente por tipo de vault y neto depositado por vault desde el historial
import { underlyingAmount, netDepositsByVault, priceFromSqrtX96, clmValueFromPool } from "../server/beefywallet.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const E18 = 10n ** 18n;
ok(Math.abs(underlyingAmount({ type: "standard", shares: 2n * E18, ppfs: 15n * E18 / 10n }) - 3) < 1e-12, "standard: 2 acciones × 1.5 = 3");
ok(Math.abs(underlyingAmount({ type: "standard", shares: 2n * E18, ppfs: 15n * 10n ** 5n, tokenDecimals: 6 }) - 3) < 1e-12, "standard con subyacente de 6 decimales");
ok(underlyingAmount({ type: "gov", shares: 5n * E18 }) === 5, "reward pool: 1 a 1");
const n = netDepositsByVault([{ product_key: "beefy:vault:base:x-vault", usd_diff: 10, display_name: "X", datetime: "2026-11-01" }, { product_key: "beefy:vault:base:x-vault", usd_diff: -3 }, { product_key: "beefy:vault:base:y", usd_diff: "4.5" }]);
ok(n["x-vault"].netUsd === 7 && n["x-vault"].txs === 2 && n.y.netUsd === 4.5, "neto depositado por vault");
// precio desde sqrtPriceX96: pool USDC(6)/cbBTC(8) con cbBTC a $76,000 → token1 por token0 = 1/76000 cbBTC por USDC
const sq = (p1in0Raw) => BigInt(Math.round(Math.sqrt(p1in0Raw) * 2 ** 96));
const pBtc = priceFromSqrtX96(sq((1 / 76000) * 10 ** 8 / 10 ** 6), 6, 8);
ok(Math.abs(1 / pBtc - 76000) / 76000 < 1e-9, "sqrtPriceX96 → cbBTC $76,000 (USDC token0, 6 vs 8 decimales)");
// ZEC(18)/USDT(18) con ZEC token0 a $41.5 → USDT por ZEC = 41.5
const pZec = priceFromSqrtX96(sq(41.5), 18, 18);
ok(Math.abs(pZec - 41.5) < 1e-9, "sqrtPriceX96 → ZEC $41.5 (ZEC token0)");
const v = clmValueFromPool({ shares: 10n, totalSupply: 100n, amount0: 2n * E18, amount1: 17n * E18, dec0: 18, dec1: 18, sym0: "ZEC", sym1: "USDT", sqrtPriceX96: sq(41.5) });
ok(v && v.symbol === "ZEC" && Math.abs(v.price - 41.5) < 1e-9 && Math.abs(v.valueUsd - (2 * 41.5 + 17) / 10) < 1e-9, "valor CLM = fracción × (ZEC×precio + USDT)");
const w = clmValueFromPool({ shares: 1n, totalSupply: 4n, amount0: 400_000_000n, amount1: 1_000_000n, dec0: 6, dec1: 8, sym0: "USDC", sym1: "cbBTC", sqrtPriceX96: sq((1 / 76000) * 10 ** 8 / 10 ** 6) });
ok(w && w.symbol === "cbBTC" && Math.abs(w.price - 76000) < 1e-6 && Math.abs(w.valueUsd - (400 + 0.01 * 76000) / 4) < 1e-6, "valor CLM USDC/cbBTC");
ok(clmValueFromPool({ shares: 1n, totalSupply: 2n, amount0: 1n, amount1: 1n, dec0: 18, dec1: 18, sym0: "WETH", sym1: "VVV", sqrtPriceX96: sq(1) }) === null, "sin lado estable → null (se usa Beefy)");
process.exit(fails ? 1 : 0);
