// LP como colateral: salud de posición (Moolah), bono de liquidación, tabla de apalancamiento y APR por virtual price
import { lif, positionHealth, liqProfit, leverageTable, vpApr } from "../server/lplending.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const E18 = 10n ** 18n, E36 = 10n ** 36n;

// bono de Moolah/Morpho
ok(near(lif(0.965), 1 / (1 - 0.3 * 0.035)), `LIF LLTV 96.5 % = ${((lif(0.965) - 1) * 100).toFixed(3)} %`);
ok(near(lif(0.5), 1.15), "LIF topado en 15 %");

// posición: 1000 LP a precio 1.0 (escala 1e36), deuda 960 con LLTV 96.5 % → sana; deuda 970 → liquidable
const base = { collateral: 1000n * E18, totalBorrowAssets: 960n * E18, totalBorrowShares: 960n * E18 * 1_000_000n, price: E36, lltvWad: 965n * 10n ** 15n };
const h1 = positionHealth({ ...base, borrowShares: 960n * E18 * 1_000_000n });
ok(!h1.liquidatable && near(h1.hf, 965 / 960, 1e-9), `deuda 960 → HF ${h1.hf.toFixed(5)} sana`);
const h2 = positionHealth({ ...base, totalBorrowAssets: 970n * E18, borrowShares: 960n * E18 * 1_000_000n });
ok(h2.liquidatable && h2.hf < 1, `deuda 970 → HF ${h2.hf.toFixed(5)} liquidable`);
ok(positionHealth({ ...base, borrowShares: 0n }).hf === Infinity, "sin deuda → HF infinito");
// precio 0.5 (LP vale la mitad en el token prestado)
const h3 = positionHealth({ ...base, price: E36 / 2n, borrowShares: 960n * E18 * 1_000_000n });
ok(h3.colValue === 500n * E18 && h3.liquidatable, "precio 0.5 → colateral 500, liquidable");

// beneficio: deuda $1000, colateral $1005, LLTV 96.5 % → bono ≈1.06 % menos salida y gas
const p = liqProfit({ debtUsd: 1000, colUsd: 1005, lltv: 0.965, exitCostBps: 5, gasUsd: 0.03 });
ok(p.repayUsd < 1000 && p.profitUsd > 9 && p.profitUsd < 11, `liquidar $1000 → neto $${p.profitUsd.toFixed(2)}`);
ok(liqProfit({ debtUsd: 1, colUsd: 1.01, lltv: 0.965 }).profitUsd < 0, "polvo → negativo");

// apalancamiento: LP 4 %, préstamo 3 %, LLTV 96.5 %
const t = leverageTable({ lpApr: 0.04, borrowApr: 0.03, lltv: 0.965, entryExitBps: 0, levels: [1, 5, 10] });
ok(near(t.lMaxSafe, 1 / (1 - 0.945)), `L máx con 2 pts de colchón = ${t.lMaxSafe.toFixed(2)}x`);
const r5 = t.rows.find((r) => r.L === 5);
ok(near(r5.grossApr, 5 * 0.04 - 4 * 0.03), `5x → ${(r5.grossApr * 100).toFixed(1)} % bruto`);
ok(near(r5.liqDrop, 1 - 0.8 / 0.965), `5x se liquida si el LP cae ${(r5.liqDrop * 100).toFixed(2)} %`);
ok(t.rows.at(-1).L <= t.lMaxSafe && t.rows.at(-1).liqDrop > 0, "la fila máxima respeta el colchón");
// préstamo más caro que el LP: más apalancamiento = peor
const t2 = leverageTable({ lpApr: 0.02, borrowApr: 0.05, lltv: 0.965, entryExitBps: 0, levels: [1, 5] });
ok(t2.rows.find((r) => r.L === 5).netApr < t2.rows.find((r) => r.L === 1).netApr, "LP < préstamo → apalancar resta");
// costo de entrada/salida amortizado
const t3 = leverageTable({ lpApr: 0.04, borrowApr: 0.03, lltv: 0.965, entryExitBps: 10, horizonDays: 30, levels: [10] });
ok(near(t3.rows[0].grossApr - t3.rows[0].netApr, 10 * 0.001 * 365 / 30), "costo 10 bps × L amortizado a 30 días");

// APR por virtual price: +0.01 % en 1 día ≈ 3.65 %
ok(near(vpApr({ ts: 0, vp: 1 }, { ts: 86400, vp: 1.0001 }), 0.0365, 1e-9), "vp +0.01 %/día → 3.65 % APR");
ok(vpApr(null, { ts: 1, vp: 1 }) === null, "sin lectura vieja → null");
process.exit(fails ? 1 : 0);
