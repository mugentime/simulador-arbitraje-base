// Depósito del día dirigido (Jose 2026-11-17: "cada día vamos a ver cuál va ganando … a qué estrategia va el depósito del día"):
// NLP_ADD_TO=original manda el depósito a la original (compound con capital nuevo, contrato nlm-v1.2); la espejo lleva el calendario,
// el fondeo y lo que queda debiendo. Cierre y re-apertura de la original sin perder la cuenta del resultado.
import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import { NLP, NeutralLp, compoundSizing, COMPOUND_HAIRCUT, baseResult, avgCapital } from "../server/neutrallp.mjs";
import { NeutralLp2 } from "../server/neutrallp2.mjs";
import { rangeTicks } from "../server/revertloan.mjs";
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const a = 0.78, r = 0.725, eth = 1797, btc = 64002, px = eth / btc / 1e10, sqrtP = Math.sqrt(px), tick = Math.round(Math.log(px) / Math.log(1.0001));
const { lower, upper } = rangeTicks(tick, 2, 10);
const me = "0x000000000000000000000000000000000000dEaD", mgr1 = "0x00000000000000000000000000000000000000a1", mgr2 = "0x00000000000000000000000000000000000000a2";
const M1 = new ethers.Interface(JSON.parse(fs.readFileSync(new URL("../server/artifacts/NeutralLpManager.json", import.meta.url))).abi);
const rc = { hash: "0xdep", logs: [] };
const pr = { eth, btc, px, sqrtP, tick }, pos = { tickLower: lower, tickUpper: upper, liquidity: 1n };

function world(wallet, { ver1 = "nlm-v1.2", s1 = {}, r1 = {} } = {}) {
  const bal = { [me]: wallet, [mgr1]: 0, [mgr2]: 0 }, sent = [], notes = [];
  const c = () => ({ balanceOf: async (w) => BigInt(Math.round(bal[w] * 1e6)), allowance: async () => 0n });
  const o = new NeutralLp({ executor: { mode: "live", wallet: { address: me } }, provider: null, store: null, diag: async () => {} });
  o.s = { runs: {}, tokenId: "111", events: [], actions: 0, recenters: 0, transfers: 0, deleverages: 0, manager: mgr1, canCompound: true, managerVer: ver1, openedAt: Date.now() - 6 * 86400_000, entry: { usd: 50 }, base: { equity: 49.87, feesTotal: 0.37 }, ...s1 };
  Object.assign(o.cfg, { a, r, revertFloor: 1.045, cometFloor: 1.06, slipBps: 80, compoundCooldownMin: 10 });
  o.note = async (m) => { notes.push(`o: ${m}`); }; o.save = async () => {}; o.sim = async () => 1n; o.c = c;
  o.send = async (step, tx) => { sent.push({ who: "o", step, tx }); if (tx.to === mgr1) { const [ar] = M1.decodeFunctionData("compound", tx.data); bal[me] -= Number(ar.usdcIn) / 1e6; } return rc; };
  const rO = { rColl: 0.775 * 78.7, rDebt: 56, rValue: 78.7, lpValue: 78.7, feesUsd: 1.37, equity: 50.99, inRange: true, cColl: 105.92, cDebtUsd: 77.66, h: { revert: 1.089, comet: 1.159 }, pr, pos, ...r1 };
  o.read = async () => rO;
  const e = new NeutralLp2({ executor: { mode: "live", wallet: { address: me } }, provider: null, store: null, diag: async () => {}, peer: o });
  e.s = { runs: {}, tokenId: "222", events: [], actions: 0, recenters: 0, transfers: 0, deleverages: 0, manager: mgr2, canCompound: true, managerVer: "nlm-v2.2", openedAt: Date.now() - 4 * 86400_000, entry: { usd: 197.96 }, base: { equity: 197.96, feesTotal: 0 }, addAt: Date.now() - 25 * 3600_000, addOwedUsd: 2 };
  Object.assign(e.cfg, { a, r, revertFloor: 1.045, xlendFloor: 1.06, slipBps: 80, compoundCooldownMin: 10, addUsd: 50, addEveryH: 24, addMinUsd: 20, addWaitH: 4, addOwedMaxUsd: 50, addTo: "original" });
  e.note = async (m) => { notes.push(`e: ${m}`); }; e.save = async () => {}; e.sim = async () => 1n; e.c = c;
  e.send = async (step, tx) => { sent.push({ who: "e", step, tx }); return rc; };
  e.read = async () => ({ lpValue: 400, h: { revert: 1.06, xlend: 1.1 }, equity: 250, net: { eth: 0, btc: 0 } });
  const rE = { rColl: 0.775 * 354, rDebt: 258.4, rValue: 354, lpValue: 354, feesUsd: 0.13, equity: 198.5, inRange: true, xColl: 456.8, xDebt: 354, lt: 0.85, h: { revert: 1.062, xlend: 1.097 }, pr, pos };
  return { o, e, bal, sent, notes, rO, rE };
}

