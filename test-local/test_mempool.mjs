import { ethers } from "ethers";
import { decodeSwaps, rawFromPending, applySwaps, findPool } from "/home/claude/simulador-arbitraje-base/server/mempool.mjs";
let ok = true; const check = (c, m) => { console.log((c ? "OK  " : "FAIL") + " " + m); ok &&= c; };
const A = "0x55d398326f99059fF775485246999027B3197955", B = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", C = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const I = new ethers.Interface([
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "function swapExactETHForTokens(uint256,address[],address,uint256)",
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  "function multicall(uint256,bytes[])",
]);
// 1) v2 con ruta de 2 saltos
let s = decodeSwaps(I.encodeFunctionData("swapExactTokensForTokens", [1000n, 1n, [A, B, C], A, 9999999999n]));
check(s.length === 2 && s[0].tokenIn === A && s[0].tokenOut === B && s[0].amountIn === 1000n && s[1].amountIn === null, "v2: ruta de 2 saltos, entrada del primero conocida");
// 2) ETH nativo: amountIn = value
s = decodeSwaps(I.encodeFunctionData("swapExactETHForTokens", [1n, [B, A], A, 9999999999n]), 5n * 10n ** 18n);
check(s.length === 1 && s[0].amountIn === 5n * 10n ** 18n, "v2 ETH→token: la entrada es el value");
// 3) multicall(deadline, [exactInputSingle])
const inner = I.encodeFunctionData("exactInputSingle", [[A, B, 500, A, 777n, 1n, 0n]]);
s = decodeSwaps(I.encodeFunctionData("multicall", [9999999999n, [inner]]));
check(s.length === 1 && s[0].kind === "v3" && s[0].fee === 500 && s[0].amountIn === 777n, "v3: exactInputSingle dentro de multicall");
check(decodeSwaps("0xdeadbeef").length === 0, "calldata desconocido → sin swaps");
// 4) reconstrucción de la tx cruda desde el objeto pendiente (legacy y 1559)
const w = ethers.Wallet.createRandom();
for (const tx of [
  { type: 0, chainId: 56n, nonce: 7, gasLimit: 210000n, gasPrice: 1000000000n, to: B, value: 0n, data: "0x1234" },
  { type: 2, chainId: 56n, nonce: 8, gasLimit: 210000n, maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, to: B, value: 1n, data: "0xabcd" },
]) {
  const raw = await w.signTransaction(tx);
  const t = ethers.Transaction.from(raw);
  const rpcObj = { hash: t.hash, type: "0x" + t.type.toString(16), chainId: "0x" + t.chainId.toString(16), nonce: "0x" + t.nonce.toString(16), gas: "0x" + t.gasLimit.toString(16), to: t.to, value: "0x" + t.value.toString(16), input: t.data,
    r: t.signature.r, s: t.signature.s, v: "0x" + t.signature.v.toString(16), ...(t.type === 2 ? { maxFeePerGas: "0x" + t.maxFeePerGas.toString(16), maxPriorityFeePerGas: "0x" + t.maxPriorityFeePerGas.toString(16), accessList: [] } : { gasPrice: "0x" + t.gasPrice.toString(16) }) };
  if (t.type === 0) rpcObj.v = "0x" + (t.signature.yParity + 35 + 2 * 56).toString(16);
  check(rawFromPending(rpcObj) === raw, `tx tipo ${t.type} reconstruida idéntica (mismo hash)`);
}
// 5) aplicar swaps al modelo
const tok = (address, sym) => ({ address, sym, decimals: 18 });
const P1 = { address: "0xp1", dex: "PancakeSwap v2", kind: "v2", token0: tok(A, "USDT"), token1: tok(B, "WBNB"), reserve0: 600000n * 10n ** 18n, reserve1: 1000n * 10n ** 18n, feeBps: 25, feePips: 2500n };
const P2 = { ...P1, address: "0xp2", dex: "Biswap v2" };
const router = { dex: "PancakeSwap v2", kind: "v2" };
check(findPool([P2, P1], router, { kind: "v2", tokenIn: A, tokenOut: B }) === P1, "encuentra el pool del DEX correcto");
const r = applySwaps([P1, P2], router, [{ kind: "v2", tokenIn: A, tokenOut: B, amountIn: 60000n * 10n ** 18n }]);
const np = r.pools.find((p) => p.address === "0xp1");
check(r.touched[0] === "0xp1" && np.reserve0 === P1.reserve0 + 60000n * 10n ** 18n && np.reserve1 < P1.reserve1 && P1.reserve0 === 600000n * 10n ** 18n, "el swap mueve las reservas de la copia, no del original");
check(applySwaps([P2], router, [{ kind: "v2", tokenIn: A, tokenOut: B, amountIn: 1n }]) === null, "pool desconocido → no se modela");
process.exit(ok ? 0 : 1);
