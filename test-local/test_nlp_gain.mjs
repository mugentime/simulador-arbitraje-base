// Re-apalancamiento de la ganancia que ya está en el capital (Jose 2026-11-21: "un take profit; como el cobro de comisiones, se suma
// a los 10 usd necesarios para la reinversión"): NLP_COMPOUND_GAIN=1 suma al umbral el resultado por precio y las comisiones ya
// cobradas en re-centrados, y re-apalanca todo junto. Apagado (por omisión) todo queda igual que antes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import { NLP, NeutralLp, compoundSizing, afterCompound, unleveredGain, COMPOUND_HAIRCUT } from "../server/neutrallp.mjs";
import { rangeTicks } from "../server/revertloan.mjs";
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const a = 0.78, r = 0.725;

// 1) contador: resultado total − marca − comisiones por cobrar; nunca negativo
{
  const base = { equity: 100, feesTotal: 1 };
  near(unleveredGain({ equity: 108, total: 4 }, base, 0, 0.5), 7.5);          // +8 total, 0.5 por cobrar
  near(unleveredGain({ equity: 108, total: 4 }, base, 6, 0.5), 1.5);          // ya se re-apalancaron 6
  assert.equal(unleveredGain({ equity: 97, total: 4 }, base, 0, 0.5), 0);     // pérdida: no resta
  assert.equal(unleveredGain({ equity: 108, total: 4 }, null, 0, 0), 0);      // sin base no hay contador
  assert.equal(unleveredGain({ equity: NaN, total: 4 }, base, 0, 0), 0);
}

const eth = 1813, btc = 64940, px = eth / btc / 1e10, sqrtP = Math.sqrt(px), tick = Math.round(Math.log(px) / Math.log(1.0001));
const { lower, upper } = rangeTicks(tick, 2, 10);
const EV = new ethers.Interface(["event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)"]);
const mk = (fee0, fee1) => { const l = EV.encodeEventLog(EV.getEvent("Collect"), [777n, NLP.VAULT, fee0, fee1]); return { hash: "0xabc", logs: [{ address: NLP.NPM, topics: l.topics, data: l.data }] }; };
const M = new ethers.Interface(JSON.parse(fs.readFileSync(new URL("../server/artifacts/NeutralLpManager.json", import.meta.url))).abi);

function bot({ gainOn, fees, equity, mark, cColl = 222, cDebtUsd = 166, after }) {
  const notes = [], sent = [];
  const b = new NeutralLp({ executor: { mode: "live", wallet: { address: "0x000000000000000000000000000000000000dEaD" } }, provider: null, store: null, diag: async () => {} });
  b.s = { runs: {}, tokenId: "777", events: [], actions: 0, recenters: 1, transfers: 0, deleverages: 0, manager: "0x00000000000000000000000000000000000000aa", openedAt: Date.now() - 86400_000,
    entry: { usd: 100.9 }, canCompound: true, managerVer: "nlm-v1.2", feesCollectedUsd: 2.4, base: { equity: 100.78, feesTotal: 0 }, gainMark: mark };
  Object.assign(b.cfg, { a, r, revertFloor: 1.056, cometFloor: 1.065, revertTrigger: 1.04, cometTrigger: 1.05, emergency: 1.025, slipBps: 80, compoundUsd: 10, compoundCooldownMin: 10, compoundGain: gainOn, gainRetryMin: 60, outMin: 30, cooldownMin: 30 });
  b.note = async (m) => { notes.push(m); }; b.save = async () => {}; b.sim = async () => 1n;
  const fee0 = BigInt(Math.floor(fees / eth * 1e18));
  b.send = async (step, tx) => { sent.push({ step, tx }); return mk(fee0, 0n); };
  const rd = { rColl: 0.775 * 168, rDebt: 120, rValue: 168, lpValue: 168, cColl, cDebtUsd, cDebt: cDebtUsd / eth, feesUsd: fees, equity, inRange: true,
    h: { revert: 0.775 * 168 / 120, comet: 0.85 * cColl / cDebtUsd }, pr: { eth, btc, px, sqrtP, tick }, pos: { tickLower: lower, tickUpper: upper, liquidity: 1n } };
  let n = 0; b.read = async () => (n++ === 0 ? rd : (after ?? rd));
  return { b, notes, sent, rd };
}

