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
  "function totalSupply() view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)",
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
  if (v.chain !== N.beefy || (v.status !== "active" && !s.allowInactive)) throw new Error(`vault ${id}: cadena ${v.chain} (worker ${N.beefy}), estado ${v.status}`);
  const vault = ethers.getAddress(v.earnContractAddress), clm = ethers.getAddress(v.tokenAddress);
  const gov = v.type === "gov";
  if (!gov) { const [want] = await call(s, vault, "want"); if (lc(want) !== lc(clm)) throw new Error(`want del vault ${want} ≠ CLM ${clm}`); }
  const [t0, t1] = await call(s, clm, "wants");
  // par sin el estable (HIGH_APY_ANY_PAIR=1): se entra/sale cambiando el estable por los dos tokens vía Uniswap v3 (rutas cotizadas)
  const noStable = lc(t0) !== lc(N.stable) && lc(t1) !== lc(N.stable);
  if (noStable && ((process.env.HIGH_APY_ANY_PAIR !== "1" && !r.extra) || !N.router || !N.quoter)) throw new Error(`el CLM no tiene ${N.stableSym}`);
  const [strat] = await call(s, clm, "strategy");
  const [pool] = await call(s, strat, "pool");
  const [factory] = await call(s, pool, "factory");
  let dex, router, tickSpacing = null, fee = null;
  if (lc(factory) === lc(N.uniFactory)) {
    dex = "uni"; router = N.router; fee = Number((await call(s, pool, "fee"))[0]);
    const [rf] = await call(s, router, "factory"); if (lc(rf) !== lc(N.uniFactory)) throw new Error(`router ${router} es de la fábrica ${rf}, no de ${N.uniFactory}`);
  }
  else if (SLIP_ROUTERS[lc(factory)] || (await discoverRouter(s, pool, factory))) { dex = "slip"; router = SLIP_ROUTERS[lc(factory)] ?? (await discoverRouter(s, pool, factory)); tickSpacing = Number((await call(s, pool, "tickSpacing"))[0]); }
  else if (N.router && N.quoter) { dex = "otro"; router = N.router; } // fábrica sin router conocido: swaps por rutas Uniswap v3 cotizadas
  else throw new Error(`pool ${pool} de una fábrica sin router conocido (${factory})`);
  Object.assign(r, { vaultId: id, vault, gov, clm, t0, t1, x: lc(t0) === lc(N.stable) ? t1 : t0, usdcIs0: lc(t0) === lc(N.stable), pool, dex, router, tickSpacing, fee, noStable });
  await s.save();
  if (!s.quietResolve) await s.diag(`estrategia ${s.kind}: ${id} · ${gov ? "reward pool" : "vault"} ${vault} · CLM ${clm} · pool ${pool} (${dex === "uni" ? `Uniswap v3 fee ${fee}` : dex === "slip" ? `Slipstream tickSpacing ${tickSpacing}` : "fábrica no soportada para swaps en el pool; rutas Uniswap v3"}${noStable ? `; par sin ${N.stableSym}` : ""}) · router ${router}`);
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
  const u = 1000n * U1;
  // X "de sobra": algunos tokens desbordan con 1e36 → se prueba con cantidades menores antes de caer a balances()
  let first = null;
  for (const x of [10n ** 36n, 10n ** 30n, 10n ** 27n, 10n ** 24n]) {
    const [a0, a1] = r.usdcIs0 ? [u, x] : [x, u];
    try {
      const [, used0, used1] = await call(s, r.clm, "previewDeposit", [a0, a1]);
      const [uU, uX] = r.usdcIs0 ? [used0, used1] : [used1, used0];
      if (uU === 0n) return Infinity;
      if (uX === x) { first ??= Number(uX) / Number(uU); continue; } // usó todo el X: no era "de sobra"
      return Number(uX) / Number(uU);
    } catch {}
  }
  if (first !== null) return first;
  {
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

/**
 * Router de una fábrica Slipstream que no está en SLIP_ROUTERS: se toman los `sender` de los últimos Swap del pool (quien llama
 * a pool.swap es el router o un agregador) y se acepta el primero cuyo factory() sea la fábrica del pool y que cotice
 * exactInputSingle con tickSpacing (forma Slipstream). Se guarda en el store por fábrica.
 */
const SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const routerCache = {};
export async function discoverRouter(s, pool, factory) {
  const f = lc(factory);
  if (routerCache[f] !== undefined) return routerCache[f];
  const stored = (await s.store?.get?.("slipRouters").catch(() => null)) ?? {};
  if (stored[f]) return (routerCache[f] = stored[f]);
  let found = null;
  try {
    const head = await s.provider.getBlockNumber();
    const senders = new Map();
    for (let to = head, i = 0; i < 6 && senders.size < 12; i++, to -= 2000) {
      const logs = await s.provider.getLogs({ address: pool, topics: [SWAP_TOPIC], fromBlock: Math.max(0, to - 1999), toBlock: to }).catch(() => []);
      for (const l of logs) { const a = ethers.getAddress("0x" + l.topics[1].slice(26)); senders.set(a, (senders.get(a) ?? 0) + 1); }
    }
    for (const [a] of [...senders.entries()].sort((x, y) => y[1] - x[1])) {
      try {
        const [rf] = await call(s, a, "factory");
        if (lc(rf) !== f) continue;
        // debe tener exactInputSingle con tickSpacing y deadline (SwapRouter de Slipstream), que es lo que usa slipSwap
        const sel = C.getFunction("exactInputSingle").selector.slice(2);
        if (!(await s.provider.getCode(a)).includes(sel)) continue;
        found = a; break;
      } catch {}
    }
  } catch {}
  routerCache[f] = found;
  if (found) { stored[f] = found; await s.store?.set?.("slipRouters", stored).catch(() => {}); await s.diag?.(`estrategia: router Slipstream descubierto para la fábrica ${factory}: ${found} (sender de Swaps del pool ${pool})`); }
  return found;
}

/** Verifica sin enviar nada que un vault se pueda usar (API de Beefy, CLM, pool, fábrica/rutas). Devuelve el texto de diagnóstico. */
export async function checkVault(s, id, { extra = false } = {}) {
  const saved = { run: s.run, vaultId: s.vaultId, save: s.save, diag: s.diag };
  let msg = "";
  s.run = { txs: [], extra }; s.vaultId = id; s.save = async () => {}; s.diag = async (m) => { msg = m; };
  try { await resolve(s); const r = s.run; return `${id}: OK · ${r.dex === "uni" ? `Uniswap v3 fee ${r.fee}` : r.dex === "slip" ? `Slipstream ts ${r.tickSpacing}` : "rutas Uniswap v3 (fábrica sin router conocido)"}${r.noStable ? ` · par sin ${s.net.stableSym}` : ""}`; }
  catch (e) { return `${id}: NO se puede usar · ${(e.shortMessage || e.message).slice(0, 160)}`; }
  finally { Object.assign(s, saved); void msg; }
}

// ---------------------------------------------------------------------------------------------------------------
// Pares sin el estable: rutas estable↔token por Uniswap v3 (directa o vía el nativo envuelto), cotizadas con QuoterV2.
const Q = new ethers.Interface([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
]);
const FEES = [100, 500, 2500, 3000, 10000];
/** Ruta v3 codificada (token, fee, token, …) (puro, probado). */
export function encodePath(tokens, fees) { return ethers.solidityPacked(tokens.flatMap((t, i) => (i < fees.length ? ["address", "uint24"] : ["address"])), tokens.flatMap((t, i) => (i < fees.length ? [t, fees[i]] : [t]))); }
/** Mejor ruta para `amountIn` de tokenIn→tokenOut: directa en cada comisión o vía el nativo envuelto. */
export async function bestPath(s, tokenIn, tokenOut, amountIn) {
  const W = s.net.wnative, cands = [];
  for (const f of FEES) cands.push({ tokens: [tokenIn, tokenOut], fees: [f] });
  if (W && lc(W) !== lc(tokenIn) && lc(W) !== lc(tokenOut)) for (const f1 of [500, 3000, 100, 10000]) for (const f2 of [500, 3000, 100, 10000]) cands.push({ tokens: [tokenIn, W, tokenOut], fees: [f1, f2] });
  let best = null;
  for (const c of cands) {
    const path = encodePath(c.tokens, c.fees);
    try { const [out] = Q.decodeFunctionResult("quoteExactInput", await s.provider.call({ to: s.net.quoter, data: Q.encodeFunctionData("quoteExactInput", [path, amountIn]) })); if (!best || out > best.out) best = { path, out, desc: c.fees.join("/") + (c.tokens.length > 2 ? " vía nativo" : "") }; } catch {}
  }
  if (!best || best.out === 0n) throw new Error(`sin ruta Uniswap v3 de ${tokenIn} a ${tokenOut}`);
  return best;
}
/** Swap por la mejor ruta, con salida mínima = cotización − deslizamiento y control de impacto (cotización chica × escala, 2 %). */
export async function routeSwap(s, tokenIn, tokenOut, amountIn, step) {
  if (amountIn <= 0n) return 0n;
  const b = await bestPath(s, tokenIn, tokenOut, amountIn);
  const small = amountIn / 50n;
  let ref = 0n;
  if (small > 0n) { try { const [o] = Q.decodeFunctionResult("quoteExactInput", await s.provider.call({ to: s.net.quoter, data: Q.encodeFunctionData("quoteExactInput", [b.path, small]) })); ref = o * amountIn / small; } catch {} }
  const min = minOut(b.out, s.slipBps, ref);
  await approve(s, tokenIn, s.net.router, amountIn, `approve ${step}`);
  const before = await bal(s, tokenOut);
  await s.send(`${step} (${b.desc})`, { to: s.net.router, data: Q.encodeFunctionData("exactInput", [{ path: b.path, recipient: s.me, amountIn, amountOutMinimum: min }]) });
  return (await bal(s, tokenOut)) - before;
}
/** Reparto del estable S entre t0 y t1 para depositar en proporción R = t1/t0 (crudo); rate_i = token_i crudo por estable crudo (puro, probado). */
export function pairSplit(S, rate0, rate1, R) {
  if (!(rate0 > 0) || !(rate1 > 0)) return { u0: 0, u1: 0 };
  if (R === 0) return { u0: S, u1: 0 };
  if (R === Infinity) return { u0: 0, u1: S };
  const a0 = S / (1 / rate0 + R / rate1);
  const u0 = a0 / rate0;
  return { u0, u1: S - u0 };
}
/** Proporción t1/t0 (crudo) que el CLM acepta con montos reales: se ofrece el valor de S en cada token (el doble de lo necesario). */
async function pairRatio(s, S, rate0, rate1) {
  const r = s.run;
  const o0 = BigInt(Math.floor(Number(S) * rate0)), o1 = BigInt(Math.floor(Number(S) * rate1));
  try {
    const [, u0, u1] = await call(s, r.clm, "previewDeposit", [o0, o1]);
    if (u0 > 0n || u1 > 0n) return u0 === 0n ? Infinity : Number(u1) / Number(u0);
  } catch {}
  const [b0, b1] = await call(s, r.clm, "balances");
  return b0 === 0n ? Infinity : Number(b1) / Number(b0);
}
async function enterPair(s, ctx) {
  const r = s.run, N = s.net, U1 = 10n ** BigInt(N.stableDec);
  if (r.a0 === undefined) {
    const S = BigInt(r.usdcIn);
    if (S === 0n) throw new Error("nada que depositar");
    const probe = U1;
    const rate0 = Number((await bestPath(s, N.stable, r.t0, probe)).out) / Number(probe), rate1 = Number((await bestPath(s, N.stable, r.t1, probe)).out) / Number(probe);
    const R = await pairRatio(s, S, rate0, rate1);
    // sobrantes de depósitos anteriores en este mismo vault (tokens que el CLM no tomó): entran ahora, valuados en estable
    const carry = { t0: 0n, t1: 0n };
    for (const [k, o] of Object.entries(s.s?.runs ?? {})) if (o !== r && o.vaultId === r.vaultId && o.leftover && !o.leftoverUsed && o.leftover.t0 !== undefined) { carry.t0 += BigInt(o.leftover.t0); carry.t1 += BigInt(o.leftover.t1); o.leftoverUsed = true; }
    const w0 = await bal(s, r.t0), w1 = await bal(s, r.t1);
    if (carry.t0 > w0) carry.t0 = w0; if (carry.t1 > w1) carry.t1 = w1;
    r.carry = { t0: String(carry.t0), t1: String(carry.t1) };
    const S2 = Number(S) + Number(carry.t0) / rate0 + Number(carry.t1) / rate1; // valor total en estable crudo
    const want = pairSplit(S2, rate0, rate1, R); // estable a destinar a cada token, contando lo que ya hay
    let need0 = Math.max(0, want.u0 - Number(carry.t0) / rate0), need1 = Math.max(0, want.u1 - Number(carry.t1) / rate1);
    const tot = need0 + need1; if (tot > 0) { need0 = need0 / tot * Number(S); need1 = Number(S) - need0; }
    const sp = { u0: need0, u1: need1 };
    const u0 = BigInt(Math.floor(sp.u0)), u1 = S - u0 > 0n ? S - u0 : 0n;
    const b0 = await bal(s, r.t0), b1 = await bal(s, r.t1);
    if (u0 > 0n) await routeSwap(s, N.stable, r.t0, u0, `swap ${N.stableSym}→token0`);
    if (u1 > 0n) await routeSwap(s, N.stable, r.t1, u1, `swap ${N.stableSym}→token1`);
    r.a0 = String((await bal(s, r.t0)) - b0 + carry.t0); r.a1 = String((await bal(s, r.t1)) - b1 + carry.t1); r.ratio = { R, rate0, rate1 }; await s.save();
    await s.diag(`estrategia ${s.kind}: par sin ${N.stableSym} · proporción R=${R === Infinity ? "solo token1" : R.toExponential(3)} · ${ethers.formatUnits(S, N.stableDec)} ${N.stableSym} → token0 ${r.a0} + token1 ${r.a1}`);
  }
  if (r.clmShares === undefined) {
    const a0 = BigInt(r.a0), a1 = BigInt(r.a1);
    if (a0 > 0n) await approve(s, r.t0, r.clm, a0, "approve token0→CLM");
    if (a1 > 0n) await approve(s, r.t1, r.clm, a1, "approve token1→CLM");
    const [shares, used0, used1] = await call(s, r.clm, "previewDeposit", [a0, a1]);
    if (shares === 0n) throw retry("previewDeposit da 0 participaciones");
    const before = await bal(s, r.clm);
    try { await s.sim({ to: r.clm, data: C.encodeFunctionData("deposit(uint256,uint256,uint256)", [a0, a1, shares * 99n / 100n]) }); }
    catch (e) { throw retry(`deposit del CLM no pasa la simulación (${(e.shortMessage || e.message).slice(0, 120)}); ¿no está calm?`); }
    await s.send("deposit CLM", { to: r.clm, data: C.encodeFunctionData("deposit(uint256,uint256,uint256)", [a0, a1, shares * 99n / 100n]) });
    r.clmShares = String((await bal(s, r.clm)) - before); r.used = [String(used0), String(used1)];
    r.leftover = { t0: String(a0 - used0), t1: String(a1 - used1) };
    await s.diag(`estrategia ${s.kind}: CLM tomó token0 ${used0} de ${a0} + token1 ${used1} de ${a1}`);
    await s.save();
    // lo que el CLM rechazó no se queda suelto: se vende al estable (que entra en el siguiente depósito)
    const stableUsd = N.wrapNative ? (ctx?.ethUsd || 0) : 1;
    const dust = stableUsd > 0 ? ethers.parseUnits((0.2 / stableUsd).toFixed(Math.min(N.stableDec, 12)), N.stableDec) : 10n ** 30n;
    for (const [k, t] of [["t0", r.t0], ["t1", r.t1]]) {
      const left = BigInt(r.leftover[k]);
      if (left <= 0n || lc(t) === lc(N.stable)) continue;
      const q = (await bestPath(s, t, N.stable, left).catch(() => null))?.out ?? 0n;
      if (q <= dust) continue;
      const got = await routeSwap(s, t, N.stable, left, `swap sobrante ${k}→${N.stableSym}`);
      r.leftover[k] = "0"; (r.leftoverSold ??= []).push({ token: t, amount: String(left), got: String(got) });
      await s.diag(`estrategia ${s.kind}: sobrante ${k} vendido · ${left} → ${ethers.formatUnits(got, N.stableDec)} ${N.stableSym} (entra en el siguiente depósito)`);
    }
    await s.save();
  }
  if (r.mooShares === undefined) {
    const sh = BigInt(r.clmShares);
    await approve(s, r.clm, r.vault, sh, "approve CLM→vault");
    const before = await bal(s, r.vault);
    await s.send(r.gov ? "stake reward pool Beefy" : "deposit vault Beefy", { to: r.vault, data: r.gov ? C.encodeFunctionData("stake", [sh]) : C.encodeFunctionData("deposit(uint256)", [sh]) });
    r.mooShares = String((await bal(s, r.vault)) - before); await s.save();
  }
  await s.diag(`estrategia ${s.kind}: depósito hecho · ${r.vaultId} · ${r.ethIn} nativo → ${ethers.formatUnits(r.usdcIn, N.stableDec)} ${N.stableSym} → CLM ${r.clmShares} → vault ${r.mooShares} · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`);
}

export async function enterClm(s, ctx) {
  const r = s.run, N = s.net;
  if (r.dex === "otro" && !r.noStable && r.xIn === undefined) delete r.vault; // reintento: vuelve a buscar router del pool (descubrimiento)
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
  if (r.noStable) return enterPair(s, ctx);
  // 2) rebalanceo estable/X según la proporción que el CLM acepta HOY (previewDeposit con X de sobra), incluyendo el X que ya
  //    haya en la wallet (sobrantes de depósitos anteriores). balances() del CLM incluye la posición alternativa y no sirve.
  if (r.xIn === undefined) {
    const usdc = BigInt(r.usdcIn);
    const xWallet = await bal(s, r.x);
    const probe = U1; // 1 unidad del estable
    if (r.dex === "slip") await approve(s, N.stable, r.router, usdc > 0n ? usdc : U1, "approve estable→router (cotización)");
    const rate = Number(r.dex === "otro" ? (await bestPath(s, N.stable, r.x, probe)).out : await slipQuote(s, N.stable, r.x, probe)) / Number(probe); // X crudo por estable crudo
    const R = await clmRatio(s); // X crudo que pide el CLM por cada estable crudo (Infinity = solo X)
    if (usdc === 0n && xWallet === 0n) throw new Error("nada que depositar");
    const plan = rebalance(Number(usdc), Number(xWallet), rate, R);
    let xHave = xWallet, uHave = usdc;
    if (plan.stableToX > 0) { const amt = BigInt(Math.floor(plan.stableToX)); xHave += r.dex === "otro" ? await routeSwap(s, N.stable, r.x, amt, `swap ${N.stableSym}→X`) : await slipSwap(s, N.stable, r.x, amt, probe, `swap ${N.stableSym}→X`); uHave -= amt; }
    else if (plan.xToStable > 0) { const amt = BigInt(Math.floor(plan.xToStable)); uHave += r.dex === "otro" ? await routeSwap(s, r.x, N.stable, amt, `swap X→${N.stableSym}`) : await slipSwap(s, r.x, N.stable, amt, amt / 100n || 1n, `swap X→${N.stableSym}`); xHave -= amt; }
    r.xIn = String(xHave); r.usdcForClm = String(uHave); r.ratio = { R, rate, xWallet: String(xWallet) }; await s.save();
    await s.diag(`estrategia ${s.kind}: proporción del CLM R=${R === Infinity ? "solo X" : R.toExponential(3)} X/${N.stableSym} (precio ${rate.toExponential(3)}) · X en wallet ${xWallet} · plan ${plan.stableToX > 0 ? `${N.stableSym}→X ${Math.floor(plan.stableToX)}` : plan.xToStable > 0 ? `X→${N.stableSym} ${Math.floor(plan.xToStable)}` : "sin swap"}`);
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
    await s.diag(`estrategia ${s.kind}: CLM tomó ${(Number(uU) / Number(U1)).toFixed(4)} ${N.stableSym} + ${rate > 0 ? (Number(uX) / rate / Number(U1)).toFixed(4) : "?"} en X de ${(Number(uAmt) / Number(U1)).toFixed(4)} + ${rate > 0 ? (Number(xAmt) / rate / Number(U1)).toFixed(4) : "?"} ofrecidos · sin aceptar ≈ ${(leftU + leftXinStable).toFixed(4)} ${N.stableSym} (se intenta reinvertir enseguida)`);
    await s.save();
  }
  // 3b) lo que el CLM no tomó no se queda suelto: hasta 2 pasadas (depositar lo que acepte; el X que rechace se vende al
  //     estable). El estable que aún sobre queda en r.cleanup.leftStable para que la estrategia lo reinvierta.
  if (r.cleanup === undefined) {
    const used = r.used.map(BigInt), [uU0, uX0] = r.usdcIs0 ? used : [used[1], used[0]];
    let lu = BigInt(r.usdcForClm) - uU0, lx = BigInt(r.xIn) - uX0, added = 0n, passes = 0, soldX = 0n;
    const stableUsd = N.wrapNative ? (ctx?.ethUsd || 0) : 1;
    const dust = stableUsd > 0 ? ethers.parseUnits((0.2 / stableUsd).toFixed(Math.min(D, 12)), D) : 10n ** 30n;
    const rate = r.ratio?.rate || 0, xVal = (x) => (rate > 0 ? BigInt(Math.floor(Number(x) / rate)) : 0n);
    const sellX = async (x) => { const got = r.dex === "otro" ? await routeSwap(s, r.x, N.stable, x, `swap sobrante X→${N.stableSym}`) : await slipSwap(s, r.x, N.stable, x, x / 100n || 1n, `swap sobrante X→${N.stableSym}`); soldX += x; return got; };
    for (; passes < 2 && (lu > dust || xVal(lx) > dust); passes++) {
      let [a0, a1] = r.usdcIs0 ? [lu, lx] : [lx, lu];
      let [sh, u0, u1] = await call(s, r.clm, "previewDeposit", [a0, a1]).catch(() => [0n, 0n, 0n]);
      const [tU, tX] = r.usdcIs0 ? [u0, u1] : [u1, u0];
      if (sh === 0n || (tU + xVal(tX)) * 2n < lu + xVal(lx)) {
        // el CLM no toma esta mezcla: el X sobrante se vende al estable y se intenta solo con estable
        if (xVal(lx) > dust) { lu += await sellX(lx); lx = 0n; }
        [a0, a1] = r.usdcIs0 ? [lu, 0n] : [0n, lu];
        [sh, u0, u1] = await call(s, r.clm, "previewDeposit", [a0, a1]).catch(() => [0n, 0n, 0n]);
        if (sh === 0n) break; // tampoco acepta solo estable: queda para la estrategia
      }
      if (a0 > 0n) await approve(s, r.t0, r.clm, a0, "approve token0→CLM (sobrante)");
      if (a1 > 0n) await approve(s, r.t1, r.clm, a1, "approve token1→CLM (sobrante)");
      const before = await bal(s, r.clm);
      try { await s.sim({ to: r.clm, data: C.encodeFunctionData("deposit(uint256,uint256,uint256)", [a0, a1, sh * 99n / 100n]) }); } catch { break; }
      await s.send("deposit CLM (sobrante)", { to: r.clm, data: C.encodeFunctionData("deposit(uint256,uint256,uint256)", [a0, a1, sh * 99n / 100n]) });
      added += (await bal(s, r.clm)) - before;
      const [v0, v1] = r.usdcIs0 ? [u0, u1] : [u1, u0];
      lu -= v0; lx -= v1;
    }
    if (xVal(lx) > dust) { lu += await sellX(lx); lx = 0n; }
    r.clmShares = String(BigInt(r.clmShares) + added);
    r.cleanup = { passes, added: String(added), soldX: String(soldX), leftStable: String(lu > dust ? lu : 0n), leftX: String(lx > 0n ? lx : 0n) };
    await s.save();
    if (passes || soldX > 0n) await s.diag(`estrategia ${s.kind}: sobrante reinvertido · ${passes} pasada(s), +${added} participaciones${soldX > 0n ? `, X vendido ${soldX}` : ""} · queda ${ethers.formatUnits(lu > 0n ? lu : 0n, D)} ${N.stableSym} para la estrategia`);
  }
  // 4) participaciones del CLM → vault que compone
  if (r.mooShares === undefined) {
    const sh = BigInt(r.clmShares);
    await approve(s, r.clm, r.vault, sh, "approve CLM→vault");
    const before = await bal(s, r.vault);
    await s.send(r.gov ? "stake reward pool Beefy" : "deposit vault Beefy", { to: r.vault, data: r.gov ? C.encodeFunctionData("stake", [sh]) : C.encodeFunctionData("deposit(uint256)", [sh]) });
    r.mooShares = String((await bal(s, r.vault)) - before); await s.save();
  }
  await s.diag(`estrategia ${s.kind}: depósito hecho · ${r.vaultId} · ${r.ethIn} nativo → ${ethers.formatUnits(r.usdcIn, D)} ${N.stableSym} → CLM ${r.clmShares} → vault ${r.mooShares} · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`);
}

export async function exitClm(s, ctx) {
  const r = s.run;
  await resolve(s);
  if (r.clmOut === undefined) {
    const before = await bal(s, r.clm);
    const held = await bal(s, r.vault);
    if (r.gov && held > 0n && r.claimedStable === undefined) {
      // las recompensas cobradas al salir son rendimiento de la estrategia: se registran (valuadas en el estable)
      const got = await claimRewards(s, "getReward antes de salir").catch(() => []);
      let v = 0n; for (const g of got) if (g.amount > 0n) v += await tokenValue(s, g.token, g.amount).catch(() => 0n);
      r.claimedStable = String(v); await s.save();
    }
    if (held > 0n) await s.send(r.gov ? "withdraw reward pool Beefy" : "withdrawAll vault Beefy", { to: r.vault, data: r.gov ? C.encodeFunctionData("withdraw(uint256)", [held]) : C.encodeFunctionData("withdrawAll") });
    r.clmOut = String((await bal(s, r.clm)) - before); await s.save();
  }
  if (r.usdcOut === undefined) {
    const sh = await bal(s, r.clm);
    const bU0 = await bal(s, s.net.stable), bX0 = await bal(s, r.x);
    if (r.noStable) r.b1Before = String(await bal(s, r.t1));
    if (sh > 0n) {
      const [m0, m1] = await call(s, r.clm, "previewWithdraw", [sh]);
      try { await s.sim({ to: r.clm, data: C.encodeFunctionData("withdraw(uint256,uint256,uint256)", [sh, m0 * 99n / 100n, m1 * 99n / 100n]) }); }
      catch (e) { throw retry(`withdraw del CLM no pasa la simulación (${(e.shortMessage || e.message).slice(0, 120)})`); }
      await s.send("withdraw CLM", { to: r.clm, data: C.encodeFunctionData("withdraw(uint256,uint256,uint256)", [sh, m0 * 99n / 100n, m1 * 99n / 100n]) });
    }
    if (r.noStable) {
      const b1 = await bal(s, r.t1);
      const g0 = (await bal(s, r.t0)) - bX0, g1 = b1 - (r.b1Before ? BigInt(r.b1Before) : 0n);
      if (g0 > 0n) await routeSwap(s, r.t0, s.net.stable, g0, `swap token0→${s.net.stableSym}`);
      if (g1 > 0n) await routeSwap(s, r.t1, s.net.stable, g1, `swap token1→${s.net.stableSym}`);
      r.usdcOut = String((await bal(s, s.net.stable)) - bU0); r.xSold = String(g0); await s.save();
    } else {
    const xGot = await bal(s, r.x); // todo el X de la wallet: lo retirado + sobrantes de depósitos anteriores en este vault
    const uFromX = xGot > 0n ? (r.dex === "otro" ? await routeSwap(s, r.x, s.net.stable, xGot, `swap X→${s.net.stableSym}`) : await slipSwap(s, r.x, s.net.stable, xGot, xGot / 100n, `swap X→${s.net.stableSym}`)) : 0n;
    r.usdcOut = String((await bal(s, s.net.stable)) - bU0); r.xSold = String(xGot); r.usdcFromX = String(uFromX); await s.save();
    }
  }
  const amt = BigInt(r.usdcOut);
  if (amt <= 0n) throw new Error("no salió USDC del CLM");
  if (s.net.nativeFee === null || s.keepStable) { await s.diag(`estrategia beefy-clm-exit: cerrada · ${ethers.formatUnits(amt, s.net.stableDec)} ${s.net.stableSym} quedan en la wallet · txs ${r.txs.map((t) => `${t.step} ${t.hash}`).join(" | ")}`); return; }
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
    else if (lc(g.token) === lc(r.x)) stable += r.dex === "otro" ? await routeSwap(s, r.x, N.stable, g.amount, `swap recompensa X→${N.stableSym}`) : await slipSwap(s, r.x, N.stable, g.amount, g.amount / 100n || 1n, `swap recompensa X→${N.stableSym}`);
    else other.push({ token: g.token, amount: String(g.amount) });
  }
  return { stable, other };
}

