// Estado por eventos: un WS falso emite Swap v3, Swap v4 y Sync v2; el feed los aplica y dispara evaluateChanged.
import { WebSocketServer } from "ws";
import { ethers } from "ethers";
import { EventFeed, EVENT_TOPICS, applyLog } from "../server/events.mjs";
import * as core from "../src/core.js";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const enc = (types, vals) => ethers.AbiCoder.defaultAbiCoder().encode(types, vals);
const v3 = { address: "0x00000000000000000000000000000000000000a3", kind: "v3", sqrtPriceX96: 1n, liquidity: 1n };
const v2 = { address: "0x00000000000000000000000000000000000000b2", kind: "v2", reserve0: 1n, reserve1: 1n };
const v4id = "0x" + "4".repeat(64);
const v4 = { address: v4id, kind: "v4", sqrtPriceX96: 1n, liquidity: 1n };
const byKey = new Map([v3, v2, v4].map((p) => [p.address.toLowerCase(), p]));
const sqrt = 2n ** 96n * 30n;
// applyLog directo
let a = applyLog(byKey, { address: v3.address, topics: [EVENT_TOPICS[0]], data: enc(["int256", "int256", "uint160", "uint128", "int24"], [5n, -3n, sqrt, 10n ** 18n, 68000]) });
ok(a === v3.address && v3.sqrtPriceX96 === sqrt && v3.liquidity === 10n ** 18n && v3.tick === 68000 && v3.reserve0 > 0n, "Swap v3 actualiza precio, liquidez, tick y reservas");
a = applyLog(byKey, { address: "0x0000000000000000000000000000000000000099", topics: [EVENT_TOPICS[2], v4id], data: enc(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [1n, -1n, sqrt, 7n * 10n ** 17n, -12, 500]) });
ok(a === v4id && v4.liquidity === 7n * 10n ** 17n && v4.tick === -12, "Swap v4 se busca por poolId");
a = applyLog(byKey, { address: v2.address, topics: [EVENT_TOPICS[3]], data: enc(["uint112", "uint112"], [111n, 222n]) });
ok(a === v2.address && v2.reserve0 === 111n && v2.reserve1 === 222n, "Sync v2 actualiza reservas");
ok(applyLog(byKey, { address: "0x0000000000000000000000000000000000000077", topics: [EVENT_TOPICS[0]], data: "0x" }) === null, "pool desconocido se ignora");
// feed por WS con pendingLogs no soportado → cae a logs
const wss = new WebSocketServer({ port: 0 });
let subs = [];
wss.on("connection", (s) => s.on("message", (raw) => {
  const m = JSON.parse(raw); subs.push(m.params[0]);
  if (m.params[0] === "pendingLogs") return s.send(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unsupported" } }));
  s.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xsub" }));
  const log = (addr, topic, data) => s.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xsub", result: { address: addr, topics: [topic], data } } }));
  log(v2.address, EVENT_TOPICS[3], enc(["uint112", "uint112"], [5n, 6n]));
  log(v3.address, EVENT_TOPICS[0], enc(["int256", "int256", "uint160", "uint128", "int24"], [1n, -1n, sqrt, 3n, 1]));
}));
const calls = [];
const fast = { byKey, evaluateChanged: async (ch, src) => { calls.push([...ch, src]); return { profitable: 1, sent: false }; } };
const feed = new EventFeed({ url: `ws://127.0.0.1:${wss.address().port}`, fast, diag: async () => {}, pending: true });
feed.start();
await new Promise((r) => setTimeout(r, 1500));
ok(subs[0] === "pendingLogs" && subs.includes("logs"), "sin pendingLogs reintenta con logs");
ok(feed.e.applied === 2 && v2.reserve0 === 5n, "aplica los dos eventos recibidos");
ok(calls.length >= 1 && calls.flat().includes(v2.address) && calls.flat().includes(v3.address), "dispara evaluateChanged con los pools cambiados (agrupados)");
ok(feed.e.profitable >= 1, "cuenta rentables");
wss.close(); process.exit(0);
