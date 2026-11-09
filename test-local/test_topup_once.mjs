// TOPUP_ONCE: parseo del envío único desde Base.
import assert from "node:assert/strict";
import { parseTopupOnce } from "../server/bridge.mjs";

assert.deepEqual(parseTopupOnce("robinhood:35@r1"), { chainKey: "robinhood", usd: 35, tag: "r1" });
assert.deepEqual(parseTopupOnce(" robinhood : 12.5 @ mover-2026-11-09 "), { chainKey: "robinhood", usd: 12.5, tag: "mover-2026-11-09" });
assert.equal(parseTopupOnce(""), null);
assert.equal(parseTopupOnce(undefined), null);
assert.equal(parseTopupOnce("robinhood:35"), null);
assert.equal(parseTopupOnce("robinhood:0@r1"), null);
console.log("test_topup_once ok");
