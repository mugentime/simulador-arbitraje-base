import { liqNegCooldownMs } from "../server/liquidator.mjs";
let ok = 0, n = 0; const eq = (a, b, m) => { n++; if (a === b) ok++; else console.log("FALLA", m, a, b); };
eq(liqNegCooldownMs(0.00, 0.01), 30 * 60_000, "polvo: beneficio 0 < gas/2");
eq(liqNegCooldownMs(0.004, 0.01), 30 * 60_000, "beneficio < gas/2");
eq(liqNegCooldownMs(0.008, 0.01), 3 * 60_000, "beneficio cerca del gas");
eq(liqNegCooldownMs(null, 0.01), 30 * 60_000, "sin beneficio");
eq(liqNegCooldownMs(0.5, 0), 3 * 60_000, "gas 0");
console.log(`${ok}/${n} ok`); if (ok !== n) process.exit(1);
