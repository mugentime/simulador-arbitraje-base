// Conmutación del WebSocket de eventos: 429 en Alchemy → público; vuelta al principal tras PRIMARY_RETRY_MS.
import assert from "node:assert";
import { EventFeed } from "../server/events.mjs";
const logs = [];
const f = new EventFeed({ url: "wss://base-mainnet.g.alchemy.com/v2/KEY", fast: null, diag: (m) => logs.push(m), pending: true,
  fallbacks: ["wss://base-rpc.publicnode.com", "wss://base.drpc.org"] });
assert.equal(f.urls.length, 3); assert.equal(f.e.kind, "pendingLogs");
// un 429 deja fails en FAIL_SWITCH-1; el cierre sin abrir lo completa → rota
f.fails = 2; f.fails++; // equivalente a error 429 + close sin abrir
f.e.connected = false;
let u = f.pickUrl(1_000);
assert.equal(u, "wss://base-rpc.publicnode.com"); assert.equal(f.e.kind, "logs"); assert.equal(f.pending, false);
assert.equal(f.e.ws, "base-rpc.publicnode.com"); assert.equal(f.e.switches, 1);
assert.ok(logs[0].includes("base-rpc.publicnode.com")); assert.ok(!logs.join(" ").includes("KEY"), "no debe filtrar la clave");
// fallos sueltos (< FAIL_SWITCH) no rotan
f.fails = 1; assert.equal(f.pickUrl(2_000), "wss://base-rpc.publicnode.com");
// tras 30 min desconectado del público, vuelve a probar el principal con pendingLogs
f.fails = 0; u = f.pickUrl(1_000 + 30 * 60_000);
assert.equal(u, "wss://base-mainnet.g.alchemy.com/v2/KEY"); assert.equal(f.pending, true); assert.equal(f.e.kind, "pendingLogs");
// conectado a un público: maybeReturnToPrimary cierra y vuelve
f.idx = 1; f.url = f.urls[1]; f.switchedAt = 0; f.e.connected = true; f.ws = { close() { this.closed = true; } };
assert.equal(f.maybeReturnToPrimary(10 * 60_000), false);
assert.equal(f.maybeReturnToPrimary(31 * 60_000), true); assert.equal(f.idx, 0); assert.ok(f.ws.closed);
// sin respaldo: nunca rota
const g = new EventFeed({ url: "wss://x.example", fast: null, diag: () => {}, fallbacks: [] });
g.fails = 9; assert.equal(g.pickUrl(), "wss://x.example");
console.log("test_events_fallback OK");