/**
 * Composición (STRATEGY_COMPOUND=1): valora las recompensas pendientes del reward pool; si valen ≥ minStable (crudo, en el
 * estable), las cobra. Devuelve {value, stable, x, other} (crudo) o {skipped, value} si no alcanzan. El depósito lo hace
 * Strategy con enterClm en modo barrido (estable cobrado + X de la wallet).
 */
export async function claimForCompound(s, minStable) {
  const r = s.run, N = s.net;
  await resolve(s);
  if (!r.gov) return { skipped: true, value: 0n };
  const pend = await pendingRewards(s);
  let value = 0n;
  for (const p of pend) {
    if (lc(p.token) === lc(N.stable)) value += p.amount;
    else if (lc(p.token) === lc(r.x)) { if (r.dex !== "uni") await approve(s, r.x, r.router, p.amount, "approve X→router (cotización)"); value += await slipQuote(s, r.x, N.stable, p.amount); }
  }
  if (value < minStable) return { skipped: true, value };
  const got = await claimRewards(s, "cobrar recompensas (componer)");
  const out = { value, stable: 0n, x: 0n, other: [] };
  for (const g of got) {
    if (g.amount <= 0n) continue;
    if (lc(g.token) === lc(N.stable)) out.stable += g.amount; else if (lc(g.token) === lc(r.x)) out.x += g.amount; else out.other.push({ token: g.token, amount: String(g.amount) });
  }
  return out;
}

