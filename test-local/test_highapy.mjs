// Modo automático ≥1000 %: elegibles, destino estable y reglas de salida.
import { scanHighApy, pickTarget, exitCheck } from "../server/highapy.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const R = { minApyPct: 1000, minTvl: 100_000, exitApyPct: 500, exitTvlMult: 3, exitHours: 6, blocked: [] };
globalThis.fetch = async (url) => ({ ok: true, json: async () => {
  const u = String(url);
  if (u.endsWith("/gov-vaults")) return [{ id: "zec-rp", name: "ZEC", chain: "bsc", status: "active", tokenAddress: "0xA" }, { id: "cap-rp", name: "CAP", chain: "bsc", status: "active", tokenAddress: "0xB" }, { id: "x-rp", chain: "bsc", status: "active", tokenAddress: "0xC" }, { id: "b-rp", chain: "base", status: "active", tokenAddress: "0xD" }];
  if (u.endsWith("/cow-vaults")) return [{ chain: "bsc", earnContractAddress: "0xa", platformId: "uniswap" }, { chain: "bsc", earnContractAddress: "0xb" }, { chain: "bsc", earnContractAddress: "0xc" }];
  if (u.endsWith("/apy/breakdown")) return { "zec-rp": { totalApy: 17.46 }, "cap-rp": { totalApy: 1590963 }, "x-rp": { totalApy: 3 } };
  return { bsc: { "zec-rp": 318000, "cap-rp": 3500, "x-rp": 900000 } };
} });
const s = await scanHighApy("bsc", R);
ok(s.eligible.length === 1 && s.eligible[0].id === "zec-rp", `elegibles: ${s.eligible.map((x) => x.id)} (CAP fuera por TVL, X por APY)`);
ok(pickTarget([{ id: "a" }, { id: "b" }], "b") === "b" && pickTarget([{ id: "a" }], "b") === "a" && pickTarget([], "b") === null, "se queda con el actual si sigue elegible");
const t0 = 1e12;
let c = exitCheck({ apyPct: 1700, tvl: 300000 }, { apyPct: 1200, tvl: 400000 }, null, t0, R); ok(!c.exit && !c.why, "sano → no sale");
c = exitCheck({ apyPct: 1700, tvl: 300000 }, { apyPct: 400, tvl: 300000 }, null, t0, R); ok(!c.exit && c.badSince === t0, "APY < 500 % → vigilancia");
c = exitCheck({ apyPct: 1700, tvl: 300000 }, { apyPct: 400, tvl: 300000 }, t0, t0 + 7 * 3600_000, R); ok(c.exit, "6 h seguidas → sale");
c = exitCheck({ apyPct: 1700, tvl: 300000 }, { apyPct: 1500, tvl: 1_000_000 }, t0, t0 + 7 * 3600_000, R); ok(c.exit && /TVL/.test(c.why), "TVL ×3.3 → sale");
c = exitCheck({ apyPct: 1700, tvl: 300000 }, { apyPct: 1500, tvl: 350000 }, t0, t0 + 7 * 3600_000, R); ok(!c.exit && c.badSince === null, "se recupera → reinicia vigilancia");
c = exitCheck({ apyPct: 1700, tvl: 300000 }, null, null, t0, R); ok(c.exit, "vault retirado → sale de inmediato");
console.log(fails ? "HAY FALLAS" : "todo OK"); process.exit(fails ? 1 : 0);
