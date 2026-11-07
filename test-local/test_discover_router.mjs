// Descubrimiento del router de una fábrica Slipstream desconocida a partir de los sender de los Swap del pool
import { ethers } from "ethers";
import { discoverRouter } from "../server/beefyclm.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const A = (n) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const POOL = A(1), FACT = A(2), AGG = A(3), ROUTER = A(4), OTHER = A(5), BAD = A(6);
const I = new ethers.Interface(["function factory() view returns (address)"]);
const T = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const log = (sender) => ({ topics: [T, ethers.zeroPadValue(sender, 32), ethers.zeroPadValue(A(9), 32)] });
const mem = {}, logs = [];
const s = {
  store: { get: async (k) => mem[k], set: async (k, v) => { mem[k] = v; } }, diag: async (m) => logs.push(m), me: A(7),
  provider: {
    getBlockNumber: async () => 100000,
    getLogs: async () => [log(AGG), log(AGG), log(AGG), log(BAD), log(ROUTER), log(OTHER)],
    call: async ({ to }) => { if (to === AGG) throw new Error("sin factory"); return I.encodeFunctionResult("factory", [to === OTHER ? A(8) : FACT]); },
    getCode: async (a) => (a === ROUTER ? "0x6080a026383e00" : "0x6080deadbeef"),
  },
};
const r = await discoverRouter(s, POOL, FACT);
ok(r === ROUTER, "elige el sender cuyo factory() es la fábrica y que tiene exactInputSingle de Slipstream (descarta agregador, otra fábrica y sin la función)");
ok(mem.slipRouters?.[FACT.toLowerCase()] === ROUTER && logs.some((l) => /router Slipstream descubierto/.test(l)), "se guarda en el store y se registra");
s.provider.getLogs = async () => { throw new Error("no debería volver a leer"); };
ok((await discoverRouter(s, POOL, FACT)) === ROUTER, "segunda vez: desde la caché");
console.log(fails ? `${fails} FALLAS` : "todo OK"); process.exit(fails ? 1 : 0);