/** Vende al estable todo el saldo de los tokens no estables de un vault (sobrantes huérfanos). Devuelve lo obtenido (crudo). */
export async function sellVaultTokens(s, id, { dustStable = 0n } = {}) {
  const prev = s.run, prevId = s.vaultId;
  s.run = { txs: [], extra: true }; s.vaultId = id; s.allowInactive = true;
  try {
    await resolve(s);
    const r = s.run, N = s.net, toks = (r.noStable ? [r.t0, r.t1] : [r.x]).filter((t) => t && lc(t) !== lc(N.stable));
    let got = 0n; const sold = [];
    for (const t of toks) {
      const b = await bal(s, t);
      if (b === 0n) continue;
      const q = (await bestPath(s, t, N.stable, b).catch(() => null))?.out ?? 0n;
      if (q <= dustStable) continue;
      got += r.dex === "otro" || r.noStable || lc(t) !== lc(r.x) ? await routeSwap(s, t, N.stable, b, `swap sobrante→${N.stableSym}`) : await slipSwap(s, t, N.stable, b, b / 100n || 1n, `swap sobrante→${N.stableSym}`);
      sold.push({ token: t, amount: String(b) });
    }
    return { got, sold, txs: r.txs };
  } finally { s.run = prev; s.vaultId = prevId; s.allowInactive = false; }
}

