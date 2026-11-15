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
  ["NeutralLpManagerV2", "nlm-v2.2", [{ tokenId: 1n, usdcIn: 0n, borrow0: 2n, borrow1: 3n, minUsdcOut: 4n, deadline: 5n }, 6n]],
  ["NeutralLpManager", "nlm-v1.2", [{ tokenId: 1n, usdcIn: 0n, borrowWeth: 2n, sellWeth: 3n, minBtcOut: 4n, minUsdcOut: 5n, deadline: 6n }, 7n]],
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
  if (b.s.canCompound) b.s.managerVer = Cls === NeutralLp2 ? 'nlm-v2.2' : 'nlm-v1.2';
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
// 5) depósito periódico de capital (espejo): mueve USDC de la wallet al contrato y lo apalanca con compound()
{
  const { trackCapital, avgCapital } = await import("../server/neutrallp.mjs");
  const { dailyLabel } = await import("../server/bridge.mjs");
  const mgr = "0x00000000000000000000000000000000000000aa", me = "0x000000000000000000000000000000000000dEaD";
  const mk = (wallet, inMgr, extraS = {}) => {
    const notes = [], sent = [], bal = { [mgr]: inMgr, [me]: wallet };
    const b = new NeutralLp2({ executor: { mode: "live", wallet: { address: me } }, provider: null, store: null, diag: async () => {} });
    b.s = { runs: {}, tokenId: "777", events: [], actions: 0, recenters: 0, transfers: 0, deleverages: 0, manager: mgr, canCompound: true, managerVer: 'nlm-v2.2', openedAt: Date.now() - 2 * 86400_000, entry: { usd: 50 }, base: { equity: 50, feesTotal: 0 }, ...extraS };
    Object.assign(b.cfg, { a, r, revertFloor: 1.045, xlendFloor: 1.06, slipBps: 80, compoundUsd: 10, compoundCooldownMin: 10, addUsd: 50, addEveryH: 24, addMinUsd: 20 });
    b.note = async (m) => { notes.push(m); }; b.save = async () => {}; b.sim = async () => 1n;
    const MV = new ethers.Interface(JSON.parse(fs.readFileSync(new URL("../server/artifacts/NeutralLpManagerV2.json", import.meta.url))).abi);
    b.c = () => ({ balanceOf: async (who) => BigInt(Math.round(bal[who] * 1e6)), allowance: async () => 0n });
    b.send = async (step, tx) => { sent.push({ step, tx }); if (tx.to === mgr) { const [ar] = MV.decodeFunctionData("compound", tx.data); bal[me] -= Number(ar.usdcIn) / 1e6; } return rc; };
    b.read = async () => ({ lpValue: 180, h: { revert: 1.07, xlend: 1.09 }, equity: 99.6, net: { eth: 0, btc: 0 } });
    return { b, notes, sent, bal };
  };
  const rr = { rColl: 0.775 * 89, rDebt: 64.6, rValue: 89, lpValue: 89, feesUsd: 0.02, equity: 49.7, inRange: true, xColl: 114.3, xDebt: 89, lt: 0.85, h: { revert: 1.068, xlend: 1.091 }, pr: { eth, btc, px, sqrtP, tick }, pos: { tickLower: lower, tickUpper: upper, liquidity: 1n } };
  // wallet con $49.93 (lo que llega del puente): lo mete todo y lo apalanca
  const t = mk(49.93, 0);
  assert.equal(await t.b.addCapital(rr), true); assert.equal(t.sent.length, 2); assert.match(t.sent[0].step, /approve USDC/);
  const M = new ethers.Interface(JSON.parse(fs.readFileSync(new URL("../server/artifacts/NeutralLpManagerV2.json", import.meta.url))).abi);
  const [args, flash] = M.decodeFunctionData("compound", t.sent[1].tx.data);
  const zz = compoundSizing(49.93 + 0.02 * (1 - COMPOUND_HAIRCUT), a, r);
  assert.equal(args.usdcIn, 49930000n);
  near(Number(flash) / 1e6, zz.F, 1e-5); near(Number(args.minUsdcOut) / 1e6, 49.93 + 0.02 * (1 - 0.008 - COMPOUND_HAIRCUT), 1e-6);
  near(Number(args.borrow0) / 1e18 * eth + Number(args.borrow1) / 1e8 * btc, zz.V, 1e-4);
  assert.equal(t.b.s.deposits, 1); near(t.b.s.depositedUsd, 49.93); assert.equal(t.b.s.entry.usd, 99.93); near(t.b.s.base.equity, 99.93);
  assert.ok(!t.b.s.compounds && t.b.s.addAt > 0); near(t.bal[me], 0, 1e-6); assert.match(t.notes.at(-1), /depósito 1 hecho: \$49\.93 · depositado en total \$99\.93/);
  // capital promedio: 2 días con $50; un día después con $99.93 → (100 + 99.93) / 3
  const s2 = { ...t.b.s }; near(avgCapital(s2, s2.capT), 50, 1e-3); near(avgCapital(s2, s2.capT + 86400_000), (100 + 99.93) / 3, 1e-3);
  trackCapital(s2, s2.capT + 86400_000); near(s2.capUsdDays, 199.93, 1e-3);
  // wallet con más de $50: solo toma $50; con menos del mínimo: espera y avisa una vez
  const t2 = mk(140, 0); await t2.b.addCapital(rr); near(t2.bal[me], 90, 1e-6); near(t2.b.s.depositedUsd, 50);
  const t3 = mk(5, 0); assert.equal(await t3.b.addCapital(rr), false); assert.equal(t3.sent.length, 0); assert.match(t3.notes[0], /esperando fondeo/); await t3.b.addCapital(rr); assert.equal(t3.notes.length, 1);
  // USDC que quedó en el contrato de un intento anterior: no vuelve a mover de más
  const t4 = mk(30, 30); await t4.b.addCapital(rr); near(t4.bal[me], 10, 1e-6); near(t4.b.s.depositedUsd, 50);
  // contrato anterior: no mueve nada
  const t5 = mk(100, 0, { managerVer: 'nlm-v2.1' }); assert.equal(await t5.b.addCapital(rr), false); assert.equal(t5.sent.length, 0);
  assert.equal(dailyLabel("espejo", Date.UTC(2026, 10, 15, 23, 59), 0), "espejo-2026-11-15"); assert.equal(dailyLabel("espejo", Date.UTC(2026, 10, 16, 0, 1), 0), "espejo-2026-11-16");
  assert.equal(dailyLabel("espejo", Date.UTC(2026, 10, 15, 17, 50), 17), "espejo-2026-11-15"); assert.equal(dailyLabel("espejo", Date.UTC(2026, 10, 16, 16, 59), 17), "espejo-2026-11-15"); assert.equal(dailyLabel("espejo", Date.UTC(2026, 10, 16, 17, 0), 17), "espejo-2026-11-16");
}
{
  const { fixDeposit1115 } = await import("../server/neutrallp2.mjs");
  const s = { depositLog: [{ t: 1, usd: 49.967, tx: "0x1b9aabfb7950c98b9fff9137914ab0a81c86d001cca406c5bf8731211f83be28" }], depositedUsd: 49.967, entry: { usd: 99.97 }, base: { equity: 99.967 } };
  assert.equal(fixDeposit1115(s), true); assert.equal(s.entry.usd, 89.97); near(s.base.equity, 89.967); near(s.depositedUsd, 39.967); assert.equal(fixDeposit1115(s), false); assert.equal(s.entry.usd, 89.97);
  assert.equal(fixDeposit1115({ depositLog: [{ usd: 50, tx: "0xotra" }] }), false);
}
console.log("test_nlp_compound OK");
