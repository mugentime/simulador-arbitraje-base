// Re-apalancamiento de comisiones (2026-11-15): tamaño, saludes esperadas, codificación de compound() y flujo del bot con lecturas simuladas.
import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import { NLP, NeutralLp, openSizing, compoundSizing, afterCompound, token0Share, feeText, COMPOUND_HAIRCUT } from "../server/neutrallp.mjs";
import { NeutralLp2, openBorrows } from "../server/neutrallp2.mjs";
import { rangeTicks, amountsFor } from "../server/revertloan.mjs";
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

// 1) tamaño: con k = 1 es el mismo ciclo de la apertura; con k menor pide menos flash y siempre cuadra V = a·(C + F)
const a = 0.78, r = 0.725, o = openSizing(10, a, r), z = compoundSizing(10, a, r);
near(z.V, o.V); near(z.F, o.F); near(z.A, o.A); near(z.V, 17.9517, 1e-4);
for (const k of [1, 0.66, 0.33, 0]) { const y = compoundSizing(10, a, r, k); near(y.V, a * (10 + y.F)); near(y.F, r * k * y.V); assert.ok(y.V <= z.V + 1e-9); }

// 2) saludes esperadas: re-apalancar al máximo acerca cada salud a la de apertura (0.775/0.725 y 0.85/0.78)
const x = { rColl: 0.775 * 8400, rDebt: 0.70 * 8400, rValue: 8400, hColl: 10900, hDebt: 8400, lt: 0.85 };
const h = afterCompound(x, compoundSizing(10 * (1 - COMPOUND_HAIRCUT), a, r), 10);
const hR0 = x.rColl / x.rDebt, hX0 = x.lt * x.hColl / x.hDebt;
assert.ok(h.revert < hR0 && h.revert > 0.775 / 0.725 && Math.abs(h.revert - hR0) < 0.002, `revert ${h.revert}`);
assert.ok(Math.abs(h.hedge - hX0) < 0.002 && h.hedge > 1.06, `cobertura ${h.hedge}`);

// 3) contratos: compound() existe, codifica y el código de creación cabe en su límite
for (const [name, ver, args] of [
  ["NeutralLpManagerV2", "nlm-v2.1", [{ tokenId: 1n, borrow0: 2n, borrow1: 3n, minUsdcOut: 4n, deadline: 5n }, 6n]],
  ["NeutralLpManager", "nlm-v1.1", [{ tokenId: 1n, borrowWeth: 2n, sellWeth: 3n, minBtcOut: 4n, minUsdcOut: 5n, deadline: 6n }, 7n]],
]) {
  const art = JSON.parse(fs.readFileSync(new URL(`../server/artifacts/${name}.json`, import.meta.url)));
  assert.equal(art.version, ver);
  const M = new ethers.Interface(art.abi);
  assert.ok(M.encodeFunctionData("compound", args).length > 10);
  for (const f of ["open", "recenter", "deleverage", "sweep", "vaultBorrow"]) assert.ok(M.getFunction(f), `${name}.${f}`);
  assert.ok((art.bytecode.length - 2) / 2 < 49152, `${name} creación ${(art.bytecode.length - 2) / 2}`); // desplegado: 22,103 (v2.1) y 19,794 (v1.1) bytes, bajo el límite de 24,576
}

