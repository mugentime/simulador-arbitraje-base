// Prueba: agregación de motivos de revert sin argumentos numéricos.
import { reasonKey } from "../server/executor.mjs";
const cases = [["InsufficientProfit(196,4126)", "InsufficientProfit"], ["InsufficientProfit(78600874589, 1800393065194)", "InsufficientProfit"],
  ["Error(transferFrom reverted)", "Error(transferFrom reverted)"], ["Panic(17)", "Panic(17)"], ["server response 502 Bad Gateway", "server response 502 Bad Gateway"], [undefined, "desconocido"]];
let bad = 0;
for (const [i, o] of cases) { const r = reasonKey(i); if (r !== o) { bad++; console.log("FALLO", i, r); } }
console.log(bad ? `${bad} fallos` : "test_reason_key OK"); process.exit(bad ? 1 : 0);
