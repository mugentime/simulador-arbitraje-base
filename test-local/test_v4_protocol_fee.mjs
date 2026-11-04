// Prueba: comisión de protocolo de Uniswap v4 (slot0.protocolFee) en el modelo.
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { getSqrtRatioAtTick } from "../src/clmath.js";

const t0 = { address: "0x0000000000000000000000000000000000000001", decimals: 6 };
const t1 = { address: "0x0000000000000000000000000000000000000002", decimals: 8 };
const tick = -66565;
const mk = () => ({ kind: "v4", token0: t0, token1: t1, feePips: 10000n, feeBps: 100, tickSpacing: 200, tick, sqrtPriceX96: getSqrtRatioAtTick(tick), liquidity: 10491678293n, ticks: [] });

const a = mk(), b = mk();
core.v4EffectiveFees(b, 1000n | (1000n << 12n), 10000n);
assert.equal(b.swapFee0, 10990n); // 1000 + 10000 − 10
assert.equal(b.swapFee1, 10990n);
assert.equal(a.swapFee0, undefined);
const amt = 2299887n;
const oa = core.swapOut(a, t0.address, amt), ob = core.swapOut(b, t0.address, amt);
console.log("sin protocolo", oa, "con protocolo", ob, "dif bps", Number((oa - ob) * 100000n / oa) / 10);
assert.ok(ob < oa);
// protocolFee 0 → igual que antes
const c = mk(); core.v4EffectiveFees(c, 0n, 10000n);
assert.equal(core.swapOut(c, t0.address, amt), oa);
// direccional: solo 1→0 con comisión
const d = mk(); core.v4EffectiveFees(d, 500n << 12n, 10000n);
assert.equal(d.swapFee0, 10000n); assert.equal(d.swapFee1, 10495n);
assert.equal(core.swapOut(d, t0.address, amt), oa);
console.log("ok: comisión de protocolo v4");
