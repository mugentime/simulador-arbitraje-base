// Re-chequeo local antes de simular: si con el estado actual de los pools la ruta ya no devuelve el préstamo, no se simula.
import { modelStillOpen } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const T = (sym, i) => ({ sym, address: "0x" + String(i).repeat(40).slice(0, 40), decimals: 18 });
const W = T("WETH", 1), U = T("USDC", 2);
const E = 10n ** 18n;
const v2 = (addr, r0, r1) => ({ address: addr, kind: "v2", dex: "v2", token0: W, token1: U, reserve0: r0, reserve1: r1, feeBps: 30, feePips: 3000n });
const sell = v2("0xa", 20n * E, 66000n * E), buy = v2("0xb", 50n * E, 150000n * E); // 3300 vs 3000: W→U en a, U→W en b
const amt = E / 2n;
ok(modelStillOpen([sell, buy], W.address, amt) === true, "ruta abierta con desajuste de 10 %");
sell.reserve1 = 60000n * E; // otro bot cerró el desajuste (3000 = 3000)
ok(modelStillOpen([sell, buy], W.address, amt) === false, "ruta cerrada tras actualizar el pool → no se simula");
ok(modelStillOpen([{ kind: "raro", token0: W, token1: U }], W.address, amt) === null || modelStillOpen([{ kind: "raro", token0: W, token1: U }], W.address, amt) === false, "pool desconocido no rompe");
ok(modelStillOpen([null], W.address, amt) === null, "error del modelo → null (no se omite)");
console.log("test_presim_recheck OK");
