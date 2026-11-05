// bundleMaxBlock: el último bloque válido no queda por detrás de la punta real aunque el RPC/worker vayan atrasados;
// bundleAllReverted: detecta rechazos porque la tx revierte en la simulación de los builders.
import { bundleMaxBlock, bundleAllReverted } from "../server/executor.mjs";
let ok = true; const check = (c, m) => { console.log((c ? "OK  " : "FAIL") + " " + m); ok &&= c; };
const seen = { n: 0, at: 0 };
check(bundleMaxBlock({ head: 100, lastChainBlock: 98, seen, now: 1000, blockMs: 750, blocks: 10 }) === 110, "punta conocida + margen");
// 3 s después el RPC sigue diciendo 100 (atrasado): se estima 100 + 3000/750 = 104
check(bundleMaxBlock({ head: 100, lastChainBlock: 99, seen, now: 4000, blockMs: 750, blocks: 10 }) === 114, "estimación por tiempo con RPC atrasado");
// llega un head mayor: se reinicia la referencia
check(bundleMaxBlock({ head: 120, lastChainBlock: 99, seen, now: 4100, blockMs: 750, blocks: 10 }) === 130 && seen.n === 120, "head nuevo actualiza la referencia");
check(bundleMaxBlock({ head: 50, lastChainBlock: 0, blocks: 6 }) === 56, "sin referencia de tiempo");
check(bundleAllReverted({ "48 Club": "-32000 [0xe3f0..ceed] execution reverted", BlockRazor: "-38000 transaction execution failed:", NodeReal: "HTTP 429 {...}" }), "todos revierten (NodeReal 429 no cuenta)");
check(!bundleAllReverted({ BlockRazor: "-38000 the maxBlockNumber should be lager than currentBlockNum", "48 Club": "execution reverted" }), "maxBlockNumber vencido no es revert");
check(!bundleAllReverted({ NodeReal: "HTTP 429" }), "solo 429 no es revert");
check(!bundleAllReverted({}), "sin errores");
console.log(ok ? "TODO OK" : "HAY FALLOS"); process.exit(ok ? 0 : 1);