/** Valor de la posición de la wallet en un vault (participaciones del vault + CLM suelto), en estable crudo, y los tokens del par. */
export async function vaultValue(s, id) {
  const prev = s.run, prevId = s.vaultId;
  s.run = { txs: [], extra: true }; s.vaultId = id; s.allowInactive = true; s.quietResolve = true;
  try {
    await resolve(s);
    const r = s.run, N = s.net;
    let sh = await bal(s, r.vault);
    if (!r.gov && sh > 0n) sh = sh * (await call(s, r.vault, "getPricePerFullShare"))[0] / 10n ** 18n;
    sh += await bal(s, r.clm);
    const tokens = [r.t0 ?? (r.usdcIs0 ? N.stable : r.x), r.t1 ?? (r.usdcIs0 ? r.x : N.stable)];
    // recompensas por cobrar del reward pool (en los CLM son las comisiones), valuadas en el estable
    let pending = 0n;
    if (r.gov) { try { const [tk, am] = await call(s, r.vault, "earned(address)", [s.me]); for (let i = 0; i < tk.length; i++) pending += await tokenValue(s, tk[i], am[i]); } catch {} }
    if (sh === 0n) return { value: 0n, tokens, shares: 0n, gov: !!r.gov, pending };
    const [[a0, a1], [ts]] = await Promise.all([call(s, r.clm, "balances"), call(s, r.clm, "totalSupply")]);
    const q = [a0 * sh / ts, a1 * sh / ts];
    let value = 0n;
    for (let i = 0; i < 2; i++) value += lc(tokens[i]) === lc(N.stable) ? q[i] : q[i] > 0n ? ((await bestPath(s, tokens[i], N.stable, q[i]).catch(() => null))?.out ?? 0n) : 0n;
    return { value, tokens, shares: sh, gov: !!r.gov, pending };
  } finally { s.run = prev; s.vaultId = prevId; s.allowInactive = false; s.quietResolve = false; }
}
/** Valor en estable crudo de un saldo de token (0 si no hay ruta). */
export async function tokenValue(s, token, amount) {
  if (amount <= 0n) return 0n;
  if (lc(token) === lc(s.net.stable)) return amount;
  return (await bestPath(s, token, s.net.stable, amount).catch(() => null))?.out ?? 0n;
}

