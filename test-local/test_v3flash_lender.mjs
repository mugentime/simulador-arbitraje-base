// Prestamista flash de pool v3: se excluye si la ruta pasa por ese pool; si no, compite por costo (1 bps < Aave 5 bps).
import { lenderSegments, lenderFor } from "../src/core.js";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const lenders = [
  { name: "Aave v3", ok: true, feeBps: 5n, liquidity: { USDT: 10n ** 24n } },
  { name: "PCS flash WBNB/USDT", address: "0xPOOL", pool: true, source: 3, ok: true, feeBps: 1n, liquidity: { USDT: 10n ** 23n } },
];
const route = [{ address: "0xpool" }, { address: "0xother" }];
let segs = lenderSegments(lenders, "USDT", [{ address: "0xa" }]);
ok(lenderFor(segs, 10n ** 20n).name === "PCS flash WBNB/USDT", "fuera de la ruta: gana el flash de 1 bps");
ok(lenderFor(segs, 10n ** 24n).name === "Aave v3", "monto mayor que el saldo del pool: Aave");
segs = lenderSegments(lenders, "USDT", route);
ok(segs.length === 1 && segs[0].name === "Aave v3", "la ruta pasa por el pool prestamista: se excluye (comparación sin mayúsculas)");
