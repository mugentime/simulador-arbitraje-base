// Tamaño de liquidación Morpho según la liquidez de venta del colateral (pickMorphoSize)
import { pickMorphoSize } from "../server/liquidator.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
// pool de producto constante colateral→préstamo con x de reserva por lado; precio de oráculo 1:1, LIF 2.6 %
const pool = (x) => (seized) => ({ out: (seized * x) / (x + seized) * 997n / 1000n, route: ["p"] });
const sizeOf = (seized) => { const repaid = seized * 1_000_000n / 1_026_000n; return { seized, repaid, amount: repaid * 1005n / 1000n }; };
const E = 10n ** 18n;
// colateral $139k contra un pool de $200k/lado: el tamaño completo no cubre; uno parcial sí
const p1 = pickMorphoSize(sizeOf, 139_000n * E, pool(200_000n * E));
ok(p1 && p1.size.seized < 139_000n * E && p1.margin > 0n, `parcial elegido: ${p1 ? Number(p1.size.seized / E) : "—"} de 139000`);
// pool profundo: conviene el máximo
const p2 = pickMorphoSize(sizeOf, 1_000n * E, pool(100_000_000n * E));
ok(p2 && p2.size.seized === 1_000n * E, "pool profundo → tamaño completo");
// colateral sin valor de mercado (deuda mala): null
const p3 = pickMorphoSize(sizeOf, 139_000n * E, (s) => ({ out: s / 2n, route: [] }));
ok(p3 === null, "venta a mitad de precio → ninguno (sin simulación)");
ok(pickMorphoSize(sizeOf, 139_000n * E, () => null) === null, "sin ruta → null");
process.exit(fails ? 1 : 0);
