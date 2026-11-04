// Decodificación de Universal Router (V3/V2_SWAP_EXACT_IN, WRAP_ETH + CONTRACT_BALANCE) y exactInput multi-salto.
import { ethers } from "ethers";
import { decodeSwaps, findPool } from "../server/mempool.mjs";
const ok = (c, m) => { if (!c) { console.error("FALLO:", m); process.exit(1); } console.log("ok:", m); };
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40);
const abi = ethers.AbiCoder.defaultAbiCoder();
const path = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [A, 500, B, 3000, C]);
const ur = new ethers.Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline)"]);
// 1) V3_SWAP_EXACT_IN multi-salto
let data = ur.encodeFunctionData("execute", ["0x00", [abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [A, 1000n, 1n, path, true])], 9999999999n]);
let s = decodeSwaps(data);
ok(s.length === 2 && s[0].amountIn === 1000n && s[0].fee === 500 && s[1].amountIn === null && s[1].fee === 3000 && s[1].tokenOut === ethers.getAddress(C), "V3 multi-salto: 2 swaps, el segundo encadenado");
// 2) WRAP_ETH + V2_SWAP_EXACT_IN con CONTRACT_BALANCE, bandera allow-revert (0x80) en el comando
const CB = 1n << 255n;
data = ur.encodeFunctionData("execute", ["0x0b88", [abi.encode(["address", "uint256"], [A, 5n]), abi.encode(["address", "uint256", "uint256", "address[]", "bool"], [A, CB, 1n, [A, B], false])], 1n]);
s = decodeSwaps(data, 777n);
ok(s.length === 1 && s[0].kind === "v2" && s[0].amountIn === 777n, "WRAP_ETH + V2 con CONTRACT_BALANCE → usa msg.value");
// 3) comando desconocido + V3: el desconocido se ignora
data = ur.encodeFunctionData("execute", ["0x0a00", ["0x1234", abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [A, 5n, 1n, path, true])], 1n]);
ok(decodeSwaps(data).length === 2, "comandos desconocidos se ignoran");
// 4) exactInput de SwapRouter02
const r2 = new ethers.Interface(["function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum))"]);
s = decodeSwaps(r2.encodeFunctionData("exactInput", [[path, A, 42n, 1n]]));
ok(s.length === 2 && s[0].amountIn === 42n, "exactInput (SwapRouter02)");
// 5) findPool usa el DEX por tipo del router
const pools = [{ kind: "v2", dex: "PancakeSwap v2", token0: { address: A }, token1: { address: B } }, { kind: "v3", dex: "PancakeSwap v3", feePips: 500n, token0: { address: A }, token1: { address: B } }];
const router = { dex: "PancakeSwap v3", v2Dex: "PancakeSwap v2", v3Dex: "PancakeSwap v3" };
ok(findPool(pools, router, { kind: "v2", tokenIn: A, tokenOut: B })?.dex === "PancakeSwap v2", "swap v2 del router → pool PancakeSwap v2");
ok(findPool(pools, router, { kind: "v3", tokenIn: A, tokenOut: B, fee: 500 })?.dex === "PancakeSwap v3", "swap v3 del router → pool PancakeSwap v3");
