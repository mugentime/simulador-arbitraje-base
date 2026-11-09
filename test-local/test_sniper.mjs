// Radar sniper: señales puras con la serie real de AI-USDG (2026-11-07) y casos de control.
import assert from "node:assert/strict";
import { dailyFromApy, emissionsPerDay, optimalSize, detectSignals, tokenExodus, concentration } from "../server/sniper.mjs";

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
// E con los datos del 7-nov: ~$636/día a 2,946 % y TVL $67.6k
near(emissionsPerDay(67636, 2946.32), 636, 3);
near(emissionsPerDay(61703, 4133.67), 636, 3);
assert.ok(Number.isFinite(dailyFromApy(4.6957690818828744e29)));
assert.equal(dailyFromApy(0), 0);
// tamaño óptimo al momento del éxodo (T=$53, E=$630, r=2 %): ~$1,240 y ~$600/día
const s = optimalSize(630, 53, 0.02); near(s.x, 1239, 5); near(s.perDay, 604, 5);

const t0 = Date.parse("2026-11-07T19:20:00Z"), m = 60_000;
const pt = (min, tvl, E = 636, amt = tvl / 70) => ({ t: t0 + min * m, tvl, amt, E });
// pre-éxodo: −9 % en 2 h con E estable (19:23 → 21:40)
const pre = [pt(0, 67636), pt(20, 65179), pt(80, 62412), pt(140, 61703)];
const sp = detectSignals(pre, { now: t0 + 140 * m });
assert.ok(sp.some((x) => x.kind === "pre-éxodo"), "debe ver pre-éxodo");
assert.ok(!sp.some((x) => x.kind === "éxodo"));
// éxodo: $61.7k → $53 en 44 min
const ex = [...pre, pt(160, 61500), pt(184, 53)];
const se = detectSignals(ex, { now: t0 + 184 * m });
const e = se.find((x) => x.kind === "éxodo"); assert.ok(e, "debe ver éxodo"); assert.ok(e.dropPct > 99); assert.equal(e.E, 636);
// caída del TVL en $ solo por precio (las unidades no cambian): no es éxodo
const px = [pt(0, 60000, 636, 1000), pt(30, 25000, 636, 1000)];
assert.equal(detectSignals(px, { now: t0 + 30 * m }).length, 0);
// éxodo con emisiones chicas: se ignora
assert.equal(detectSignals([pt(0, 5000, 5), pt(30, 100, 5)], { now: t0 + 30 * m }).filter((x) => x.kind === "éxodo").length, 0);
// éxodo de token: AI-WETH y AI-USDG perdiendo ≥ 10 % en 6 h
const te = tokenExodus([{ id: "ai-weth", token: "AI", tvl6h: 62000, tvl: 47000 }, { id: "ai-usdg", token: "AI", tvl6h: 67000, tvl: 60000 }, { id: "x", token: "X", tvl6h: 9000, tvl: 1000 }]);
assert.equal(te.length, 1); assert.equal(te[0].token, "AI");
// concentración
const c = concentration({ a: "800", b: "150", c: "50", d: "0" });
assert.equal(c.holders, 3); assert.equal(c.top1, 80); assert.equal(c.top3, 100); assert.equal(c.topAddr, "a");
assert.equal(concentration({}).top1, null);
console.log("test_sniper ok");

// F1: candidatos a semilla (vault que compone sobre reward pool; sin Stock Tokens; par con estable; E ≥ $100)
import { Sniper } from "../server/sniper.mjs";
const sn = new Sniper({ provider: null, store: null, diag: () => {}, chainKey: "robinhood" });
const add = (o) => sn.v.set(o.id, { apiTvl: 10000, usdPair: true, stock: false, gov: false, ...o });
add({ id: "pons-vault", name: "PONS-USDG", assets: ["PONS", "USDG"], Eapi: 370 });
add({ id: "pons-rp", name: "PONS-USDG RP", assets: ["USDG", "PONS"], Eapi: 400, gov: true });
add({ id: "nvda", name: "NVDA-USDG", assets: ["NVDA", "USDG"], Eapi: 200, stock: true });
add({ id: "boner", name: "BONER-WETH", assets: ["BONER", "WETH"], Eapi: 255, usdPair: false });
add({ id: "cash", name: "CASHCAT-USDG", assets: ["CASHCAT", "USDG"], Eapi: 126, holders: { c: { top1: 90 } } });
add({ id: "chico", name: "X-USDG", assets: ["X", "USDG"], Eapi: 60 });
add({ id: "sinsym", name: "Y-USDG", assets: ["Y", "USDG"], Eapi: 500, stock: undefined });
const cands = sn.seedCandidates().map((c) => c.id);
assert.deepEqual(cands, ["pons-vault", "cash"]);
assert.ok(sn.isSeedCandidate("cash") && !sn.isSeedCandidate("boner"));
console.log("test_sniper F1 ok");

// comisiones medidas: Harvest(fee0, fee1) de la estrategia en 24 h, valuadas con precios de Beefy (proveedor simulado)
import { ethers } from "ethers";
{
  const C2 = new ethers.Interface(["function strategy() view returns (address)", "function wants() view returns (address,address)"]);
  const STRAT = "0x8cEa5E3CC054a0720E93f737bCAD585B744C0b33", T0 = "0x0000000000000000000000000000000000000a11", T1 = "0x0000000000000000000000000000000000000b22";
  const head = 1_000_000, now = Math.floor(Date.now() / 1000);
  const p = {
    getBlockNumber: async () => head,
    getBlock: async (b) => ({ timestamp: now - (head - b) * 1 }), // 1 s por bloque
    call: async ({ data }) => (data.startsWith(C2.getFunction("strategy").selector) ? C2.encodeFunctionResult("strategy", [STRAT]) : C2.encodeFunctionResult("wants", [T0, T1])),
    getLogs: async ({ fromBlock, toBlock }) => (fromBlock <= head - 100 && toBlock >= head - 100 ? [{ blockNumber: head - 100, data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [10n ** 18n, 5n * 10n ** 6n]) }] : []),
  };
  const s2 = new Sniper({ provider: p, store: null, diag: () => {}, chainKey: "robinhood" });
  s2.px = { [T0.toLowerCase()]: { p: 2, d: 18 }, [T1.toLowerCase()]: { p: 1, d: 6 } };
  s2.v.set("v1", { id: "v1", name: "X-USDG", clm: "0x00000000000000000000000000000000000000c1", apiTvl: 7300, tvl: 7300, watch: true, Eapi: 50 });
  for (let i = 0; i < 10 && !(s2.v.get("v1").fees?.covered >= 1); i++) await s2.feesStep();
  const f = s2.v.get("v1").fees;
  assert.equal(f.harvests, 1); assert.equal(f.perDay, 7); assert.equal(f.aprPct, 35); assert.equal(f.covered, 1);
  assert.equal(s2.topFees(5)[0].id, "v1");
  console.log("test_sniper comisiones ok");
}
