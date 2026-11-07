import { ethers } from "ethers";
import { WithdrawGuard } from "../server/withdrawguard.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const me = "0x327526EC22821c0667d4A02FaEe50794281b965d", jose = "0x1111111111111111111111111111111111111111", thief = "0x2222222222222222222222222222222222222222", router = "0x2626664c2603336E57B271c5C0b26F421741e481", token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const provider = { getCode: async (a) => (a.toLowerCase() === router.toLowerCase() || a.toLowerCase() === token.toLowerCase() ? "0x6080" : "0x") };
process.env.WITHDRAW_WHITELIST = jose;
const g = new WithdrawGuard({ provider, me });
const I = new ethers.Interface(["function transfer(address,uint256)", "function approve(address,uint256)", "function transferFrom(address,address,uint256)"]);
const t = async (tx) => { try { await g.check(tx); return "ok"; } catch (e) { return e.code; } };
ok(await t({ to: thief, value: 1n }) === "WITHDRAW_BLOCKED", "ETH a cuenta ajena: bloqueado");
ok(await t({ to: jose, value: 10n ** 18n }) === "ok", "ETH a la cuenta autorizada: permitido");
ok(await t({ to: router, value: 1n, data: "0x1234" }) === "ok", "ETH a un contrato (swap/bridge): permitido");
ok(await t({ to: token, data: I.encodeFunctionData("transfer", [thief, 5n]) }) === "WITHDRAW_BLOCKED", "transfer de token a cuenta ajena: bloqueado");
ok(await t({ to: token, data: I.encodeFunctionData("transfer", [router, 5n]) }) === "WITHDRAW_BLOCKED", "transfer de token a un contrato no autorizado: bloqueado");
ok(await t({ to: token, data: I.encodeFunctionData("transfer", [jose, 5n]) }) === "ok", "transfer de token a la cuenta autorizada: permitido");
ok(await t({ to: token, data: I.encodeFunctionData("transferFrom", [me, thief, 5n]) }) === "WITHDRAW_BLOCKED", "transferFrom a cuenta ajena: bloqueado");
ok(await t({ to: token, data: I.encodeFunctionData("approve", [thief, 5n]) }) === "WITHDRAW_BLOCKED", "approve a una cuenta: bloqueado");
ok(await t({ to: token, data: I.encodeFunctionData("approve", [router, 5n]) }) === "ok", "approve a un router: permitido");
ok(await t({ data: "0x6080", value: 0n }) === "ok", "despliegue sin valor: permitido");
let sent = 0; const w = g.wrap({ address: me, sendTransaction: async () => { sent++; return { hash: "0x1" }; }, signer: { sendTransaction: async () => { sent++; } } });
try { await w.sendTransaction({ to: thief, value: 1n }); } catch {}
try { await w.signer.sendTransaction({ to: thief, value: 1n }); } catch {}
await w.sendTransaction({ to: router, value: 1n, data: "0x12" });
ok(sent === 1 && w.address === me, `el firmante envuelto solo envía lo permitido (${sent})`);
console.log(fails ? "HAY FALLAS" : "todo OK"); process.exit(fails ? 1 : 0);
