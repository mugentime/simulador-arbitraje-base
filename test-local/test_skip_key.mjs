import { skipKey } from "../server/executor.mjs";
const cases = [
  ["omitida: tope por hora", "tope/h"],
  ["omitida: neto $0.0100 < 3× gas $0.0160 (valor esperado negativo)", "EV<mult×gas"],
  ["omitida: neto tras propina $0.0100 < 3× lo que perdería si revierte $0.0200", "EV tras propina"],
  ["omitida: neto simulado ≤ 0", "neto≤0"],
  ["omitida: neto simulado $0.0010 < mínimo de envío $0.01", "neto<mín"],
  ["omitida: 1 tx en vuelo sin recibo", "en vuelo"],
  ["omitida: si revierte perdería $0.020 y quedan $0.01", "presupuesto"],
  ["omitida: presupuesto de reverts agotado ($0.100/h)", "presupuesto"],
];
let bad = 0;
for (const [i, e] of cases) { const g = skipKey(i); if (g !== e) { bad++; console.log("FALLA", i, g, e); } }
console.log(bad ? `${bad} fallas` : "test_skip_key OK"); process.exit(bad ? 1 : 0);
