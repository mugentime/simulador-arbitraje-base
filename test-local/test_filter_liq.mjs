// Prueba local: filterPools exige liquidez mínima también en pools entre tokens no base y ajusta el mínimo de WETH por precio.
import assert from "node:assert";
import { filterPools } from "../src/core.js";

const T = (sym, address, decimals = 18) => ({ sym, address, decimals });
const W = T("WETH", "0x00000000000000000000000000000000000000a1"), U = T("USDC", "0x00000000000000000000000000000000000000b2", 6);
const X = T("USDT", "0x00000000000000000000000000000000000000c3", 6), Y = T("USDC.e", "0x00000000000000000000000000000000000000d4", 6), Z = T("TOK", "0x00000000000000000000000000000000000000e5");
const P = (a, t0, t1, r0, r1) => ({ address: a, token0: t0, token1: t1, reserve0: r0, reserve1: r1 });
const e18 = 10n ** 18n, e6 = 10n ** 6n;
const minLiq = { [W.address.toLowerCase()]: 5n * 10n ** 16n, [U.address.toLowerCase()]: 500n * e6 };
const pools = [
  P("0x01", W, U, 1000n * e18, 3_000_000n * e6),   // WETH = 3000 USDC → mínimo WETH = 500/3000 ≈ 0.1667
  P("0x02", X, U, 100_000n * e6, 100_000n * e6),   // USDT bueno, mínimo 500 USDT
  P("0x03", Y, U, 50_000n * e6, 50_000n * e6),     // USDC.e bueno
  P("0x04", X, Y, 10n * e6, 11n * e6),             // polvo entre dos buenos → fuera (fantasma)
  P("0x05", X, Y, 20_000n * e6, 20_000n * e6),     // líquido → dentro
  P("0x06", Z, W, 10n * e18, 1n * 10n ** 17n),     // 0.1 WETH < 0.1667 → fuera (antes entraba con 0.05)
  P("0x07", Z, W, 1000n * e18, 10n * e18),         // TOK bueno: 100 TOK por WETH → mínimo TOK ≈ 16.67
  P("0x08", Z, X, 5n * e18, 500n * e6),            // 5 TOK < 16.67 → fuera
  P("0x09", Z, X, 100n * e18, 3000n * e6),         // dentro
];
const kept = new Set(filterPools(pools, [W.address, U.address], minLiq).map((p) => p.address));
assert.deepStrictEqual([...kept].sort(), ["0x01", "0x02", "0x03", "0x05", "0x07", "0x09"]);
// sin pool WETH/USDC el mínimo de WETH queda en el piso
const k2 = new Set(filterPools(pools.filter((p) => p.address !== "0x01"), [W.address, U.address], minLiq).map((p) => p.address));
assert.ok(k2.has("0x06"), "sin precio, 0.1 WETH ≥ piso 0.05");
console.log("test_filter_liq OK");
