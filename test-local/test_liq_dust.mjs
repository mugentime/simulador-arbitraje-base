// Liquidaciones de polvo: no se simulan si valor × bono < gas de referencia (isDust)
import { isDust } from "../server/liquidator.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
ok(isDust(0.01, 0.074, 0.0121) === true, "Polygon Morpho $0.01 con LIF 7.4% y gas $0.012 → polvo");
ok(isDust(0.0, 0.074, 0.0121) === true, "posición de $0.00 → polvo");
ok(isDust(500, 0.074, 0.0121) === false, "$500 con bono 7.4% ($37) > gas → se simula");
ok(isDust(0.01, 0.074, undefined) === false, "sin gas de referencia → se simula (para obtenerlo)");
ok(isDust(0.2, 0.05, 0.0121) === true && isDust(0.3, 0.05, 0.0121) === false, "frontera: $0.2×5% = $0.010 < gas; $0.3×5% = $0.015 > gas");
process.exit(fails ? 1 : 0);