// 4) flujo del bot (espejo y original) con lecturas simuladas
const eth = 1813, btc = 64940, px = eth / btc / 1e10, sqrtP = Math.sqrt(px), tick = Math.round(Math.log(px) / Math.log(1.0001));
const { lower, upper } = rangeTicks(tick, 2, 10);
const EV = new ethers.Interface(["event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)"]);
const fee0 = ethers.parseEther("0.003"), fee1 = 8000n, feesUsd = Number(fee0) / 1e18 * eth + Number(fee1) / 1e8 * btc; // ≈ $10.63
const log = EV.encodeEventLog(EV.getEvent("Collect"), [777n, NLP.VAULT, fee0, fee1]);
const rc = { hash: "0xabc", logs: [{ address: NLP.NPM, topics: log.topics, data: log.data }] };
async function run(Cls, extra, readAfter) {
  const notes = [], sent = [];
  const b = new Cls({ executor: { mode: "live", wallet: { address: "0x000000000000000000000000000000000000dEaD" } }, provider: null, store: null, diag: async () => {} });
  b.s = { runs: {}, tokenId: "777", events: [], actions: 0, recenters: 0, transfers: 0, deleverages: 0, manager: "0x00000000000000000000000000000000000000aa", openedAt: Date.now() - 86400_000, entry: { usd: 5000 }, ...extra.s };
  Object.assign(b.cfg, { a, r, revertFloor: 1.045, xlendFloor: 1.06, cometFloor: 1.06, slipBps: 80, compoundUsd: 10, compoundCooldownMin: 10 });
  b.note = async (m) => { notes.push(m); }; b.save = async () => {}; b.sim = async () => 1n;
  b.send = async (step, tx) => { sent.push({ step, tx }); return rc; };
  b.read = async () => readAfter;
  const rr = { rColl: 0.775 * 8400, rDebt: 5880, rValue: 8400, lpValue: 8400, feesUsd, equity: 5010, inRange: true, pr: { eth, btc, px, sqrtP, tick }, pos: { tickLower: lower, tickUpper: upper, liquidity: 1n }, ...extra.r };
  return { b, notes, sent, ok: await b.compound(rr), rr };
}
// espejo con contrato nuevo: manda compound con los préstamos en la proporción del rango
{
  const after = { lpValue: 8419, h: { revert: 1.107, xlend: 1.103 }, equity: 5009.9, net: { eth: 0.1, btc: -0.1 } };
  const t = await run(NeutralLp2, { s: { canCompound: true }, r: { xColl: 10900, xDebt: 8400, lt: 0.85, h: { revert: 1.107, xlend: 1.103 } } }, after);
  assert.equal(t.ok, true); assert.equal(t.sent.length, 1);
  const M = new ethers.Interface(JSON.parse(fs.readFileSync(new URL("../server/artifacts/NeutralLpManagerV2.json", import.meta.url))).abi);
  const [args, flash] = M.decodeFunctionData("compound", t.sent[0].tx.data);
  const zz = compoundSizing(feesUsd * (1 - COMPOUND_HAIRCUT), a, r);
  near(Number(flash) / 1e6, zz.F, 1e-5);
  near(Number(args.borrow0) / 1e18 * eth + Number(args.borrow1) / 1e8 * btc, zz.V, 1e-4);
  const w0 = token0Share(sqrtP, lower, upper), ob = openBorrows(zz.V, eth, btc, w0);
  assert.equal(args.borrow0, ob.borrow0); assert.equal(args.tokenId, 777n);
  assert.ok(Number(args.minUsdcOut) / 1e6 < feesUsd && Number(args.minUsdcOut) / 1e6 > feesUsd * 0.98);
  assert.equal(t.b.s.compounds, 1); near(t.b.s.feesCollectedUsd, feesUsd, 1e-9); near(t.b.s.compoundedUsd, feesUsd, 1e-9);
  assert.match(t.notes.at(-1), /re-apalancado \(1\)/);
  // dentro del enfriamiento no repite
  assert.equal(await t.b.compound(t.rr), false); assert.equal(t.sent.length, 1);
  assert.match(feeText({ fees: 0.1, collected: 10, total: 10.1, feeDays: 1, nftDays: 0.1, compounds: 1 }), /cobradas en re-centrados y re-apalancamientos \$10\.000/);
  assert.match(feeText({ fees: 0.1, collected: 10, total: 10.1, feeDays: 1, nftDays: 0.1 }), /cobradas en re-centrados \$10\.000/);
}
// contrato anterior: no manda nada y lo avisa una sola vez
{
  const t = await run(NeutralLp2, { s: {}, r: { xColl: 10900, xDebt: 8400, lt: 0.85, h: { revert: 1.1, xlend: 1.1 } } }, null);
  assert.equal(t.ok, false); assert.equal(t.sent.length, 0); assert.match(t.notes[0], /versión anterior/);
  t.b.s.lastCompoundTry = 0; await t.b.compound(t.rr); assert.equal(t.notes.length, 1);
}
// cobertura débil: salud esperada bajo el piso → pospone sin mandar
{
  const t = await run(NeutralLp2, { s: { canCompound: true }, r: { xColl: 10000, xDebt: 8400, lt: 0.85, h: { revert: 1.1, xlend: 1.012 } } }, null);
  assert.equal(t.ok, false); assert.equal(t.sent.length, 0); assert.match(t.notes[0], /pospuesto/);
}
// original (Compound): pide WETH y vende la parte de cbBTC
{
  const after = { lpValue: 8419, h: { revert: 1.107, comet: 1.103 }, equity: 5009.9 };
  const t = await run(NeutralLp, { s: { canCompound: true }, r: { cColl: 10900, cDebtUsd: 8400, h: { revert: 1.107, comet: 1.103 } } }, after);
  assert.equal(t.ok, true);
  const M = new ethers.Interface(JSON.parse(fs.readFileSync(new URL("../server/artifacts/NeutralLpManager.json", import.meta.url))).abi);
  const [args, flash] = M.decodeFunctionData("compound", t.sent[0].tx.data);
  const zz = compoundSizing(feesUsd * (1 - COMPOUND_HAIRCUT), a, r);
  near(Number(args.borrowWeth) / 1e18 * eth, zz.V, 1e-6); near(Number(flash) / 1e6, zz.F, 1e-5);
  const w0 = token0Share(sqrtP, lower, upper); near(Number(args.sellWeth) / Number(args.borrowWeth), (1 - w0) * 0.999, 1e-6);
  assert.ok(args.minBtcOut > 0n && args.minUsdcOut > 0n);
}
// contrato nuevo por etiqueta: solo sin posición abierta
{
  const b = new NeutralLp2({ executor: { mode: "live", wallet: { address: "0x000000000000000000000000000000000000dEaD" } }, provider: null, store: null, diag: async () => {} });
  b.cfg.newManager = "v21"; b.note = async () => {}; let dep = 0; b.ensureManager = async () => { dep++; };
  b.s = { runs: {}, tokenId: "777", closed: false, manager: "0xold", events: [] };
  await b.renewManager(); assert.equal(b.s.manager, "0xold"); assert.equal(dep, 0);
  b.s.closed = true; await b.renewManager(); assert.equal(b.s.manager, null); assert.deepEqual(b.s.oldManagers, ["0xold"]); assert.equal(dep, 1);
  b.s.manager = "0xnew"; await b.renewManager(); assert.equal(b.s.manager, "0xnew"); assert.equal(dep, 1);
}
console.log("test_nlp_compound OK");