// ---------------------------------------------------------------- comisiones MEDIDAS (eventos Harvest del CLM)
// En cada harvest la estrategia del CLM cobra las comisiones del pool, descuenta la parte de Beefy y compone el resto en la
// posición, emitiendo Harvest(fee0, fee1). Nuestra parte = fee × (participaciones nuestras / totalSupply del CLM) en ese bloque.
// El nodo de Robinhood no guarda estado histórico, así que ambas cantidades se reconstruyen hacia atrás desde el valor actual con
// los Transfer: mints/burns del CLM (totalSupply) y entradas/salidas de nuestra wallet en el reward pool / vault / CLM.
const HV = new ethers.Interface(["event Harvest(uint256 fee0, uint256 fee1)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
const HARVEST_TOPIC = HV.getEvent("Harvest").topicHash, TRANSFER_TOPIC = HV.getEvent("Transfer").topicHash;
const ZERO32 = ethers.zeroPadValue("0x", 32);
/** Reconstrucción (pura, probada): valor en el bloque b = actual − Σ deltas con bloque > b. ev: [{b, d}] (d en string). */
export function valueAt(nowVal, ev, b) { let v = BigInt(nowVal); for (const e of ev) if (e.b > b) v -= BigInt(e.d); return v; }
/**
 * Avanza el escaneo desde sinceMs (primer depósito) y devuelve nuestra parte de las comisiones compuestas.
 * st = estado persistente (se modifica). budget = máx. rangos de bloques por corrida. Devuelve {usd (crudo en estable), n, behindBlocks}.
 */
export async function harvestFees(s, id, st, { sinceMs, budget = 25 } = {}) {
  const prev = s.run, prevId = s.vaultId;
  s.run = { txs: [], extra: true }; s.vaultId = id; s.allowInactive = true; s.quietResolve = true;
  try {
    await resolve(s);
    const r = s.run, N = s.net, me = ethers.zeroPadValue(s.me, 32);
    const tokens = [r.t0 ?? (r.usdcIs0 ? N.stable : r.x), r.t1 ?? (r.usdcIs0 ? r.x : N.stable)];
    st.strategy ??= (await call(s, r.clm, "strategy"))[0];
    const head = await s.provider.getBlockNumber();
    if (st.from == null || st.v !== 3) {
      const [b1, b0] = await Promise.all([s.provider.getBlock(head), s.provider.getBlock(Math.max(0, head - 20000))]);
      const bt = Math.max(0.05, (b1.timestamp - b0.timestamp) / Math.max(1, b1.number - b0.number));
      Object.assign(st, { v: 3, from: Math.max(0, head - Math.ceil((Date.now() - (sinceMs ?? Date.now())) / 1000 / bt * 1.1)), hv: [], sup: [], mine: [], span: 20000 });
    }
    const wrap = lc(r.vault) !== lc(r.clm) ? r.vault : null; // reward pool / vault que envuelve el CLM
    const logs = (f) => s.provider.getLogs(f);
    let span = st.span, calls = 0;
    while (st.from <= head && calls < budget) {
      const to = Math.min(head, st.from + span - 1), R = { fromBlock: st.from, toBlock: to };
      calls++;
      let got;
      try {
        got = await Promise.all([
          logs({ ...R, address: st.strategy, topics: [HARVEST_TOPIC] }),
          logs({ ...R, address: r.clm, topics: [TRANSFER_TOPIC, ZERO32] }), logs({ ...R, address: r.clm, topics: [TRANSFER_TOPIC, null, ZERO32] }),
          logs({ ...R, address: r.clm, topics: [TRANSFER_TOPIC, me] }), logs({ ...R, address: r.clm, topics: [TRANSFER_TOPIC, null, me] }),
          ...(wrap ? [logs({ ...R, address: wrap, topics: [TRANSFER_TOPIC, me] }), logs({ ...R, address: wrap, topics: [TRANSFER_TOPIC, null, me] })] : []),
        ]);
      } catch { if (span > 500) { span = Math.max(500, Math.floor(span / 4)); continue; } throw new Error("eth_getLogs no responde"); }
      const [h, mint, burn, cOut, cIn, wOut = [], wIn = []] = got;
      for (const l of h) { const a = HV.parseLog(l).args; st.hv.push({ b: l.blockNumber, f0: String(a.fee0), f1: String(a.fee1) }); }
      const amt = (l) => BigInt(l.data);
      for (const l of mint) st.sup.push({ b: l.blockNumber, d: String(amt(l)) });
      for (const l of burn) st.sup.push({ b: l.blockNumber, d: String(-amt(l)) });
      // nuestras participaciones (en CLM): CLM suelto + envuelto. En vaults no-gov se usa el ppfs actual (aproximado).
      let pp = 10n ** 18n;
      if (wrap && !r.gov && (wOut.length || wIn.length)) pp = (await call(s, r.vault, "getPricePerFullShare"))[0];
      for (const l of cIn) st.mine.push({ b: l.blockNumber, d: String(amt(l)) });
      for (const l of cOut) st.mine.push({ b: l.blockNumber, d: String(-amt(l)) });
      for (const l of wIn) st.mine.push({ b: l.blockNumber, d: String(amt(l) * pp / 10n ** 18n) });
      for (const l of wOut) st.mine.push({ b: l.blockNumber, d: String(-amt(l) * pp / 10n ** 18n) });
      st.from = to + 1;
      if (h.length + mint.length + burn.length < 200 && span < 400000) span *= 2;
    }
    st.span = span;
    // participaciones actuales → hacia atrás
    let mineNow = (await call(s, r.vault, "balanceOf", [s.me]))[0];
    if (wrap && !r.gov && mineNow > 0n) mineNow = mineNow * (await call(s, r.vault, "getPricePerFullShare"))[0] / 10n ** 18n;
    if (wrap) mineNow += (await call(s, r.clm, "balanceOf", [s.me]))[0];
    const [supNow] = await call(s, r.clm, "totalSupply");
    let my0 = 0n, my1 = 0n, n = 0, tot0 = 0n, tot1 = 0n;
    for (const e of st.hv) {
      // las participaciones al momento del harvest = estado al final del bloque anterior (mismo bloque: se toma el previo)
      const sh = valueAt(mineNow, st.mine, e.b - 1), ts = valueAt(supNow, st.sup, e.b - 1);
      tot0 += BigInt(e.f0); tot1 += BigInt(e.f1);
      if (ts > 0n && sh > 0n) { my0 += BigInt(e.f0) * sh / ts; my1 += BigInt(e.f1) * sh / ts; n++; }
    }
    const usd = (await tokenValue(s, tokens[0], my0)) + (await tokenValue(s, tokens[1], my1));
    st.last = { n, all: st.hv.length, my0: String(my0), my1: String(my1), tot0: String(tot0), tot1: String(tot1) };
    if (!st.diagDone && st.from > head) {
      st.diagDone = true;
      const tv = (await tokenValue(s, tokens[0], tot0)) + (await tokenValue(s, tokens[1], tot1));
      s.diag?.(`comisiones medidas ${id}: ${st.hv.length} harvests desde el primer depósito (${n} con participación nuestra) · CLM entero cobró ${(Number(tv) / 10 ** (N.stableDec ?? 18)).toPrecision(4)} ${N.stableSym} · nuestra parte ${(Number(usd) / 10 ** (N.stableDec ?? 18)).toPrecision(4)} ${N.stableSym} · movimientos de supply ${st.sup.length}, nuestros ${st.mine.length}`);
    }
    return { usd, n, behindBlocks: Math.max(0, head - st.from + 1), approx: 0 };
  } finally { s.run = prev; s.vaultId = prevId; s.allowInactive = false; s.quietResolve = false; }
}
