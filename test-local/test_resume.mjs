import assert from "node:assert";
import { resumeTag, backrunWorthIt } from "../server/executor.mjs";
assert.equal(resumeTag(undefined, {}), null);
assert.equal(resumeTag("0", {}), null);
assert.equal(resumeTag("r1", { resumedWith: null }), "r1");
assert.equal(resumeTag("r1", { resumedWith: "r1" }), null);
assert.equal(resumeTag(" r2 ", { resumedWith: "r1" }), "r2");
assert.equal(backrunWorthIt(0.035, 0.02, 2), false); // caso real de Polygon 12:45: modelo $0.035 con gas $0.02
assert.equal(backrunWorthIt(0.17, 0.042, 2), true);
assert.equal(backrunWorthIt(0.01, 0.02, 0), false);
console.log("test_resume OK");
