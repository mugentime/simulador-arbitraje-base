// Prueba local: exclusión de pares, pares de una ruta y tabla/puntuación por par.
import assert from "node:assert";
import * as core from "../src/core.js";
import { CHAINS } from "../src/chains.js";
import { excludedSet, isExcludedPool, pairsOfLabel, bumpPairs, pairTable, pairLine } from "../src/pairs.js";

const T = (sym, address, label) => ({ sym, address, decimals: 18, label });
const W = T("WETH", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "WPOL"), U = T("USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USDC"), L = T("LINK", "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39");
const pool = (a, t0, t1) => ({ address: a, token0: t0, token1: t1, reserve0: 10n ** 20n, reserve1: 10n ** 20n });
const pools = [pool("0xA1", W, U), pool("0xA2", W, U), pool("0xB1", W, L), pool("0xB2", L, W), pool("0xC1", L, U)];

const ex = excludedSet(["LINK/WPOL"]);
assert.ok(isExcludedPool(pools[2], ex) && isExcludedPool(pools[3], ex), "excluye por etiqueta en cualquier orden");
assert.ok(!isExcludedPool(pools[0], ex) && !isExcludedPool(pools[4], ex));
assert.ok(isExcludedPool(pools[4], excludedSet([[U.address, L.address]])), "excluye por direcciones");
assert.ok(isExcludedPool(pools[0], excludedSet(["usdc/weth"])), "excluye por símbolo de rol");

assert.deepStrictEqual(pairsOfLabel("WETH → Uniswap v3 → USDC → QuickSwap v2 → LINK → Uniswap v3 → WETH").sort(), ["LINK/USDC", "LINK/WETH", "USDC/WETH"]);
const byPair = {};
bumpPairs(byPair, "WETH → Uniswap v3 → LINK → Uniswap v3 → WETH", "ok");
bumpPairs(byPair, "WETH → Uniswap v3 → LINK → Uniswap v3 → WETH", "rev", 3);
assert.deepStrictEqual(byPair["LINK/WETH"], { ok: 1, rev: 3, conf: 0, sentRev: 0 });

const disloc = { pairs: { x: { label: "WETH/USDC", episodes: 10, blocks: 100, dislocBlocks: 9, peakExcess: 4.2 } } };
const byRoute = { "0xw:0xB1>0xB2": { episodes: 5, netUsd: 0.5 } };
const rows = pairTable({ pools, disloc, byRoute, p1ByPair: byPair });
const link = rows.find((r) => r.pair === "LINK/WETH");
assert.strictEqual(link.pools, 2); assert.strictEqual(link.routes, 1); assert.strictEqual(link.routeEp, 5); assert.strictEqual(link.ok, 1);
assert.strictEqual(rows.find((r) => r.pair === "USDC/WETH").episodes, 10);
assert.strictEqual(rows[rows.length - 1].pair, "LINK/USDC", "el par sin actividad queda al final");
console.log(pairLine(rows));

// applyChain carga excludedPairs y todas las cadenas lo declaran
for (const c of Object.values(CHAINS)) { assert.ok(Array.isArray(c.excludedPairs), c.key); core.applyChain({ ...c, excludedPairs: ["LINK/WPOL"] }); assert.strictEqual(core.EXCLUDED_PAIRS.size, 1); }
// direcciones nuevas con formato válido y sin duplicados por cadena
for (const c of Object.values(CHAINS)) {
  const addrs = c.extraTokens.map((t) => t.address.toLowerCase());
  assert.strictEqual(new Set(addrs).size, addrs.length, `duplicados en ${c.key}`);
  for (const a of addrs) assert.match(a, /^0x[0-9a-f]{40}$/);
}
console.log("OK test_pairs");
