// Rutas fantasma: ≥5 reverts sin ningún ok → fuera del acumulado; un ok la rehabilita.
import * as core from "../src/core.js";
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const route = [{ address: "0xAAA" }, { address: "0xBBB" }];
const ex = Object.create(Executor.prototype); ex.p1 = {};
for (let i = 0; i < 4; i++) ex.markRoute(route, false);
ok(!core.PHANTOM_ROUTES.has(core.routeId(route)), "4 reverts: aún no es fantasma");
ex.markRoute(route, false);
ok(core.PHANTOM_ROUTES.has(core.routeId(route)), "5 reverts sin ok: fantasma");
ex.markRoute(route, true);
ok(!core.PHANTOM_ROUTES.has(core.routeId(route)), "un ok la rehabilita");
for (let i = 0; i < 10; i++) ex.markRoute(route, false);
ok(!core.PHANTOM_ROUTES.has(core.routeId(route)), "con algún ok previo no vuelve a ser fantasma");
// las rutas fantasma no se simulan en cada bloque: una re-comprobación cada PHANTOM_RECHECK_BLOCKS
const r2 = [{ address: "0xCCC" }, { address: "0xDDD" }];
for (let i = 0; i < 5; i++) ex.markRoute(r2, false);
ex.lastChainBlock = 1000;
ok(ex.phantomSkip({ route: r2 }) === false, "primera vez se permite re-comprobar");
ex.lastChainBlock = 1001;
ok(ex.phantomSkip({ route: r2 }) === true, "bloque siguiente: se salta");
ex.lastChainBlock = 1601;
ok(ex.phantomSkip({ route: r2 }) === false, "600 bloques después: se re-comprueba");
ok(ex.phantomSkip({ route: [{ address: "0xEEE" }] }) === false, "ruta normal no se salta");