// 1) depósito del día → original: $52 (50 + 2 debidos) de la wallet, apalancamiento completo, nada entra a la espejo
{
  const w = world(120);
  assert.equal(await w.e.addCapital(w.rE), true);
  assert.deepEqual(w.sent.map((x) => x.who), ["o", "o"]); assert.match(w.sent[0].step, /approve USDC → NeutralLpManager$/);
  const [args, flash] = M1.decodeFunctionData("compound", w.sent[1].tx.data);
  assert.equal(args.usdcIn, 52000000n); assert.equal(args.tokenId, 111n);
  const zz = compoundSizing(52 + 1.37 * (1 - COMPOUND_HAIRCUT), a, r);
  near(Number(flash) / 1e6, zz.F, 1e-5); near(Number(args.borrowWeth) / 1e18 * eth, zz.V, 1e-6);
  near(w.bal[me], 68, 1e-6);
  // la original sube lo depositado y la base del resultado: el depósito no es ganancia
  assert.equal(w.o.s.deposits, 1); near(w.o.s.depositedUsd, 52); assert.equal(w.o.s.entry.usd, 102); near(w.o.s.base.equity, 101.87);
  assert.ok(!w.o.s.compounds); assert.equal(w.o.busy, false);
  // la espejo solo lleva el calendario y lo debido
  assert.ok(w.e.s.addAt > Date.now() - 5000); assert.equal(w.e.s.addOwedUsd, 0); assert.equal(w.e.s.routed, 1); assert.ok(!w.e.s.deposits); assert.equal(w.e.s.entry.usd, 197.96);
  assert.ok(w.notes.some((m) => /^o: depósito 1 hecho: \$52\.00 · depositado en total \$102/.test(m)));
  assert.ok(w.notes.some((m) => /^e: depósito del día → original: \$52\.00/.test(m)));
  assert.match(w.o.line.toString(), /depósitos/);
}
// 2) wallet corta: entra con lo que hay y el resto queda debiendo
{
  const w = world(40);
  w.e.s.addDueSeen = Date.now() - 5 * 3600_000; w.e.s.addDueAt = w.e.s.addAt + 24 * 3600_000; w.e.fund = { step: async () => ({ pending: true }) };
  assert.equal(await w.e.addCapital(w.rE), true); near(w.o.s.depositedUsd, 40); assert.equal(w.e.s.addOwedUsd, 12);
}
// 3) la original con contrato anterior: avisa y el depósito entra a la espejo (no se pierde el día)
{
  const w = world(120, { ver1: "nlm-v1.0" });
  assert.equal(await w.e.addCapital(w.rE), true);
  assert.ok(w.sent.every((x) => x.who === "e")); assert.equal(w.e.s.deposits, 1); near(w.e.s.depositedUsd, 52); assert.ok(!w.o.s.deposits);
  assert.ok(w.notes.some((m) => /le tocaba a la original, pero el contrato de la original es de la versión anterior · entra a la espejo/.test(m)));
}
// 4) la original fuera de rango o con saludes bajas: pospone sin mover dinero y reintenta tras el enfriamiento
{
  const w = world(120, { r1: { inRange: false } });
  assert.equal(await w.e.addCapital(w.rE), false); assert.equal(w.sent.length, 0); near(w.bal[me], 120);
  assert.ok(w.notes.some((m) => /original pospuesto .* fuera de rango/.test(m)));
  assert.equal(await w.e.addCapital(w.rE), false); assert.equal(w.notes.length, 1); // dentro del enfriamiento no insiste
  const w2 = world(120, { r1: { cColl: 92 } });
  assert.equal(await w2.e.addCapital(w2.rE), false); assert.equal(w2.sent.length, 0); assert.ok(w2.notes.some((m) => /bajo su piso/.test(m)));
  const w3 = world(120); w3.o.busy = true;
  assert.equal(await w3.e.addCapital(w3.rE), false); assert.equal(w3.sent.length, 0); assert.equal(w3.o.busy, true);
}
// 5) NLP_ADD_TO=espejo (por omisión): todo igual que antes
{
  const w = world(120); w.e.cfg.addTo = "espejo";
  assert.equal(await w.e.addCapital(w.rE), true); assert.ok(w.sent.every((x) => x.who === "e")); near(w.e.s.depositedUsd, 52); assert.ok(!w.o.s.deposits);
}
// 6) cierre y re-apertura de la original: el WETH de ganancia que queda en la wallet es capital retirado, no pérdida
{
  const w = world(300), o = w.o;
  const wbal = { usdc: 300, weth: 0.00003 };
  o.c = (addr) => ({
    balanceOf: async (who) => who === me ? (addr === NLP.USDC ? BigInt(Math.round(wbal.usdc * 1e6)) : addr === NLP.WETH ? BigInt(Math.round(wbal.weth * 1e18)) : 0n) : 0n,
    collateralBalanceOf: async () => 0n, borrowBalanceOf: async () => 0n, allowance: async () => 0n,
  });
  o.read = async () => ({ ...w.rO, li: { debt: 56000000n } });
  o.send = async (step, tx) => { w.sent.push({ step }); if (/repaga todo/.test(step)) { wbal.usdc += 49.9; wbal.weth += 1.05 / eth; } return rc; };
  o.s.last = { equity: 50.99, total: 1.37 };
  const before = baseResult({ equity: 50.99, total: 1.37 }, o.s.base).total;
  await o.closeAll("t1");
  assert.equal(o.s.closed, true); near(o.s.closeReturned, 49.9, 1e-6); near(o.s.closeWethUsd, 1.05, 1e-6);
  assert.ok(w.notes.some((m) => /cerrada · devolvió \$49\.90 en USDC \+ .* WETH \(\$1\.05\) que se quedan en la wallet/.test(m)));
  // re-apertura (misma vuelta del bot): entra exactamente lo que devolvió el cierre, aunque la wallet tenga más USDC
  o.cfg.tag = "t1"; o.cfg.close = "t1"; o.s.runs["close:t1"] = { done: true }; o.x.mode = "live";
  o.ensureManager = async () => {}; o.renewManager = async () => {}; o.monitor = async () => {}; o.prices = async () => pr;
  let opened = null; const realSend = o.send;
  o.send = async (step, tx) => { if (/^apertura/.test(step)) { opened = M1.decodeFunctionData("open", tx.data)[0]; wbal.usdc -= Number(opened.usdcIn) / 1e6; } return realSend(step, tx); };
  const origContract = ethers.Contract; // tokenId del contrato nuevo
  o.read = async () => ({ lpValue: 88, rDebt: 62, cColl: 112, cDebt: 0.049, h: { revert: 1.07, comet: 1.09 }, equity: 49.82 });
  const openOrig = o.open.bind(o);
  o.open = async (tag) => { const P = o.provider; o.provider = { call: async () => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [999n]) }; try { await openOrig(tag); } finally { o.provider = P; } };
  const t0 = o.s.openedAt;
  await o.tick();
  assert.equal(opened.usdcIn, 49900000n); near(wbal.usdc, 300, 1e-6); // no toca el USDC apartado para los depósitos
  assert.equal(o.s.tokenId, "999"); assert.equal(o.s.closed, false); assert.equal(o.s.openedAt, t0); assert.equal(o.s.reopen, false); assert.equal(o.s.closeReturned, 0);
  assert.equal(o.s.entry.usd, 48.95); near(o.s.base.equity, 49.87 - 1.05, 1e-6); near(o.s.withdrawnUsd, 1.05, 1e-6);
  // el resultado sigue la cuenta: lo único que cambia es el costo real de cerrar y reabrir (50.99 − 1.05 − 49.82 = $0.12)
  const after = baseResult({ equity: 49.82, total: 1.37 }, o.s.base).total;
  near(before - after, 0.12, 1e-6);
  assert.ok(avgCapital(o.s) > 48.9 && avgCapital(o.s) <= 50);
}
console.log("test_nlp_deposit_route OK");
