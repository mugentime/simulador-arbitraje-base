// Estrategia "beefy-clm": ETH de la wallet → vault Beefy CLM (Aerodrome Slipstream) sobre un par X/USDC en Base.
// Por defecto NVDAc-USDC (aero-cow-base-usdc-nvdac-vault): el CLM de Beefy con mayor APY estable medido el 2026-11-05.
// Pasos (cada uno se simula con eth_call antes de enviarse y queda registrado; los ya hechos no se repiten):
//   1) swap ETH→USDC (Uniswap v3 0.05 %)  2) swap de la parte de USDC→X en el pool del CLM según la proporción del CLM
//   3) deposit(amount0, amount1, minShares) en el CLM (si el CLM no está "calm" la simulación revierte → reintento en 1 min)
//   4) deposit de las participaciones del CLM en el vault de Beefy que compone las emisiones.
// Salida ("beefy-clm-exit"): withdrawAll del vault → withdraw del CLM → X→USDC → USDC→ETH.
import { ethers } from "ethers";
import { BASE, spendable, minOut } from "./strategy.mjs";

// fábricas de Slipstream en Base → su SwapRouter (aerodrome-finance/slipstream README)
export const SLIP_ROUTERS = {
  "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a": "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
  "0xade65c38cd4849adba595a4323a8c7ddfe89716a": "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D",
  "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef": "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
};
const C = new ethers.Interface([
  "function wants() view returns (address token0, address token1)",
  "function strategy() view returns (address)",
  "function pool() view returns (address)",
  "function factory() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function balances() view returns (uint256 amount0, uint256 amount1)",
  "function previewDeposit(uint256 _amount0, uint256 _amount1) view returns (uint256 shares, uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1)",
  "function deposit(uint256 _amount0, uint256 _amount1, uint256 _minShares)",
  "function previewWithdraw(uint256 _shares) view returns (uint256 amount0, uint256 amount1)",
  "function withdraw(uint256 _shares, uint256 _minAmount0, uint256 _minAmount1)",
  "function want() view returns (address)",
  "function deposit(uint256 _amount)",
  "function withdrawAll()",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);
const U = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const retry = (m) => Object.assign(new Error(m), { retry: true });
const lc = (a) => a.toLowerCase();

/** Fracción de USDC a cambiar por X para depositar en la proporción del CLM. r = X por USDC (crudo), R = balX/balUSDC del CLM. */
export function swapFraction(r, balX, balU) {
  if (balU === 0) return 1; if (balX === 0) return 0;
  const R = balX / balU; return R / (r + R);
}

async function call(s, to, fn, args = [], iface = C) { return iface.decodeFunctionResult(fn, await s.provider.call({ from: s.me, to, data: iface.encodeFunctionData(fn, args) })); }
async function approve(s, token, spender, amt, step) {
  const [a] = await call(s, token, "allowance", [s.me, spender]);
  if (a < amt) await s.send(step, { to: token, data: C.encodeFunctionData("approve", [spender, amt]) });
}
async function bal(s, token) { return (await call(s, token, "balanceOf", [s.me]))[0]; }

/** Datos del vault y del CLM (API de Beefy + verificación on-chain). */
async function resolve(s) {
  const r = s.run;
  if (r.vault) return;
  const id = process.env.STRATEGY_VAULT_ID || "aero-cow-base-usdc-nvdac-vault";
  const list = await (await fetch("https://api.beefy.finance/vaults", { signal: AbortSignal.timeout(20_000) })).json();
  const v = list.find((x) => x.id === id);
  if (!v) throw new Error(`vault ${id} no está en la API de Beefy`);
  if (v.chain !== "base" || v.status !== "active") throw new Error(`vault ${id}: cadena ${v.chain}, estado ${v.status}`);
  const vault = ethers.getAddress(v.earnContractAddress), clm = ethers.getAddress(v.tokenAddress);
  const [want] = await call(s, vault, "want");
  if (lc(want) !== lc(clm)) throw new Error(`want del vault ${want} ≠ CLM ${clm}`);
  const [t0, t1] = await call(s, clm, "wants");
  if (lc(t0) !== lc(BASE.USDC) && lc(t1) !== lc(BASE.USDC)) throw new Error("el CLM no tiene USDC");
  const [strat] = await call(s, clm, "strategy");
  const [pool] = await call(s, strat, "pool");
  const [factory] = await call(s, pool, "factory");
  const [ts] = await call(s, pool, "tickSpacing");
  const router = SLIP_ROUTERS[lc(factory)];
  if (!router) throw new Error(`pool ${pool} de una fábrica sin router conocido (${factory})`);
  Object.assign(r, { vaultId: id, vault, clm, t0, t1, x: lc(t0) === lc(BASE.USDC) ? t1 : t0, usdcIs0: lc(t0) === lc(BASE.USDC), pool, router, tickSpacing: Number(ts) });
  await s.save();
  await s.diag(`estrategia beefy-clm: ${id} · vault ${vault} · CLM ${clm} · pool ${pool} (tickSpacing ${ts}) · router ${router}`);
}

const slipParams = (s, tokenIn, tokenOut, amountIn, min = 0n) => ({ tokenIn, tokenOut, tickSpacing: s.run.tickSpacing, recipient: s.me, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n });
async function slipQuote(s, tokenIn, tokenOut, amountIn) { return (await call(s, s.run.router, "exactInputSingle", [slipParams(s, tokenIn, tokenOut, amountIn)]))[0]; }
/** Swap en el pool del CLM con salida mínima = cotización simulada − deslizamiento; rechaza si el impacto vs una cotización chica > 2 %. */
async function slipSwap(s, tokenIn, tokenOut, amountIn, small, step) {
  await approve(s, tokenIn, s.run.router, amountIn, `approve ${step}`);
  const out = await slipQuote(s, tokenIn, tokenOut, amountIn);
  const ref = small > 0n && small < amountIn ? (await slipQuote(s, tokenIn, tokenOut, small)) * amountIn / small : 0n;
  const p = slipParams(s, tokenIn, tokenOut, amountIn, minOut(out, s.slipBps, ref));
  const before = await bal(s, tokenOut);
  await s.send(step, { to: s.run.router, data: C.encodeFunctionData("exactInputSingle", [p]) });
  return (await bal(s, tokenOut)) - before;
}

export async function enterClm(s, ctx) {
  const r = s.run;
  await resolve(s);
  // 1) ETH → USDC
  if (r.usdcIn === undefined) {
    const balEth = await s.provider.getBalance(s.me);
    const amountIn = spendable(balEth, s.reserve, ethers.parseEther("0.0003"));
    if (amountIn < ethers.parseEther("0.001")) throw new Error(`saldo insuficiente (${ethers.formatEther(balEth)} ETH)`);
    const p = { tokenIn: BASE.WETH, tokenOut: BASE.USDC, fee: BASE.FEE, recipient: s.me, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
    const simOut = U.decodeFunctionResult("exactInputSingle", await s.provider.call({ from: s.me, to: BASE.ROUTER, value: amountIn, data: U.encodeFunctionData("exactInputSingle", [p]) }))[0];
    p.amountOutMinimum = minOut(simOut, s.slipBps, ctx?.ethUsd ? BigInt(Math.floor(Number(ethers.formatEther(amountIn)) * ctx.ethUsd * 1e6)) : 0n);
    await s.diag(`estrategia beefy-clm: ${ethers.formatEther(amountIn)} ETH de ${ethers.formatEther(balEth)} (reserva ${ethers.formatEther(s.reserve)}) → ~${ethers.formatUnits(simOut, 6)} USDC (ETH $${ctx?.ethUsd?.toFixed?.(2) ?? "?"})`);
    const before = await bal(s, BASE.USDC);
    await s.send("swap ETH→USDC", { to: BASE.ROUTER, value: amountIn, data: U.encodeFunctionData("exactInputSingle", [p]) });
    r.ethIn = ethers.formatEther(amountIn); r.usdcIn = String((await bal(s, BASE.USDC)) - before); await s.save();
  }
  // 2) USDC → X en la proporción del CLM
  if (r.xIn === undefined) {
    const usdc = BigInt(r.usdcIn);
    const [b0, b1] = await call(s, r.clm, "balances");
    const [balU, balX] = r.usdcIs0 ? [b0, b1] : [b1, b0];
    const probe = 1_000_000n; // 1 USDC
    const rate = Number(await slipQuote(s, BASE.USDC, r.x, probe)) / Number(probe);
    const f = swapFraction(rate, Number(balX), Number(balU));
    const swapAmt = BigInt(Math.floor(Number(usdc) * f));
    r.xIn = swapAmt > 0n ? String(await slipSwap(s, BASE.USDC, r.x, swapAmt, probe, "swap USDC→X")) : "0";
    r.usdcForClm = String(usdc - swapAmt); await s.save();
  }
  // 3) depósito en el CLM
  if (r.clmShares === undefined) {
    const xAmt = BigInt(r.xIn), uAmt = BigInt(r.usdcForClm);
    const [a0, a1] = r.usdcIs0 ? [uAmt, xAmt] : [xAmt, uAmt];
    if (a0 > 0n) await approve(s, r.t0, r.clm, a0, "approve token0→CLM");
    if (a1 > 0n) await approve(s, r.t1, r.clm, a1, "approve token1→CLM");
    const [shares, used0, used1] = await call(s, r.clm, "previewDeposit", [a0, a1]);
    if (shares === 0n) throw retry("previewDeposit da 0 participaciones");
    const before = await bal(s, r.clm);
    try { await s.sim({ to: r.clm, data: C.encodeFunctionData("deposit(uint256,uint256,uint256)", [a0, a1, shares * 99n / 100n]) }); }
    catch (e) { throw retry(`deposit del CLM no pasa la simulación (${(e.shortMessage || e.message).slice(0, 120)}); ¿no está calm?`); }
    await s.send("deposit CLM", { to: r.clm, data: C.encodeFunctionData("deposit(uint256,uint256,uint256)", [a0, a1, shares * 99n / 100n]) });
    r.clmShares = String((await bal(s, r.clm)) - before); r.used = [String(used0), String(used1)]; await s.save();
  }
  // 4) participaciones del CLM → vault que compone
  if (r.mooShares === undefined) {
    const sh = BigInt(r.clmShares);
    await approve(s, r.clm, r.vault, sh, "approve CLM→vault");
    const before = await bal(s, r.vault);
    await s.send("deposit vault Beefy", { to: r.vault, data: C.encodeFunctionData("deposit(uint256)", [sh]) });
    r.mooShares = String((await bal(s, r.vault)) - before); await s.save();
  }
  await s.diag(`estrategia beefy-clm: activa · ${r.vaultId} · ${r.ethIn} ETH → ${ethers.formatUnits(r.usdcIn, 6)} USDC → CLM ${r.clmShares} → vault ${r.mooShares} · sobrante en wallet: el que el CLM no tomó · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`);
}

export async function exitClm(s, ctx) {
  const r = s.run;
  await resolve(s);
  if (r.clmOut === undefined) {
    const before = await bal(s, r.clm);
    if ((await bal(s, r.vault)) > 0n) await s.send("withdrawAll vault Beefy", { to: r.vault, data: C.encodeFunctionData("withdrawAll") });
    r.clmOut = String((await bal(s, r.clm)) - before); await s.save();
  }
  if (r.usdcOut === undefined) {
    const sh = await bal(s, r.clm);
    const bU0 = await bal(s, BASE.USDC), bX0 = await bal(s, r.x);
    if (sh > 0n) {
      const [m0, m1] = await call(s, r.clm, "previewWithdraw", [sh]);
      try { await s.sim({ to: r.clm, data: C.encodeFunctionData("withdraw", [sh, m0 * 99n / 100n, m1 * 99n / 100n]) }); }
      catch (e) { throw retry(`withdraw del CLM no pasa la simulación (${(e.shortMessage || e.message).slice(0, 120)})`); }
      await s.send("withdraw CLM", { to: r.clm, data: C.encodeFunctionData("withdraw", [sh, m0 * 99n / 100n, m1 * 99n / 100n]) });
    }
    const xGot = (await bal(s, r.x)) - bX0;
    const uFromX = xGot > 0n ? await slipSwap(s, r.x, BASE.USDC, xGot, xGot / 100n, "swap X→USDC") : 0n;
    r.usdcOut = String((await bal(s, BASE.USDC)) - bU0); r.xSold = String(xGot); r.usdcFromX = String(uFromX); await s.save();
  }
  const amt = BigInt(r.usdcOut);
  if (amt <= 0n) throw new Error("no salió USDC del CLM");
  await approve(s, BASE.USDC, BASE.ROUTER, amt, "approve USDC→router");
  const p = { tokenIn: BASE.USDC, tokenOut: BASE.WETH, fee: BASE.FEE, recipient: BASE.ROUTER, amountIn: amt, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  const simOut = U.decodeFunctionResult("exactInputSingle", await s.provider.call({ from: s.me, to: BASE.ROUTER, data: U.encodeFunctionData("exactInputSingle", [p]) }))[0];
  p.amountOutMinimum = minOut(simOut, s.slipBps, ctx?.ethUsd ? BigInt(Math.floor(Number(amt) / 1e6 / ctx.ethUsd * 1e18)) : 0n);
  await s.send("swap USDC→ETH", { to: BASE.ROUTER, data: U.encodeFunctionData("multicall", [[U.encodeFunctionData("exactInputSingle", [p]), U.encodeFunctionData("unwrapWETH9", [p.amountOutMinimum, s.me])]]) });
  await s.diag(`estrategia beefy-clm-exit: cerrada · ${ethers.formatUnits(amt, 6)} USDC → ETH · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`);
}
