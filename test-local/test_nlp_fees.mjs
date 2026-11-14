// Comisiones cobradas en un re-centrado: datos reales del recibo 0xeb8f472c…fe698f90 (espejo, 2026-11-14 22:44 UTC)
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { NLP, feesFromReceipt, recordCollected, feeTotals, feeText } from "../server/neutrallp.mjs";
import { backfillFirstRecenter } from "../server/neutrallp2.mjs";

const EV = new ethers.Interface([
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);
const log = (name, args, address = NLP.NPM) => ({ address, ...EV.encodeEventLog(EV.getEvent(name), args) });
const MGR = "0xDEe55FC14550514A73CBB184DDda09f1c19E8926";
// raw data del recibo: DecreaseLiquidity 0x38c1d211bcd / 0xa523d6d09a32e1 / 0 · Collect 0xa57a774374c40e / 0xf2
assert.equal(0xa523d6d09a32e1n, 46482776686998241n); assert.equal(0xa57a774374c40en, 46578023808680974n);
const rc = { hash: "0xeb8f", logs: [
  log("DecreaseLiquidity", [6565243n, 3900319013837n, 46482776686998241n, 0n]),
  log("Collect", [6565243n, MGR, 46578023808680974n, 242n]),
  log("IncreaseLiquidity", [6587053n, 3885176271202n, 23015961997724379n, 64915n]),
  log("Collect", [6565243n, MGR, 999n, 999n], "0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1"), // otro contrato: se ignora
] };
const f = feesFromReceipt(rc, "6565243");
assert.equal(f.fee0, 95247121682733n); assert.equal(f.fee1, 242n);
assert.equal(feesFromReceipt(rc, "6587053"), null); // la NFT nueva no cobró nada
const usd = Number(f.fee0) / 1e18 * 1748 + Number(f.fee1) / 1e8 * 63580;
assert.ok(Math.abs(usd - 0.3204) < 0.001, `usd ${usd}`);

// registro + totales: tras el re-centrado, las horas de la NFT arrancan en cero pero el % anual usa todo lo ganado desde la apertura
const t0 = Date.UTC(2026, 10, 13, 18, 33), tr = Date.UTC(2026, 10, 14, 22, 44), now = tr + 21 * 60_000;
const s = { openedAt: t0, entry: { usd: 50 } };
recordCollected(s, { from: "6565243", rc, eth: 1748, btc: 63580, now: tr });
assert.ok(Math.abs(s.feesCollectedUsd - 0.3204) < 0.001); assert.equal(s.nftSince, tr); assert.equal(s.feeLog.length, 1);
const t = feeTotals(s, 0.019, 81.27, now);
assert.ok(Math.abs(t.total - 0.3394) < 0.001);
assert.ok(Math.abs(t.nftDays * 24 - 0.35) < 0.01 && Math.abs(t.feeDays * 24 - 28.53) < 0.01);
assert.ok(t.feeAprCap > 200 && t.feeAprCap < 215, `apr ${t.feeAprCap}`); // antes del arreglo: 11 %
const txt = feeText(t);
assert.match(txt, /comisiones por cobrar \$0\.019 en 0\.3 h \(NFT actual\) · cobradas en re-centrados \$0\.320 · total \$0\.339 en 28\.5 h = \d+ % anual sobre el capital/);
// sin re-centrados la línea queda igual que antes
assert.equal(feeText(feeTotals({ openedAt: t0, entry: { usd: 50 } }, 0.5, 80, now)).startsWith(" · comisiones por cobrar $0.500 en 28.5 h = "), true);

// respaldo del re-centrado ya hecho: una sola vez
const s2 = { openedAt: t0, history: [{ t: tr, from: "6565243", to: "6587053" }] };
assert.equal(backfillFirstRecenter(s2), true); assert.equal(backfillFirstRecenter(s2), false);
assert.ok(Math.abs(s2.feesCollectedUsd - 0.3204) < 0.001); assert.equal(s2.nftSince, tr);
assert.equal(backfillFirstRecenter({ history: [] }), false);
console.log("test_nlp_fees: ok");