// 2) apagado: con $0.20 por cobrar y $12 de ganancia en el capital no hace nada (comportamiento anterior)
{
  const t = bot({ gainOn: false, fees: 0.2, equity: 100.78 + 12.6 });
  await t.b.monitor(); assert.equal(t.sent.length, 0); assert.equal(t.b.s.last.gainPending, undefined); assert.doesNotMatch(t.b.line(), /por re-apalancar/);
}
// 3) encendido, bajo el umbral: lo cuenta y lo muestra, no manda nada
{
  const t = bot({ gainOn: true, fees: 0.2, equity: 100.78 + 2.8 });
  await t.b.monitor(); assert.equal(t.sent.length, 0); near(t.b.s.last.gainPending, 2.6, 1e-9); assert.match(t.b.line(), /por re-apalancar \$2\.80 de \$10/);
}
// 4) encendido, comisiones + ganancia ≥ $10: re-apalanca todo; el USDC mínimo exigido es solo el de las comisiones; marca en cero
{
  const fees = 0.2, gain = 12.4, after = { rColl: 1, rDebt: 1, rValue: 1, lpValue: 190, cColl: 240, cDebtUsd: 188, cDebt: 0.1, feesUsd: 0, equity: 100.78 + 12.55, inRange: true, h: { revert: 1.07, comet: 1.08 }, pr: { eth, btc, px, sqrtP, tick }, pos: { tickLower: lower, tickUpper: upper, liquidity: 1n } };
  const t = bot({ gainOn: true, fees, equity: 100.78 + fees + gain, after });
  await t.b.monitor(); assert.equal(t.sent.length, 1);
  const [args, flash] = M.decodeFunctionData("compound", t.sent[0].tx.data);
  const z = compoundSizing(fees * (1 - COMPOUND_HAIRCUT) + gain, a, r);
  near(Number(args.borrowWeth) / 1e18 * eth, z.V, 1e-6); near(Number(flash) / 1e6, z.F, 1e-5);
  assert.equal(args.usdcIn, 0n); assert.ok(Number(args.minUsdcOut) / 1e6 <= fees && Number(args.minUsdcOut) / 1e6 > fees * 0.98);
  assert.match(t.sent[0].step, /\+ \$12\.40 de ganancia que ya estaba en el capital/);
  near(t.b.s.gainCompoundedUsd, gain, 1e-9); assert.equal(t.b.s.compounds, 1);
  near(t.b.s.gainMark, 12.55, 1e-3);                                             // todo lo ganado quedó re-apalancado
  near(unleveredGain({ equity: after.equity, total: t.b.s.feesCollectedUsd }, t.b.s.base, t.b.s.gainMark, 0), 0, 1e-3);
  // saludes esperadas: se calculan con el colateral que sí llega (comisiones + flash), no con la ganancia
  const h = afterCompound({ rColl: t.rd.rColl, rDebt: t.rd.rDebt, rValue: t.rd.rValue, hColl: 222, hDebt: 166, lt: 0.85 }, { ...z, A: z.A - gain }, fees);
  assert.ok(h.revert >= 1.056 && h.hedge >= 1.065, `saludes ${h.revert} ${h.hedge}`);
}
// 5) ya re-apalancado (marca): no repite hasta juntar otros $10
{
  const t = bot({ gainOn: true, fees: 0.2, equity: 100.78 + 12.6, mark: 12.4 });
  await t.b.monitor(); assert.equal(t.sent.length, 0);
}
// 6) cobertura sin holgura: no manda nada, avisa y reintenta en 60 min (no cada 10)
{
  const t = bot({ gainOn: true, fees: 0.2, equity: 100.78 + 12.6, cColl: 210, cDebtUsd: 166 });
  await t.b.monitor(); assert.equal(t.sent.length, 0); assert.match(t.notes.at(-1), /re-apalancamiento pospuesto .* reintenta en 60 min/);
  const n0 = t.notes.length; await t.b.compound(t.rd, { gainUsd: 12.4 }); assert.equal(t.notes.length, n0); // dentro de la espera
}
// 7) pérdida por precio: las comisiones por cobrar siguen disparando solas al llegar a $10 (como antes)
{
  const t = bot({ gainOn: true, fees: 10.5, equity: 100.78 - 3 });
  await t.b.monitor(); assert.equal(t.sent.length, 1);
  const [args, flash] = M.decodeFunctionData("compound", t.sent[0].tx.data);
  // tamaño solo con las comisiones (a la fracción de apalancamiento que quepa en las saludes), sin sumar ganancia
  assert.ok([1, 0.66, 0.33].some((k) => Math.abs(Number(flash) / 1e6 - compoundSizing(10.5 * (1 - COMPOUND_HAIRCUT), a, r, k).F) < 1e-4)); assert.doesNotMatch(t.sent[0].step, /ganancia que ya estaba/);
}
console.log("test_nlp_gain OK");
