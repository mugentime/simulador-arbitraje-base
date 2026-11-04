// minProfit on-chain cubre lo pagado en gas/propina/builder: si no, la tx revierte (en bundle no cuesta).
import fs from "node:fs";
import { ethers } from "ethers";
import { Executor } from "../server/executor.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const ART = JSON.parse(fs.readFileSync(new URL("../server/artifacts/ArbExecutor.json", import.meta.url)));
const ex = Object.create(Executor.prototype); ex.iface = new ethers.Interface(ART.abi);
const hop = [0, "0x" + "1".repeat(40), "0x" + "2".repeat(40), "0x" + "3".repeat(40), 30, 0, 0, "0x"];
const mk = (sym, dec, minProfit) => ({ source: 3, lender: "0x" + "4".repeat(40), token: "0x" + "2".repeat(40), amount: 10n ** 21n, minProfit, hops: [hop], meta: { startTok: { sym, decimals: dec } } });
const dec = (data) => ex.iface.decodeFunctionData("execute", data)[0][4];
let mp = dec(ex.encodeWithCost(mk("USDT", 18, 1n), 0.5, 3000));
ok(mp === BigInt(Math.floor(0.5 * 1.02 * 1e18)), "dólar: costo $0.50 → minProfit 0.51 USDT");
mp = dec(ex.encodeWithCost(mk("WETH", 18, 1n), 3, 3000));
ok(mp === BigInt(Math.floor((3 / 3000) * 1.02 * 1e18)), "WETH: costo $3 a $3000/ETH → 0.00102 WETH");
mp = dec(ex.encodeWithCost(mk("USDC", 6, 10n ** 7n), 0.5, 3000));
ok(mp === 10n ** 7n, "si el minProfit del plan ya es mayor, se conserva");
ok(ART.abi.some((x) => x.name === "pancakeV3FlashCallback"), "artefacto con flash v3");
