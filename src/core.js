// Núcleo del simulador: lectura on-chain de Base + pipeline del protocolo (puntos 1-3).
// Funciona en el navegador (ethers global) y en Node (ethers importado). Todo con BigInt.

export const CHAIN_ID = 8453n;

export const TOKENS = {
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
};

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const GAS_ORACLE = "0x420000000000000000000000000000000000000F"; // OP Stack: fee L1

// Factories en Base: las direcciones de pool se obtienen on-chain, no están escritas a mano.
export const FACTORIES = [
  { name: "Uniswap v3", kind: "v3fee", address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", params: [100, 500, 3000, 10000] },
  { name: "PancakeSwap v3", kind: "v3fee", address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", params: [100, 500, 2500, 10000] },
  { name: "Aerodrome Slipstream", kind: "v3tick", address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", params: [1, 50, 100, 200] },
  { name: "Uniswap v2", kind: "v2pair", address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", feeBps: 30 },
  { name: "PancakeSwap v2", kind: "v2pair", address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E", feeBps: 25 },
  { name: "Aerodrome", kind: "aero", address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" },
];

// Proveedores de flashloan (punto 2). La liquidez y la comisión se leen on-chain.
export const LENDERS = [
  { name: "Morpho Blue", kind: "balance", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", feeBps: 0n },
  { name: "Balancer v3", kind: "balance", address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", feeBps: 0n },
  { name: "Aave v3", kind: "aave", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", feeBps: null },
];

export const GAS_BASE = 120000n;
export const GAS_PER_HOP = 90000n;
export const CALLDATA_BYTES = 740; // tamaño típico de execute(plan) con 2-3 saltos

const ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  "function getPool(address,address,uint24) view returns (address)",
  "function getPool(address,address,int24) view returns (address)",
  "function getPool(address,address,bool) view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function stable() view returns (bool)",
  "function factory() view returns (address)",
  "function getFee(address,bool) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function getL1Fee(bytes) view returns (uint256)",
];

export function makeIface(ethers) {
  return new ethers.Interface(ABI);
}

// ------------------------------------------------------------------ Multicall

export async function multicall(ethers, provider, calls, blockTag = "latest") {
  const iface = makeIface(ethers);
  const out = [];
  for (let i = 0; i < calls.length; i += 200) {
    const part = calls.slice(i, i + 200).map((c) => ({ target: c[0], allowFailure: true, callData: c[1] }));
    const data = iface.encodeFunctionData("aggregate3", [part]);
    const raw = await provider.call({ to: MULTICALL3, data, blockTag });
    const [res] = iface.decodeFunctionResult("aggregate3", raw);
    for (const r of res) out.push(r.success && r.returnData !== "0x" ? r.returnData : null);
  }
  return out;
}

const enc = (iface, sig, args = []) => iface.encodeFunctionData(sig, args);
const dec = (iface, sig, raw) => (raw ? iface.decodeFunctionResult(sig, raw) : null);
const word = (raw, i) => BigInt("0x" + raw.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const ZERO = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------ Descubrimiento

export async function discoverPools(ethers, provider, tokens = TOKENS, factories = FACTORIES) {
  const iface = makeIface(ethers);
  const list = Object.values(tokens).map((t) => t.address);
  const pairs = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);

  const calls = [];
  const meta = [];
  for (const f of factories) {
    for (const [a, b] of pairs) {
      if (f.kind === "v3fee" || f.kind === "v3tick") {
        const sig = f.kind === "v3fee" ? "getPool(address,address,uint24)" : "getPool(address,address,int24)";
        for (const p of f.params) {
          calls.push([f.address, enc(iface, sig, [a, b, p])]);
          meta.push({ dex: f.name, feeHint: null });
        }
      } else if (f.kind === "v2pair") {
        calls.push([f.address, enc(iface, "getPair", [a, b])]);
        meta.push({ dex: f.name, feeHint: f.feeBps });
      } else if (f.kind === "aero") {
        calls.push([f.address, enc(iface, "getPool(address,address,bool)", [a, b, false])]);
        meta.push({ dex: f.name + " (volátil)", feeHint: null, aeroFactory: f.address });
      }
    }
  }
  const res = await multicall(ethers, provider, calls);
  const found = new Map();
  res.forEach((raw, i) => {
    if (!raw) return;
    const addr = ethers.getAddress("0x" + raw.slice(-40));
    if (addr !== ZERO && !found.has(addr)) found.set(addr, meta[i]);
  });
  return found; // address -> {dex, feeHint, aeroFactory?}
}

// ------------------------------------------------------------------ Carga y refresco de pools

export async function loadPools(ethers, provider, found, tokens = TOKENS) {
  const iface = makeIface(ethers);
  const byAddr = new Map(Object.entries(tokens).map(([sym, t]) => [t.address.toLowerCase(), { sym, ...t }]));
  const addrs = [...found.keys()];
  const calls = [];
  for (const a of addrs) {
    calls.push([a, enc(iface, "token0")], [a, enc(iface, "token1")], [a, "0x3850c7bd"] /* slot0() */,
      [a, enc(iface, "fee")], [a, enc(iface, "getReserves")]);
  }
  const r = await multicall(ethers, provider, calls);
  const pools = [];
  const aeroFee = [];
  addrs.forEach((a, i) => {
    const [t0, t1, s0, fee, res] = r.slice(5 * i, 5 * i + 5);
    if (!t0 || !t1) return;
    const tok0 = byAddr.get(ethers.getAddress("0x" + t0.slice(-40)).toLowerCase());
    const tok1 = byAddr.get(ethers.getAddress("0x" + t1.slice(-40)).toLowerCase());
    if (!tok0 || !tok1) return;
    const m = found.get(a);
    const p = { address: a, dex: m.dex, token0: tok0, token1: tok1, reserve0: 0n, reserve1: 0n };
    if (s0 && fee) {
      p.kind = "v3";
      p.feeBps = Number(word(fee, 0)) / 100; // pips -> bps (puede ser fraccional: 0.01% = 1 bps)
      p.feePips = word(fee, 0);
    } else if (res) {
      p.kind = "v2";
      p.feePips = BigInt(Math.round((m.feeHint ?? 30) * 100));
      p.feeBps = m.feeHint ?? 30;
      if (m.aeroFactory) aeroFee.push(p);
    } else return;
    pools.push(p);
  });
  // Aerodrome: comisión real por pool desde su factory
  if (aeroFee.length) {
    const calls2 = aeroFee.map((p) => [found.get(p.address).aeroFactory, enc(iface, "getFee", [p.address, false])]);
    const r2 = await multicall(ethers, provider, calls2);
    aeroFee.forEach((p, i) => {
      if (r2[i]) {
        const bps = Number(word(r2[i], 0)); // Aerodrome expresa la comisión en bps
        p.feeBps = bps;
        p.feePips = BigInt(bps * 100);
      }
    });
  }
  await refreshPools(ethers, provider, pools);
  return pools;
}

export async function refreshPools(ethers, provider, pools, blockTag = "latest") {
  const iface = makeIface(ethers);
  const calls = [];
  for (const p of pools) {
    if (p.kind === "v3") calls.push([p.address, "0x3850c7bd"], [p.address, enc(iface, "liquidity")]);
    else calls.push([p.address, enc(iface, "getReserves")]);
  }
  const r = await multicall(ethers, provider, calls, blockTag);
  let k = 0;
  for (const p of pools) {
    if (p.kind === "v3") {
      const s0 = r[k++], liq = r[k++];
      if (!s0 || !liq) { p.reserve0 = p.reserve1 = 0n; continue; }
      p.sqrtPriceX96 = word(s0, 0);
      p.liquidity = word(liq, 0);
      [p.reserve0, p.reserve1] = v3VirtualReserves(p.sqrtPriceX96, p.liquidity);
    } else {
      const res = r[k++];
      if (!res) { p.reserve0 = p.reserve1 = 0n; continue; }
      p.reserve0 = word(res, 0);
      p.reserve1 = word(res, 1);
    }
  }
}

// ------------------------------------------------------------------ Matemática AMM

export const Q96 = 1n << 96n;

export function v3VirtualReserves(sqrtP, L) {
  if (sqrtP === 0n || L === 0n) return [0n, 0n];
  return [(L * Q96) / sqrtP, (L * sqrtP) / Q96];
}

export function amountOut(amountIn, rIn, rOut, feePips) {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const inFee = amountIn * (1000000n - feePips);
  return (inFee * rOut) / (rIn * 1000000n + inFee);
}

export function reservesFor(p, tokenAddr) {
  return tokenAddr === p.token0.address ? [p.reserve0, p.reserve1] : [p.reserve1, p.reserve0];
}

export function other(p, tokenAddr) {
  return tokenAddr === p.token0.address ? p.token1 : p.token0;
}

export function routeOut(x, start, route) {
  let t = start, a = x;
  for (const p of route) {
    const [ri, ro] = reservesFor(p, t);
    a = amountOut(a, ri, ro, p.feePips);
    t = other(p, t).address;
    if (a === 0n) return 0n;
  }
  return a;
}

export function bestSize(start, route, hi) {
  if (hi <= 1n) return [0n, 0n];
  let lo = 1n;
  for (let i = 0; i < 400 && hi - lo > 2n; i++) {
    const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
    if (routeOut(m1, start, route) - m1 < routeOut(m2, start, route) - m2) lo = m1; else hi = m2;
  }
  let bx = 0n, bp = 0n;
  for (const x of hi - lo <= 2n ? [lo, lo + 1n, hi] : [lo, (lo + hi) / 2n, hi]) {
    const p = routeOut(x, start, route) - x;
    if (p > bp) { bp = p; bx = x; }
  }
  return [bx, bp];
}

// Precio de token1 en token0 (humano) para mostrar
export function poolPrice(p, base = "WETH") {
  const [b, q] = p.token0.sym === base ? [p.token0, p.token1] : [p.token1, p.token0];
  if (p.kind === "v3") {
    const sp = Number(p.sqrtPriceX96) / 2 ** 96;
    let px = sp * sp * 10 ** (p.token0.decimals - p.token1.decimals); // token1 por token0
    return p.token0.sym === base ? px : 1 / px;
  }
  const [rb, rq] = reservesFor(p, b.address);
  return Number(rq) / 10 ** q.decimals / (Number(rb) / 10 ** b.decimals);
}

// ------------------------------------------------------------------ Ciclos

export function enumerateCycles(pools, startSyms = ["WETH", "USDC"], maxHops = 3) {
  const byTok = new Map();
  for (const p of pools) for (const t of [p.token0.address, p.token1.address]) {
    if (!byTok.has(t)) byTok.set(t, []);
    byTok.get(t).push(p);
  }
  const out = [];
  const seen = new Set();
  const add = (start, route) => {
    const k = start + ":" + route.map((p) => p.address).join(">");
    if (!seen.has(k)) { seen.add(k); out.push({ start, route, key: k }); }
  };
  for (const sym of startSyms) {
    const s = TOKENS[sym].address;
    for (const a of byTok.get(s) || []) {
      const t1 = other(a, s).address;
      for (const b of byTok.get(t1) || []) {
        if (b === a) continue;
        if (other(b, t1).address === s) add(s, [a, b]);
        else if (maxHops >= 3) {
          const t2 = other(b, t1).address;
          for (const c of byTok.get(t2) || []) {
            if (c === a || c === b) continue;
            if (other(c, t2).address === s) add(s, [a, b, c]);
          }
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ Proveedores de flashloan

export async function readLenders(ethers, provider, tokens = TOKENS, lenders = LENDERS) {
  const iface = makeIface(ethers);
  const aaveIface = new ethers.Interface(["function getReserveData(address) view returns (uint256[15])"]);
  const calls = [];
  const meta = [];
  for (const l of lenders) {
    for (const [sym, t] of Object.entries(tokens)) {
      if (l.kind === "balance") {
        calls.push([t.address, enc(iface, "balanceOf", [l.address])]);
        meta.push({ l, sym, what: "bal" });
      } else {
        calls.push([l.address, aaveIface.encodeFunctionData("getReserveData", [t.address])]);
        meta.push({ l, sym, what: "aave" });
      }
    }
    if (l.kind === "aave") {
      calls.push([l.address, enc(iface, "FLASHLOAN_PREMIUM_TOTAL")]);
      meta.push({ l, what: "premium" });
    }
  }
  const r = await multicall(ethers, provider, calls);
  const state = lenders.map((l) => ({ name: l.name, address: l.address, feeBps: l.feeBps, liquidity: {}, ok: false }));
  const idx = new Map(state.map((s) => [s.name, s]));
  const aTokens = [];
  r.forEach((raw, i) => {
    const m = meta[i], s = idx.get(m.l.name);
    if (!raw) return;
    s.ok = true;
    if (m.what === "bal") s.liquidity[m.sym] = word(raw, 0);
    else if (m.what === "premium") s.feeBps = word(raw, 0);
    else if (m.what === "aave") {
      const aToken = ethers.getAddress("0x" + raw.slice(2 + 64 * 8 + 24, 2 + 64 * 9)); // ReserveData.aTokenAddress
      if (aToken !== ZERO) aTokens.push({ s, sym: m.sym, aToken });
    }
  });
  if (aTokens.length) {
    const r2 = await multicall(ethers, provider, aTokens.map((x) => [tokens[x.sym].address, enc(iface, "balanceOf", [x.aToken])]));
    aTokens.forEach((x, i) => { if (r2[i]) x.s.liquidity[x.sym] = word(r2[i], 0); });
  }
  return state;
}

// Selector del punto 2: primero gratuito con saldo suficiente; si no, Aave.
export function pickLender(lenders, sym, amount) {
  const free = lenders.filter((l) => l.ok && l.feeBps === 0n && (l.liquidity[sym] ?? 0n) >= amount);
  if (free.length) return { ...free[0], fee: 0n };
  const paid = lenders.filter((l) => l.ok && l.feeBps !== null && l.feeBps > 0n && (l.liquidity[sym] ?? 0n) >= amount);
  if (paid.length) return { ...paid[0], fee: (amount * paid[0].feeBps) / 10000n };
  return null;
}

// ------------------------------------------------------------------ Gas real de Base

export async function readGas(ethers, provider) {
  const iface = makeIface(ethers);
  const [block, prio] = await Promise.all([
    provider.getBlock("latest"),
    provider.send("eth_maxPriorityFeePerGas", []).catch(() => "0x0"),
  ]);
  let l1Fee = 0n;
  try {
    const dummy = "0x" + "ab".repeat(CALLDATA_BYTES);
    const raw = await provider.call({ to: GAS_ORACLE, data: enc(iface, "getL1Fee", [dummy]) });
    l1Fee = BigInt(raw);
  } catch { /* cadena sin oráculo L1 (p. ej. local) */ }
  return {
    number: block.number,
    timestamp: block.timestamp,
    baseFee: block.baseFeePerGas ?? 0n,
    priority: BigInt(prio),
    l1Fee,
  };
}

// ------------------------------------------------------------------ Evaluación (pipeline completo)

export function evaluateAll({ pools, cycles, lenders, gas, ethUsd, minNetUsd = 0 }) {
  const results = [];
  for (const c of cycles) {
    const startTok = c.route[0].token0.address === c.start ? c.route[0].token0 : c.route[0].token1;
    if (c.route.some((p) => p.reserve0 === 0n || p.reserve1 === 0n)) continue;
    const firstRes = reservesFor(c.route[0], c.start)[0];
    let cap = firstRes / 20n; // como el bot: no más de 1/20 de la reserva de entrada
    const maxLend = lenders.reduce((m, l) => ((l.liquidity[startTok.sym] ?? 0n) > m ? l.liquidity[startTok.sym] : m), 0n);
    if (maxLend > 0n && maxLend < cap) cap = maxLend;

    // spread "marginal": rendimiento de un monto pequeño (1/1e6 de la reserva)
    const probe = firstRes / 1000000n || 1n;
    const marginalBps = Number(((routeOut(probe, c.start, c.route) - probe) * 1000000n) / probe) / 100;

    const [x, gross] = bestSize(c.start, c.route, cap);
    const toUsd = (amt) => {
      const units = Number(amt) / 10 ** startTok.decimals;
      return startTok.sym === "USDC" ? units : startTok.sym === "WETH" ? units * ethUsd : NaN;
    };
    const gasUnits = GAS_BASE + GAS_PER_HOP * BigInt(c.route.length);
    const gasWei = gasUnits * (gas.baseFee + gas.priority) + gas.l1Fee;
    const gasUsd = (Number(gasWei) / 1e18) * ethUsd;
    let lender = null, flashFeeUsd = 0, grossUsd = 0, netUsd = -gasUsd;
    if (x > 0n) {
      lender = pickLender(lenders, startTok.sym, x);
      grossUsd = toUsd(gross);
      flashFeeUsd = lender ? toUsd(lender.fee) : 0;
      netUsd = grossUsd - flashFeeUsd - gasUsd;
    }
    results.push({
      key: c.key,
      start: startTok.sym,
      route: c.route,
      hops: c.route.length,
      marginalBps,
      feesBps: c.route.reduce((s, p) => s + p.feeBps, 0),
      amountIn: x,
      amountInUsd: x > 0n ? toUsd(x) : 0,
      grossUsd,
      gasUsd,
      flashFeeUsd,
      lender: lender ? lender.name : x > 0n ? "sin liquidez" : "—",
      netUsd,
      profitable: x > 0n && netUsd > minNetUsd,
    });
  }
  results.sort((a, b) => b.netUsd - a.netUsd || b.marginalBps - a.marginalBps);
  return results;
}

export function referenceEthUsd(pools) {
  // mediana ponderada simple: precio WETH/USDC de los pools con más reservas
  const ps = pools
    .filter((p) => [p.token0.sym, p.token1.sym].sort().join() === "USDC,WETH" && p.reserve0 > 0n)
    .map((p) => ({ px: poolPrice(p, "WETH"), w: Number(reservesFor(p, TOKENS.USDC.address)[0]) }))
    .filter((x) => isFinite(x.px) && x.px > 0)
    .sort((a, b) => a.px - b.px);
  if (!ps.length) return NaN;
  const total = ps.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of ps) { acc += x.w; if (acc >= total / 2) return x.px; }
  return ps[ps.length - 1].px;
}
