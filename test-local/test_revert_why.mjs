// Diagnóstico de reverts enviados: se repite la llamada sobre el estado anterior a su bloque.
import { Executor } from "../server/executor.mjs";
import { ethers } from "ethers";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const iface = new ethers.Interface(["error InsufficientProfit(uint256,uint256)"]);
const mk = (callImpl) => {
  const ex = Object.create(Executor.prototype);
  ex.p1 = {}; ex.iface = iface;
  ex.provider = { getTransaction: async () => ({ from: "0x1", to: "0x2", data: "0xab", gasLimit: 500000n }), call: callImpl };
  return ex;
};
let seenTag = null;
let ex = mk(async (c) => { seenTag = c.blockTag; return "0x"; });
let r = await ex.revertWhy("0xh", { blockNumber: 100, index: 7 });
ok(seenTag === 99 && /mismo bloque/.test(r) && /posición 7/.test(r) && ex.p1.lostWhy.sameBlock === 1, `pasa antes del bloque → mismo bloque (${r})`);
const data = iface.encodeErrorResult("InsufficientProfit", [5n, 9n]);
ex = mk(async () => { const e = new Error("revert"); e.data = data; throw e; });
r = await ex.revertWhy("0xh", { blockNumber: 100, index: 0 });
ok(/tarde/.test(r) && /InsufficientProfit\(5,9\)/.test(r) && ex.p1.lostWhy.late === 1, `ya revertía → tarde (${r})`);
ex = mk(async () => "0x"); ex.provider.getTransaction = async () => null;
r = await ex.revertWhy("0xh", { blockNumber: 100, index: 3 });
ok(ex.p1.lostWhy.unknown === 1 && r === "posición 3 en el bloque", `sin tx → sin dato (${r})`);
process.env.REVERT_WHY = "0"; ex = mk(async () => "0x");
ok((await ex.revertWhy("0xh", { blockNumber: 1 })) === "" && !ex.p1.lostWhy, "REVERT_WHY=0 lo apaga");
console.log("test_revert_why OK");
