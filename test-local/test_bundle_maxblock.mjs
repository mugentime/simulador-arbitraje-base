// bundleMaxBlock: el último bloque válido no queda por detrás de la punta real aunque el RPC/worker vayan atrasados;
// bundleAllReverted: detecta rechazos porque la tx revierte en la simulación de los builders.
import { bundleMaxBlock, bundleAllReverted, bundleBlockExpired, bundleMarginAdjust } from "../server/executor.mjs";
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
// ritmo medido: 100 bloques en 45 s → 450 ms/bloque; 9 s sin bloque nuevo → +20 (no +12 con 750 fijo)
{ const sn = { n: 0, at: 0 };
  bundleMaxBlock({ head: 1000, seen: sn, now: 1000, blockMs: 750, blocks: 10 });
  bundleMaxBlock({ head: 1100, seen: sn, now: 46000, blockMs: 750, blocks: 10 });
  check(Math.abs(sn.msPer - 450) < 1, "mide 450 ms/bloque");
  check(bundleMaxBlock({ head: 1100, seen: sn, now: 55000, blockMs: 750, blocks: 10 }) === 1130, "estima con el ritmo medido");
  check(bundleMarginAdjust(sn, true) === 10 && bundleMaxBlock({ head: 1100, seen: sn, now: 55000, blockMs: 750, blocks: 10 }) === 1140, "margen adaptativo +10 al vencer");
  bundleMarginAdjust(sn, false); check(sn.extra === 9, "margen baja 1 al aceptarse");
  for (let i = 0; i < 10; i++) bundleMarginAdjust(sn, true); check(sn.extra === 60, "tope 60"); }
check(bundleBlockExpired({ "48 Club": "-38000 the maxBlockNumber should not be less than currentBlockNum", BlockRazor: "-38000 the maxBlockNumber should be lager than currentBlockNum", NodeReal: "HTTP 429 {}" }), "vencido detectado");
check(!bundleBlockExpired({ "48 Club": "-32000 execution reverted", BlockRazor: "maxBlockNumber should be lager" }), "mixto con revert no es vencido");
console.log(ok ? "TODO OK" : "HAY FALLOS"); process.exit(ok ? 0 : 1);
