// Prefetch de nonce/gasPrice para bundles: se usa solo si es reciente; un valor viejo o incompleto obliga a leer del RPC.
import { bundlePreFresh } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const now = 1_000_000;
const pre = { block: 100, head: 100, nonce: 7, gasPrice: 50_000_000n, at: now - 800 };
ok(bundlePreFresh(pre, now, 450) === pre, "prefetch de hace 0.8 s se usa (BSC, 450 ms/bloque)");
ok(bundlePreFresh({ ...pre, at: now - 1600 }, now, 450) === null, "prefetch de 1.6 s se descarta");
ok(bundlePreFresh({ ...pre, at: now - 5000 }, now, 2000) !== null, "con bloques de 2 s vale hasta 6 s");
ok(bundlePreFresh(null, now) === null, "sin prefetch → null");
ok(bundlePreFresh({ ...pre, gasPrice: 5 }, now) === null, "gasPrice no bigint → null");
ok(bundlePreFresh({ ...pre, nonce: undefined }, now) === null, "sin nonce → null");
console.log("test_bundle_prefetch OK");
