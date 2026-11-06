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
  "function fee() view returns (uint24)",
  "function stake(uint256 amount)",
  "function earned(address _user) view returns (address[] rewardTokens, uint256[] earnedAmounts)",
  "function getReward()",
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
// Uniswap v3 en Base: fábrica y QuoterV2 (docs.uniswap.org/contracts/v3/reference/deployments/base-deployments)
export const UNI_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
export const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
// Parámetros por cadena: estable de referencia, nativo envuelto, Uniswap v3 (fábrica, QuoterV2, SwapRouter02) y comisión del par nativo/estable.
// BNB Chain: docs.uniswap.org/contracts/v3/reference/deployments/bnb-deployments. En BSC no se vende nativo (nativeFee null): se usa el USDT de la wallet.
const netsTable = () => ({
  base: { beefy: "base", stable: BASE.USDC, stableSym: "USDC", stableDec: 6, wnative: BASE.WETH, router: BASE.ROUTER, quoter: UNI_QUOTER, uniFactory: UNI_FACTORY, nativeFee: BASE.FEE },
  // Robinhood Chain (4663): Uniswap v3 según @uniswap/sdk-core (ROBINHOOD_ADDRESSES); el "estable" de los CLM WETH-X es WETH,
  // que se obtiene envolviendo ETH (wrapNative). resolve() verifica on-chain que router.factory() == uniFactory.
  robinhood: { beefy: "robinhood", stable: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", stableSym: "WETH", stableDec: 18, wnative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", router: "0xcaf681a66d020601342297493863e78c959e5cb2", quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7", uniFactory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", nativeFee: null, wrapNative: true },
  bsc: { beefy: "bsc", stable: "0x55d398326f99059fF775485246999027B3197955", stableSym: "USDT", stableDec: 18, wnative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077", uniFactory: "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7", nativeFee: null },
});
export const netOf = (key) => { const t = netsTable(); return t[key] ?? t.base; };
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

/** Datos del vault (o reward pool) y del CLM (API de Beefy + verificación on-chain). */
async function resolve(s) {
  const r = s.run;
  if (r.vault) return;
  const id = s.vaultId || process.env.STRATEGY_VAULT_ID || "aero-cow-base-usdc-nvdac-vault";
  const get = async (path) => { try { return await (await fetch(`https://api.beefy.finance${path}`, { signal: AbortSignal.timeout(20_000) })).json(); } catch { return []; } };
  const [list, govs] = await Promise.all([get("/vaults"), get("/gov-vaults")]);
  const v = [...(Array.isArray(list) ? list : []), ...(Array.isArray(govs) ? govs.map((g) => ({ ...g, type: "gov" })) : [])].find((x) => x.id === id);
  if (!v) throw new Error(`vault ${id} no está en la API de Beefy`);
  const N = s.net;
  if (v.chain !== N.beefy || v.status !== "active") throw new Error(`vault ${id}: cadena ${v.chain} (worker ${N.beefy}), estado ${v.status}`);
  const vault = ethers.getAddress(v.earnContractAddress), clm = ethers.getAddress(v.tokenAddress);
  const gov = v.type === "gov";
  if (!gov) { const [want] = await call(s, vault, "want"); if (lc(want) !== lc(clm)) throw new Error(`want del vault ${want} ≠ CLM ${clm}`); }
  const [t0, t1] = await call(s, clm, "wants");
  if (lc(t0) !== lc(N.stable) && lc(t1) !== lc(N.stable)) throw new Error(`el CLM no tiene ${N.stableSym}`);
  const [strat] = await call(s, clm, "strategy");
  const [pool] = await call(s, strat, "pool");
  const [factory] = await call(s, pool, "factory");
  let dex, router, tickSpacing = null, fee = null;
  if (lc(factory) === lc(N.uniFactory)) {
    dex = "uni"; router = N.router; fee = Number((await call(s, pool, "fee"))[0]);
    const [rf] = await call(s, router, "factory"); if (lc(rf) !== lc(N.uniFactory)) throw new Error(`router ${router} es de la fábrica ${rf}, no de ${N.uniFactory}`);
  }
  else if (SLIP_ROUTERS[lc(factory)]) { dex = "slip"; router = SLIP_ROUTERS[lc(factory)]; tickSpacing = Number((await call(s, pool, "tickSpacing"))[0]); }
  else throw new Error(`pool ${pool} de una fábrica sin router conocido (${factory})`);
  Object.assign(r, { vaultId: id, vault, gov, clm, t0, t1, x: lc(t0) === lc(N.stable) ? t1 : t0, usdcIs0: lc(t0) === lc(N.stable), pool, dex, router, tickSpacing, fee });
  await s.save();
  await s.diag(`estrategia ${s.kind}: ${id} · ${gov ? "reward pool" : "vault"} ${vault} · CLM ${clm} · pool ${pool} (${dex === "uni" ? `Uniswap v3 fee ${fee}` : `Slipstream tickSpacing ${tickSpacing}`}) · router ${router}`);
}

const slipParams = (s, tokenIn, tokenOut, amountIn, min = 0n) => ({ tokenIn, tokenOut, tickSpacing: s.run.tickSpacing, recipient: s.me, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n });
const uniParams = (s, tokenIn, tokenOut, amountIn, min = 0n) => ({ tokenIn, tokenOut, fee: s.run.fee, recipient: s.me, amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n });
/** Cotización en el pool del CLM: QuoterV2 en Uniswap v3 (no necesita allowance); en Slipstream, llamada estática al router (requiere allowance previo). */
async function slipQuote(s, tokenIn, tokenOut, amountIn) {
  if (s.run.dex === "uni") return (await call(s, s.net.quoter, "quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee: s.run.fee, sqrtPriceLimitX96: 0n }]))[0];
  return (await call(s, s.run.router, "exactInputSingle", [slipParams(s, tokenIn, tokenOut, amountIn)]))[0];
}
/** Swap en el pool del CLM con salida mínima = cotización simulada − deslizamiento; rechaza si el impacto vs una cotización chica > 2 %. */
async function slipSwap(s, tokenIn, tokenOut, amountIn, small, step) {
  await approve(s, tokenIn, s.run.router, amountIn, `approve ${step}`);
  const out = await slipQuote(s, tokenIn, tokenOut, amountIn);
  const ref = small > 0n && small < amountIn ? (await slipQuote(s, tokenIn, tokenOut, small)) * amountIn / small : 0n;
  const min = minOut(out, s.slipBps, ref);
  const data = s.run.dex === "uni" ? U.encodeFunctionData("exactInputSingle", [uniParams(s, tokenIn, tokenOut, amountIn, min)]) : C.encodeFunctionData("exactInputSingle", [slipParams(s, tokenIn, tokenOut, amountIn, min)]);
  const before = await bal(s, tokenOut);
  await s.send(step, { to: s.run.router, data });
  return (await bal(s, tokenOut)) - before;
}

/** ETH a cambiar para obtener `needUsdc` (crudo, 6 dec.) al precio ethUsd, con 1 % de margen. */
export function ethForUsdc(needUsdc, ethUsd, dec = 6) {
  if (!(ethUsd > 0) || needUsdc <= 0n) return 0n;
  return ethers.parseEther((Number(needUsdc) / 10 ** dec / ethUsd * 1.01).toFixed(18));
}
const noFunds = (m) => Object.assign(new Error(m), { noFunds: true });

/** Proporción que el CLM acepta ahora: X crudo por estable crudo (previewDeposit con X de sobra). Infinity si solo toma X. */
async function clmRatio(s) {
  const r = s.run, U1 = 10n ** BigInt(s.net.stableDec);
  const u = 1000n * U1, x = 10n ** 36n;
  const [a0, a1] = r.usdcIs0 ? [u, x] : [x, u];
  try {
    const [, used0, used1] = await call(s, r.clm, "previewDeposit", [a0, a1]);
    const [uU, uX] = r.usdcIs0 ? [used0, used1] : [used1, used0];
    if (uU === 0n) return Infinity;
    return Number(uX) / Number(uU);
  } catch {
    const [b0, b1] = await call(s, r.clm, "balances");
    const [bU, bX] = r.usdcIs0 ? [b0, b1] : [b1, b0];
    return bU === 0n ? Infinity : Number(bX) / Number(bU);
  }
}

/**
 * Rebalanceo para depositar en proporción R (X por estable, crudo) teniendo S estable y X tokens, con precio `rate` (X por estable).
 * Devuelve cuánto estable cambiar a X o cuánto X cambiar a estable (crudo, sin comisión).
 */
export function rebalance(S, X, rate, R) {
  if (!(rate > 0)) return { stableToX: 0, xToStable: 0 };
  const V = S + X / rate; // valor total en estable
  if (R === Infinity) return { stableToX: S, xToStable: 0 };
  const sT = V / (1 + R / rate), xT = R * sT; // objetivo
  if (X > xT) return { stableToX: 0, xToStable: X - xT };
  return { stableToX: Math.max(0, S - sT), xToStable: 0 };
}

export async function enterClm(s, ctx) {
  const r = s.run, N = s.net;
  await resolve(s);
  const D = N.stableDec, U1 = 10n ** BigInt(D);
  // 1) nativo → estable (todo lo disponible; o, en DCA, solo lo necesario para s.dcaUsd usando primero el estable de la wallet)
  if (r.usdcIn === undefined && s.sweepStable !== undefined) {
    // barrido: solo el estable que sobró antes (sin pasar del saldo) + el X que haya en la wallet (paso 2)
    const have0 = await bal(s, N.stable), prot = s.protectStable ?? 0n, have = have0 > prot ? have0 - prot : 0n;
    const want = ethers.parseUnits(s.sweepStable.toFixed(Math.min(6, D)), D);
    r.ethIn = "0"; r.usdcIn = String(want < have ? want : have); await s.save();
  }
  if (r.usdcIn === undefined && N.wrapNative && s.dcaUsd) {
    // el "estable" es el nativo envuelto (WETH): objetivo = dcaUsd / precio; se envuelve solo lo que falte (sin tocar lo retenido)
    if (!(ctx?.ethUsd > 0)) throw retry("sin precio del nativo");
    const target = ethers.parseEther((s.dcaUsd / ctx.ethUsd).toFixed(18));
    const w0 = await bal(s, N.stable), prot = s.protectStable ?? 0n, have = w0 > prot ? w0 - prot : 0n;
    const need = have >= target ? 0n : target - have;
    if (need > 0n) {
      const balEth = await s.provider.getBalance(s.me);
      if (need > spendable(balEth, s.reserve, ethers.parseEther("0.00005"))) throw noFunds(`fondos insuficientes para $${s.dcaUsd}: ${ethers.formatEther(have)} ${N.stableSym} libre y ${ethers.formatEther(balEth)} nativo (reserva ${ethers.formatEther(s.reserve)})`);
      await s.send(`wrap nativo→${N.stableSym}`, { to: N.stable, value: need, data: C.encodeFunctionData("deposit()") });
    }
    r.ethIn = ethers.formatEther(need); r.usdcIn = String(target); await s.save();
  }
  if (r.usdcIn === undefined) {
    const balEth = await s.provider.getBalance(s.me);
    const target = s.dcaUsd ? ethers.parseUnits(String(s.dcaUsd), D) : null;
    const usdcHave = target !== null ? await (async () => { const b = await bal(s, N.stable), p = s.protectStable ?? 0n; return b > p ? b - p : 0n; })() : 0n;
    let amountIn;
    if (target === null) {
      amountIn = spendable(balEth, s.reserve, ethers.parseEther("0.0003"));
      if (amountIn < ethers.parseEther("0.001")) throw new Error(`saldo insuficiente (${ethers.formatEther(balEth)} nativo)`);
    } else {
      amountIn = usdcHave >= target ? 0n : ethForUsdc(target - usdcHave, ctx?.ethUsd, D);
      if (amountIn > 0n && (N.nativeFee === null || amountIn > spendable(balEth, s.reserve, ethers.parseEther("0.0003")))) throw noFunds(`fondos insuficientes para $${s.dcaUsd}: ${ethers.formatUnits(usdcHave, D)} ${N.stableSym}${N.nativeFee === null ? " (en esta cadena no se vende el nativo)" : ` y ${ethers.formatEther(balEth)} nativo (reserva ${ethers.formatEther(s.reserve)})`}`);
      if (amountIn === 0n && usdcHave < target) throw Object.assign(new Error("sin precio del nativo"), { retry: true });
    }
    if (amountIn > 0n) {
      const p = { tokenIn: N.wnative, tokenOut: N.stable, fee: N.nativeFee, recipient: s.me, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
      const simOut = U.decodeFunctionResult("exactInputSingle", await s.provider.call({ from: s.me, to: N.router, value: amountIn, data: U.encodeFunctionData("exactInputSingle", [p]) }))[0];
      p.amountOutMinimum = minOut(simOut, s.slipBps, ctx?.ethUsd ? ethers.parseUnits((Number(ethers.formatEther(amountIn)) * ctx.ethUsd).toFixed(D > 6 ? 6 : D), D) : 0n);
      await s.diag(`estrategia ${s.kind}: ${ethers.formatEther(amountIn)} nativo de ${ethers.formatEther(balEth)} (reserva ${ethers.formatEther(s.reserve)}) → ~${ethers.formatUnits(simOut, D)} ${N.stableSym} (nativo $${ctx?.ethUsd?.toFixed?.(2) ?? "?"})`);
      const before = await bal(s, N.stable);
      await s.send(`swap nativo→${N.stableSym}`, { to: N.router, value: amountIn, data: U.encodeFunctionData("exactInputSingle", [p]) });
      r.ethIn = ethers.formatEther(amountIn);
      const got = (await bal(s, N.stable)) - before;
      r.usdcIn = String(target === null ? got : (usdcHave + got < target ? usdcHave + got : target));
    } else { r.ethIn = "0"; r.usdcIn = String(target); }
    await s.save();
  }
  // 2) rebalanceo estable/X según la proporción que el CLM acepta HOY (previewDeposit con X de sobra), incluyendo el X que ya
  //    haya en la wallet (sobrantes de depósitos anteriores). balances() del CLM incluye la posición alternativa y no sirve.
  if (r.xIn === undefined) {
    const usdc = BigInt(r.usdcIn);
    const xWallet = await bal(s, r.x);
    const probe = U1; // 1 unidad del estable
    if (r.dex !== "uni") await approve(s, N.stable, r.router, usdc > 0n ? usdc : U1, "approve estable→router (cotización)");
    const rate = Number(await slipQuote(s, N.stable, r.x, probe)) / Number(probe); // X crudo por estable crudo
    const R = await clmRatio(s); // X crudo que pide el CLM por cada estable crudo (Infinity = solo X)
    if (usdc === 0n && xWallet === 0n) throw new Error("nada que depositar");
    const plan = rebalance(Number(usdc), Number(xWallet), rate, R);
    let xHave = xWallet, uHave = usdc;
    if (plan.stableToX > 0) { const amt = BigInt(Math.floor(plan.stableToX)); xHave += await slipSwap(s, N.stable, r.x, amt, probe, `swap ${N.stableSym}→X`); uHave -= amt; }
    else if (plan.xToStable > 0) { const amt = BigInt(Math.floor(plan.xToStable)); uHave += await slipSwap(s, r.x, N.stable, amt, amt / 100n || 1n, `swap X→${N.stableSym}`); xHave -= amt; }
    r.xIn = String(xHave); r.usdcForClm = String(uHave); r.ratio = { R, rate, xWallet: String(xWallet) }; await s.save();
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
    r.clmShares = String((await bal(s, r.clm)) - before); r.used = [String(used0), String(used1)];
    const [uU, uX] = r.usdcIs0 ? [used0, used1] : [used1, used0];
    const rate = r.ratio?.rate || 0;
    const leftU = Number(uAmt - uU) / Number(U1), leftXinStable = rate > 0 ? Number(xAmt - uX) / rate / Number(U1) : 0;
    r.leftover = { stable: leftU, xAsStable: leftXinStable };
    await s.diag(`estrategia ${s.kind}: CLM tomó ${(Number(uU) / Number(U1)).toFixed(4)} ${N.stableSym} + ${rate > 0 ? (Number(uX) / rate / Number(U1)).toFixed(4) : "?"} en X de ${(Number(uAmt) / Number(U1)).toFixed(4)} + ${rate > 0 ? (Number(xAmt) / rate / Number(U1)).toFixed(4) : "?"} ofrecidos · sobrante en wallet ≈ $${(leftU + leftXinStable).toFixed(4)} (se usa en el siguiente depósito)`);
    await s.save();
  }
  // 4) participaciones del CLM → vault que compone
  if (r.mooShares === undefined) {
    const sh = BigInt(r.clmShares);
    await approve(s, r.clm, r.vault, sh, "approve CLM→vault");
    const before = await bal(s, r.vault);
    await s.send(r.gov ? "stake reward pool Beefy" : "deposit vault Beefy", { to: r.vault, data: r.gov ? C.encodeFunctionData("stake", [sh]) : C.encodeFunctionData("deposit(uint256)", [sh]) });
    r.mooShares = String((await bal(s, r.vault)) - before); await s.save();
  }
  await s.diag(`estrategia ${s.kind}: depósito hecho · ${r.vaultId} · ${r.ethIn} nativo → ${ethers.formatUnits(r.usdcIn, D)} ${N.stableSym} → CLM ${r.clmShares} → vault ${r.mooShares} · sobrante en wallet: el que el CLM no tomó · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`);
}

export async function exitClm(s, ctx) {
  const r = s.run;
  await resolve(s);
  if (r.clmOut === undefined) {
    const before = await bal(s, r.clm);
    const held = await bal(s, r.vault);
    if (r.gov && held > 0n) await claimRewards(s, "getReward antes de salir").catch(() => {});
    if (held > 0n) await s.send(r.gov ? "withdraw reward pool Beefy" : "withdrawAll vault Beefy", { to: r.vault, data: r.gov ? C.encodeFunctionData("withdraw(uint256)", [held]) : C.encodeFunctionData("withdrawAll") });
    r.clmOut = String((await bal(s, r.clm)) - before); await s.save();
  }
  if (r.usdcOut === undefined) {
    const sh = await bal(s, r.clm);
    const bU0 = await bal(s, s.net.stable), bX0 = await bal(s, r.x);
    if (sh > 0n) {
      const [m0, m1] = await call(s, r.clm, "previewWithdraw", [sh]);
      try { await s.sim({ to: r.clm, data: C.encodeFunctionData("withdraw(uint256,uint256,uint256)", [sh, m0 * 99n / 100n, m1 * 99n / 100n]) }); }
      catch (e) { throw retry(`withdraw del CLM no pasa la simulación (${(e.shortMessage || e.message).slice(0, 120)})`); }
      await s.send("withdraw CLM", { to: r.clm, data: C.encodeFunctionData("withdraw(uint256,uint256,uint256)", [sh, m0 * 99n / 100n, m1 * 99n / 100n]) });
    }
    const xGot = (await bal(s, r.x)) - bX0;
    const uFromX = xGot > 0n ? await slipSwap(s, r.x, s.net.stable, xGot, xGot / 100n, `swap X→${s.net.stableSym}`) : 0n;
    r.usdcOut = String((await bal(s, s.net.stable)) - bU0); r.xSold = String(xGot); r.usdcFromX = String(uFromX); await s.save();
  }
  const amt = BigInt(r.usdcOut);
  if (amt <= 0n) throw new Error("no salió USDC del CLM");
  if (s.net.nativeFee === null) { await s.diag(`estrategia beefy-clm-exit: cerrada · ${ethers.formatUnits(amt, s.net.stableDec)} ${s.net.stableSym} quedan en la wallet · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`); return; }
  await approve(s, BASE.USDC, BASE.ROUTER, amt, "approve USDC→router");
  const p = { tokenIn: BASE.USDC, tokenOut: BASE.WETH, fee: BASE.FEE, recipient: BASE.ROUTER, amountIn: amt, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
  const simOut = U.decodeFunctionResult("exactInputSingle", await s.provider.call({ from: s.me, to: BASE.ROUTER, data: U.encodeFunctionData("exactInputSingle", [p]) }))[0];
  p.amountOutMinimum = minOut(simOut, s.slipBps, ctx?.ethUsd ? BigInt(Math.floor(Number(amt) / 1e6 / ctx.ethUsd * 1e18)) : 0n);
  await s.send("swap USDC→ETH", { to: BASE.ROUTER, data: U.encodeFunctionData("multicall", [[U.encodeFunctionData("exactInputSingle", [p]), U.encodeFunctionData("unwrapWETH9", [p.amountOutMinimum, s.me])]]) });
  await s.diag(`estrategia beefy-clm-exit: cerrada · ${ethers.formatUnits(amt, 6)} USDC → ETH · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`);
}

/** Recompensas pendientes del reward pool (gov): [{token, amount}] (crudo). */
export async function pendingRewards(s) {
  const r = s.run;
  const [tokens, amounts] = await call(s, r.vault, "earned(address)", [s.me]);
  return tokens.map((t, i) => ({ token: t, amount: amounts[i] })).filter((x) => x.amount > 0n);
}
/** Cobra las recompensas del reward pool. Devuelve los saldos recibidos por token (crudo). */
export async function claimRewards(s, step = "getReward") {
  const pend = await pendingRewards(s);
  if (!pend.length) return [];
  const before = await Promise.all(pend.map((p) => bal(s, p.token)));
  await s.send(step, { to: s.run.vault, data: C.encodeFunctionData("getReward") });
  return Promise.all(pend.map(async (p, i) => ({ token: p.token, amount: (await bal(s, p.token)) - before[i] })));
}
/**
 * Retención de ganancias (demo dinámico): cobra las recompensas del reward pool y convierte las que vengan en el token X del
 * CLM al estable; devuelve el estable obtenido (crudo) y lo que quedó en otros tokens. Lo obtenido NO se vuelve a depositar
 * (Strategy lo suma a lo retenido y lo protege de los depósitos).
 */
export async function harvestProfit(s) {
  const r = s.run, N = s.net;
  await resolve(s);
  if (!r.gov) return { stable: 0n, other: [] };
  const got = await claimRewards(s, "cobrar recompensas (retener)");
  let stable = 0n; const other = [];
  for (const g of got) {
    if (g.amount <= 0n) continue;
    if (lc(g.token) === lc(N.stable)) stable += g.amount;
    else if (lc(g.token) === lc(r.x)) stable += await slipSwap(s, r.x, N.stable, g.amount, g.amount / 100n || 1n, `swap recompensa X→${N.stableSym}`);
    else other.push({ token: g.token, amount: String(g.amount) });
  }
  return { stable, other };
}
