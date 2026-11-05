// comisión direccional de Camelot v2 desde getReserves() crudo (4 palabras)
import { camelotFeeBps, amountOut } from "../src/core.js";
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
let ok = 0, bad = 0;
const t = (name, got, want) => { if (got === want) ok++; else { bad++; console.log("FALLA", name, got, want); } };
t("300/300 → 30", camelotFeeBps("0x" + w(1e18) + w(2e18) + w(300) + w(300)), 30);
t("300/1000 → 100", camelotFeeBps("0x" + w(1) + w(2) + w(300) + w(1000)), 100);
t("175 → 18 (ceil)", camelotFeeBps("0x" + w(1) + w(2) + w(175) + w(100)), 18);
t("uni v2 (3 palabras) → null", camelotFeeBps("0x" + w(1) + w(2) + w(123456)), null);
t("vacío → null", camelotFeeBps("0x"), null);
t("absurdo → null", camelotFeeBps("0x" + w(1) + w(2) + w(99999) + w(1)), null);
// con la comisión real (1 %) la salida modelada es menor que con 30 bps: ya no se sobrestima
const a = amountOut(10n ** 18n, 10n ** 21n, 10n ** 21n, 3000n), b = amountOut(10n ** 18n, 10n ** 21n, 10n ** 21n, 10000n);
t("1 % < 0.3 %", b < a, true);
console.log(`test_camelot_fee: ${ok} ok, ${bad} fallas`); process.exit(bad ? 1 : 0);
