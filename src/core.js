import { excludedSet } from "./pairs.js";
import * as CL from "./clmath.js";
// Núcleo del simulador: lectura on-chain de Base + pipeline del protocolo (puntos 1-3).
// Funciona en el navegador (ethers global) y en Node (ethers importado). Todo con BigInt.

export let CHAIN_ID = 8453n;
export let CHAIN = { key: "base", name: "Base", id: 8453, native: "ETH", blockMs: 2000, publicMempool: false, beefy: "base", morphoApiChainId: 8453,
  aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", rpcs: [] };

export let TOKENS = {
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
};

/** Tokens adicionales de Base para ampliar los pares (se verifican on-chain por símbolo al arrancar; los que no coinciden se descartan). */
export let EXTRA_TOKENS = [
  { sym: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" },
  { sym: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
  { sym: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
  { sym: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" },
  { sym: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" },
  { sym: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
  { sym: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A" },
  { sym: "rETH", address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c" },
  { sym: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
  { sym: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
  { sym: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
  { sym: "BRETT", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
  { sym: "MORPHO", address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842" },
  { sym: "WELL", address: "0xA88594D404727625A9437C3f886C7643872296AE" },
  { sym: "ZRO", address: "0x6985884C4392D348587B19cb9eAAf157F13271cd" },
];

/** Verifica EXTRA_TOKENS on-chain (symbol/decimals) y devuelve solo los que coinciden. */
export async function verifiedExtraTokens(ethers, provider, list = EXTRA_TOKENS) {
  if (!list.length) return [];
  const meta = await tokenMeta(ethers, provider, list.map((t) => t.address));
  const ok = [];
  ok.rejected = [];
  for (const t of list) {
    const m = meta.get(t.address.toLowerCase());
    // `symbols`: símbolos on-chain aceptados además de `sym` (p. ej. USDT renombrado a USDT0 en Polygon/Arbitrum)
    const accepted = [t.sym, ...(t.symbols ?? [])].map((x) => x.toLowerCase());
    if (m && accepted.includes(String(m.sym).toLowerCase())) ok.push({ sym: t.sym, address: ethers.getAddress(t.address), decimals: m.decimals });
    else ok.rejected.push(`${t.sym}${m ? ` (on-chain «${m.sym}»)` : " (sin respuesta)"}`);
  }
  return ok;
}

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export let GAS_ORACLE = "0x420000000000000000000000000000000000000F"; // OP Stack: fee L1 (null en cadenas sin oráculo)

// Factories en Base: las direcciones de pool se obtienen on-chain, no están escritas a mano.
export let FACTORIES = [
  { name: "Uniswap v3", kind: "v3fee", address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", params: [100, 500, 3000, 10000] },
  { name: "PancakeSwap v3", kind: "v3fee", address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", params: [100, 500, 2500, 10000] },
  { name: "Aerodrome Slipstream", kind: "v3tick", address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", params: [1, 50, 100, 200] },
  { name: "Uniswap v2", kind: "v2pair", address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", feeBps: 30 },
  { name: "PancakeSwap v2", kind: "v2pair", address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E", feeBps: 25 },
  { name: "Aerodrome", kind: "aero", address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" },
  // Uniswap v4: singleton. Solo observación (el contrato aún no ejecuta hops v4); pools con hooks se ignoran.
  { name: "Uniswap v4", kind: "v4", address: "0x498581fF718922c3f8e6A244956aF099B2652b2b", stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71", combos: [[100, 1], [500, 10], [3000, 60], [10000, 200]] },
];
export const V4_DYNAMIC_FEE = 0x800000;

// Proveedores de flashloan (punto 2). La liquidez y la comisión se leen on-chain.
export let LENDERS = [
  { name: "Morpho Blue", kind: "balance", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", feeBps: 0n },
  { name: "Balancer v3", kind: "balance", address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", feeBps: 0n },
  { name: "Aave v3", kind: "aave", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", feeBps: null },
];

/**
 * Activa una cadena: sustituye tokens, factories, prestamistas y oráculo por los de `cfg` (ver chains.js).
 * Los importadores que usan `core.X` ven el cambio al instante (enlaces vivos de ESM).
 */
export let EXCLUDED_PAIRS = new Set(); // pares excluidos (ver src/pairs.js y excludedPairs en chains.js)
export function applyChain(cfg) {
  EXCLUDED_PAIRS = excludedSet(cfg.excludedPairs ?? []);
  CHAIN = { key: cfg.key, name: cfg.name, id: cfg.id, native: cfg.native, blockMs: cfg.blockMs ?? 2000, publicMempool: !!cfg.publicMempool, beefy: cfg.beefy, morphoApiChainId: cfg.morphoApiChainId ?? null, aavePool: cfg.aavePool ?? null, morpho: cfg.morpho ?? null, fastRpc: cfg.fastRpc, fastMs: cfg.fastMs ?? 250, rpcs: cfg.rpcs ?? [] };
  CHAIN_ID = BigInt(cfg.id);
  TOKENS = Object.fromEntries(Object.entries(cfg.tokens).map(([k, t]) => [k, { address: t.address, decimals: t.decimals, label: t.label ?? k }]));
  EXTRA_TOKENS = (cfg.extraTokens ?? []).map((t) => ({ ...t }));
  FACTORIES = cfg.factories.map((f) => ({ ...f }));
  LENDERS = cfg.lenders.map((l) => ({ ...l }));
  GAS_ORACLE = cfg.l1GasOracle ?? null;
}

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
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function tickBitmap(int16) view returns (uint256)",
  "function ticks(int24) view returns (uint128,int128)",
  "function getTickBitmap(bytes32,int16) view returns (uint256)",
  "function getTickLiquidity(bytes32,int24) view returns (uint128,int128)",
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  "event AeroPoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)",
  "event CLPoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
];

export function makeIface(ethers) {
  return new ethers.Interface(ABI);
}

// ------------------------------------------------------------------ Multicall

export const MULTICALL_CHUNK = 200;
export async function multicall(ethers, provider, calls, blockTag = "latest", { parallel = 4 } = {}) {
  const iface = makeIface(ethers);
  const chunks = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) chunks.push(calls.slice(i, i + MULTICALL_CHUNK));
  const one = async (chunk) => {
    const part = chunk.map((c) => ({ target: c[0], allowFailure: true, callData: c[1] }));
    const data = iface.encodeFunctionData("aggregate3", [part]);
    const raw = await provider.call({ to: MULTICALL3, data, blockTag });
    const [res] = iface.decodeFunctionResult("aggregate3", raw);
    return res.map((r) => (r.success && r.returnData !== "0x" ? r.returnData : null));
  };
  // los tramos se piden en paralelo (hasta `parallel` a la vez): una lectura de ~800 llamadas tarda lo que una ida y vuelta
  const out = [];
  for (let i = 0; i < chunks.length; i += parallel) {
    const parts = await Promise.all(chunks.slice(i, i + parallel).map(one));
    for (const p of parts) out.push(...p);
  }
  return out;
}

const enc = (iface, sig, args = []) => iface.encodeFunctionData(sig, args);
const dec = (iface, sig, raw) => (raw ? iface.decodeFunctionResult(sig, raw) : null);
const word = (raw, i) => BigInt("0x" + raw.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const ZERO = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------ Descubrimiento

export function v4PoolId(ethers, a, b, fee, tickSpacing, hooks = ZERO) {
  const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [t0, t1, fee, tickSpacing, hooks]));
}

/** Pools YA existentes entre cada par de `tokenAddrs`, preguntando a los getters de cada factory. */
export async function existingPools(ethers, provider, tokenAddrs, factories = FACTORIES, explicitPairs = null) {
  const iface = makeIface(ethers);
  const list = [...new Set(tokenAddrs.map((a) => ethers.getAddress(a)))];
  const pairs = explicitPairs ?? [];
  if (!explicitPairs) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);

  const calls = [], meta = [];
  for (const f of factories) {
    for (const [a, b] of pairs) {
      if (f.kind === "v3fee" || f.kind === "v3tick") {
        const sig = f.kind === "v3fee" ? "getPool(address,address,uint24)" : "getPool(address,address,int24)";
        for (const p of f.params) { calls.push([f.address, enc(iface, sig, [a, b, p])]); meta.push({ dex: f.name, kind: "v3" }); }
      } else if (f.kind === "v2pair") {
        calls.push([f.address, enc(iface, "getPair", [a, b])]); meta.push({ dex: f.name, kind: "v2", feeBps: f.feeBps, pairFee: f.pairFee });
      } else if (f.kind === "aero") {
        calls.push([f.address, enc(iface, "getPool(address,address,bool)", [a, b, false])]);
        meta.push({ dex: f.name + " (volátil)", kind: "v2", aeroFactory: f.address });
      } else if (f.kind === "v4") {
        for (const [fee, ts] of f.combos) {
          const id = v4PoolId(ethers, a, b, fee, ts);
          calls.push([f.stateView, enc(iface, "getSlot0", [id])]);
          const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
          meta.push({ dex: f.name, kind: "v4", id, feeBps: fee / 100, tickSpacing: ts, token0: t0, token1: t1, stateView: f.stateView, manager: f.address });
        }
        // pools con ETH nativo (currency0 = address(0)): en v4 son los más profundos. En el modelo el lado nativo es WETH
        // (el contrato envuelve/desenvuelve dentro del salto); token0 = WETH porque address(0) siempre es currency0.
        const W = TOKENS.WETH?.address;
        if (W && (a.toLowerCase() === W.toLowerCase() || b.toLowerCase() === W.toLowerCase())) {
          const other = a.toLowerCase() === W.toLowerCase() ? b : a;
          for (const [fee, ts] of f.combos) {
            const id = v4PoolId(ethers, ZERO, other, fee, ts);
            calls.push([f.stateView, enc(iface, "getSlot0", [id])]);
            meta.push({ dex: f.name + " (ETH nativo)", kind: "v4", id, feeBps: fee / 100, tickSpacing: ts, token0: W, token1: other, native: true, stateView: f.stateView, manager: f.address });
          }
        }
      }
    }
  }
  const res = await multicall(ethers, provider, calls);
  const found = new Map();
  res.forEach((raw, i) => {
    if (!raw) return;
    const m = meta[i];
    if (m.kind === "v4") {
      if (word(raw, 0) === 0n) return; // no inicializado
      if (!found.has(m.id)) found.set(m.id, m);
      return;
    }
    const addr = ethers.getAddress("0x" + raw.slice(-40));
    if (addr !== ZERO && !found.has(addr)) found.set(addr, m);
  });
  return found;
}

// compatibilidad con la versión anterior
export const discoverPools = (ethers, provider, tokens = TOKENS, factories = FACTORIES) =>
  existingPools(ethers, provider, Object.values(tokens).map((t) => t.address), factories);

/** Pools NUEVOS: eventos de creación de cada factory en los últimos `lookback` bloques (long tail). */
export async function scanNewPools(ethers, provider, { lookback = 3600, chunk = 1000, head, onProgress, factories = FACTORIES } = {}) {
  const iface = makeIface(ethers);
  head = head ?? (await provider.getBlockNumber());
  const from0 = Math.max(0, head - lookback);
  const topicOf = {
    v2pair: iface.getEvent("PairCreated").topicHash, v3fee: iface.getEvent("PoolCreated").topicHash,
    aero: iface.getEvent("AeroPoolCreated").topicHash, v3tick: iface.getEvent("CLPoolCreated").topicHash, v4: iface.getEvent("Initialize").topicHash,
  };
  const specs = new Map();
  for (const f of factories) {
    let size = chunk;
    for (let from = from0; from <= head; ) {
      const to = Math.min(head, from + size - 1);
      let logs;
      try {
        logs = await provider.getLogs({ address: f.address, topics: [topicOf[f.kind]], fromBlock: from, toBlock: to });
      } catch (e) {
        onProgress?.({ factory: f.name, from, to, head, found: specs.size, error: (e.shortMessage || e.message || "").slice(0, 120), size });
        if (size > 100) { size = Math.max(100, Math.floor(size / 2)); continue; } // el RPC limita el rango: reducir
        onProgress?.({ factory: f.name, from, to, head, found: specs.size, error: "se omite este DEX en esta ventana", size });
        break; // un DEX que el RPC no puede escanear no debe frenar a los demás
      }
      for (const lg of logs) {
        const base = { dex: f.name, createdBlock: lg.blockNumber };
        const t = lg.topics, d = lg.data;
        if (f.kind === "v2pair") {
          specs.set(ethers.getAddress("0x" + d.slice(2 + 24, 2 + 64)), { ...base, kind: "v2", feeBps: f.feeBps, pairFee: f.pairFee });
        } else if (f.kind === "aero") {
          if (BigInt(t[3]) === 1n) continue; // estable: otra curva
          specs.set(ethers.getAddress("0x" + d.slice(2 + 24, 2 + 64)), { ...base, dex: f.name + " (volátil)", kind: "v2", aeroFactory: f.address });
        } else if (f.kind === "v3fee") {
          specs.set(ethers.getAddress("0x" + d.slice(2 + 64 + 24, 2 + 128)), { ...base, kind: "v3", feeBps: Number(BigInt(t[3])) / 100 });
        } else if (f.kind === "v3tick") {
          specs.set(ethers.getAddress("0x" + d.slice(2 + 24, 2 + 64)), { ...base, kind: "v3" });
        } else if (f.kind === "v4") {
          const fee = Number(word(d, 0)), hooks = ethers.getAddress("0x" + d.slice(2 + 128 + 24, 2 + 192));
          const tsRaw = word(d, 1), tickSpacing = Number(tsRaw > 2n ** 255n ? tsRaw - 2n ** 256n : tsRaw);
          const t0 = ethers.getAddress("0x" + t[2].slice(-40)), t1 = ethers.getAddress("0x" + t[3].slice(-40));
          if (hooks !== ZERO || fee & V4_DYNAMIC_FEE) continue; // hooks o fee dinámica
          const native = t0 === ZERO; // ETH nativo: se modela como WETH (el contrato envuelve/desenvuelve)
          if (native && !TOKENS.WETH) continue;
          specs.set(t[1], { ...base, kind: "v4", id: t[1], dex: native ? f.name + " (ETH nativo)" : f.name, feeBps: fee / 100, tickSpacing, token0: native ? TOKENS.WETH.address : t0, token1: t1, native, stateView: f.stateView, manager: f.address });
        }
      }
      onProgress?.({ factory: f.name, from, to, head, found: specs.size });
      from = to + 1;
    }
  }
  return specs;
}

/** symbol() y decimals() de una lista de tokens. Tokens sin decimals() se omiten. */
export async function tokenMeta(ethers, provider, addrs, known = {}) {
  const iface = makeIface(ethers);
  const out = new Map(Object.values(known).map((t) => [t.address.toLowerCase(), { ...t }]));
  const todo = [...new Set(addrs.map((a) => ethers.getAddress(a)))].filter((a) => !out.has(a.toLowerCase()));
  const calls = [];
  for (const a of todo) calls.push([a, enc(iface, "symbol")], [a, enc(iface, "decimals")]);
  const res = await multicall(ethers, provider, calls);
  todo.forEach((a, i) => {
    const symRaw = res[2 * i], decRaw = res[2 * i + 1];
    if (!decRaw) return;
    let sym = a.slice(0, 6) + "…";
    try { sym = symRaw && symRaw.length > 66 ? iface.decodeFunctionResult("symbol", symRaw)[0] : ethers.toUtf8String(symRaw).replace(/\0+$/, ""); } catch { /* símbolo raro */ }
    out.set(a.toLowerCase(), { sym: sym.slice(0, 12) || a.slice(0, 6), address: a, decimals: Number(word(decRaw, 0)) });
  });
  return out;
}

/** token0/token1 de pools EVM (para saber qué tokens nuevos aparecieron). */
export async function poolTokens(ethers, provider, addrs) {
  const iface = makeIface(ethers);
  const calls = [];
  for (const a of addrs) calls.push([a, enc(iface, "token0")], [a, enc(iface, "token1")]);
  const res = await multicall(ethers, provider, calls);
  const out = new Map();
  addrs.forEach((a, i) => {
    const t0 = res[2 * i], t1 = res[2 * i + 1];
    if (t0 && t1) out.set(a, [ethers.getAddress("0x" + t0.slice(-40)), ethers.getAddress("0x" + t1.slice(-40))]);
  });
  return out;
}

/**
 * Universo long tail en etapas, para que sea barato con RPC públicos:
 *  1) pools de los pares principales;
 *  2) pools creados en la ventana (eventos) -> se cargan y se filtran por liquidez de inmediato
 *     (la mayoría son polvo y se descartan aquí);
 *  3) solo para los tokens que sobreviven: sus pools existentes contra WETH/USDC/cbBTC en todos los DEX.
 */
export async function longTailUniverse(ethers, provider, { lookback, head, minLiq, progress = () => {}, extraTokens = [] }) {
  const base = Object.values(TOKENS).map((t) => t.address).concat(extraTokens.map((t) => t.address));
  const baseMeta = () => new Map([...Object.entries(TOKENS).map(([sym, t]) => [t.address.toLowerCase(), { sym, ...t }]), ...extraTokens.map((t) => [t.address.toLowerCase(), { ...t }])]);
  progress(`pares principales (${base.length} tokens)`);
  const found = await existingPools(ethers, provider, base);
  let lastP = 0;
  const specs = await scanNewPools(ethers, provider, {
    lookback, head,
    onProgress: (pr) => {
      if (pr.error) { progress(`getLogs ${pr.factory} (${pr.size} bloques) falló: ${pr.error}`); return; }
      if (Date.now() - lastP > 10000) { lastP = Date.now(); progress(`escaneando ${pr.factory}: ${pr.found} pools nuevos`); }
    },
  });
  progress(`${specs.size} pools nuevos; leyendo sus tokens`);
  const evm = [...specs.entries()].filter(([, m]) => m.kind !== "v4").map(([a]) => a);
  const toks = await poolTokens(ethers, provider, evm);
  const addrs = new Set(base);
  for (const [, m] of specs) if (m.kind === "v4") { addrs.add(m.token0); addrs.add(m.token1); }
  for (const [, [a, b]] of toks) { addrs.add(a); addrs.add(b); }
  const meta = await tokenMeta(ethers, provider, [...addrs], TOKENS);
  for (const [k, v] of baseMeta()) meta.set(k, v);
  progress(`filtrando ${specs.size} pools nuevos por liquidez`);
  const newPools = filterPools(await loadPools(ethers, provider, specs, meta), base.slice(0, 2), minLiq);
  const baseSet = new Set(base.map((a) => a.toLowerCase()));
  const survivors = [...new Set(newPools.flatMap((p) => [p.token0.address, p.token1.address]).filter((a) => !baseSet.has(a.toLowerCase())))];
  progress(`${newPools.length} pools nuevos con liquidez (${survivors.length} tokens); buscando sus otros pools`);
  for (const p of newPools) found.set(p.address, specs.get(p.address));
  for (let i = 0; i < survivors.length; i += 40) {
    const pairs = survivors.slice(i, i + 40).flatMap((t) => base.map((b) => [b, t]));
    const part = await existingPools(ethers, provider, [], FACTORIES, pairs);
    for (const [k, v] of part) if (!found.has(k)) found.set(k, v);
  }
  const keepTok = new Set([...baseSet, ...survivors.map((a) => a.toLowerCase())]);
  const metaList = [...meta.values()].filter((t) => keepTok.has(t.address.toLowerCase()));
  return { foundEntries: [...found.entries()], metaList };
}

// ------------------------------------------------------------------ Carga y refresco de pools

/** found: Map(address|poolId -> spec). tokens: objeto {SYM:{address,decimals}} o Map(addr minúscula -> {sym,address,decimals}). */
export async function loadPools(ethers, provider, found, tokens = TOKENS) {
  const iface = makeIface(ethers);
  const byAddr = tokens instanceof Map ? tokens : new Map(Object.entries(tokens).map(([sym, t]) => [t.address.toLowerCase(), { sym, ...t }]));
  const evm = [...found.entries()].filter(([, m]) => m.kind !== "v4");
  const calls = [];
  for (const [a, m] of evm) {
    calls.push([a, enc(iface, "token0")], [a, enc(iface, "token1")], [a, "0x3850c7bd"] /* slot0() */, [a, enc(iface, "fee")],
      [a, enc(iface, "getReserves")], m.aeroFactory ? [m.aeroFactory, enc(iface, "getFee", [a, false])] : m.pairFee ? [a, ethers.id(m.pairFee + "()").slice(0, 10)] : [MULTICALL3, "0x"],
      [a, enc(iface, "tickSpacing")]);
  }
  const r = await multicall(ethers, provider, calls);
  const pools = [];
  evm.forEach(([a, m], i) => {
    const [t0, t1, s0, fee, res, aeroFee, ts] = r.slice(7 * i, 7 * i + 7);
    if (!t0 || !t1) return;
    const tok0 = byAddr.get(ethers.getAddress("0x" + t0.slice(-40)).toLowerCase());
    const tok1 = byAddr.get(ethers.getAddress("0x" + t1.slice(-40)).toLowerCase());
    if (!tok0 || !tok1) return;
    const p = { address: a, dex: m.dex, kind: m.kind ?? (s0 && fee ? "v3" : "v2"), token0: tok0, token1: tok1, reserve0: 0n, reserve1: 0n, createdBlock: m.createdBlock ?? 0 };
    if (p.kind === "v3") {
      if (!s0 || !fee) return;
      p.feePips = word(fee, 0);
      p.feeBps = Number(p.feePips) / 100;
      p.tickSpacing = ts ? Number(BigInt.asIntN(24, word(ts, 0))) : 0;
      p.ticks = null; // tabla de ticks cercanos (refreshTicks)
    } else {
      if (!res) return;
      let bps = m.feeBps ?? m.feeHint ?? 30;
      if (m.aeroFactory && aeroFee && aeroFee !== "0x") bps = Number(word(aeroFee, 0)); // Aerodrome: bps directos
      else if (m.pairFee && aeroFee && aeroFee !== "0x") bps = Number(word(aeroFee, 0)) * 10; // Biswap: comisión por par en milésimas
      p.feeBps = bps;
      p.feePips = BigInt(Math.round(bps * 100));
    }
    pools.push(p);
  });
  for (const [id, m] of found) {
    if (m.kind !== "v4") continue;
    const tok0 = byAddr.get(m.token0.toLowerCase()), tok1 = byAddr.get(m.token1.toLowerCase());
    if (!tok0 || !tok1) continue;
    pools.push({ address: id, dex: m.dex, kind: "v4", token0: tok0, token1: tok1, reserve0: 0n, reserve1: 0n, feeBps: m.feeBps,
      feePips: BigInt(Math.round(m.feeBps * 100)), tickSpacing: m.tickSpacing ?? 0, stateView: m.stateView, manager: m.manager, native: !!m.native, createdBlock: m.createdBlock ?? 0 });
  }
  await refreshPools(ethers, provider, pools);
  return pools;
}

const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
export async function refreshPools(ethers, provider, pools, blockTag = "latest") {
  const iface = makeIface(ethers);
  const calls = [];
  for (const p of pools) {
    if (p.kind === "v3") calls.push([p.address, "0x3850c7bd"], [p.address, enc(iface, "liquidity")]);
    else if (p.kind === "v4") calls.push([p.stateView, enc(iface, "getSlot0", [p.address])], [p.stateView, enc(iface, "getLiquidity", [p.address])]);
    else calls.push([p.address, enc(iface, "getReserves")]);
  }
  const r = await multicall(ethers, provider, calls, blockTag);
  let k = 0;
  for (const p of pools) {
    if (p.kind === "v3" || p.kind === "v4") {
      const s0 = r[k++], liq = r[k++];
      if (!s0 || !liq) { p.reserve0 = p.reserve1 = 0n; continue; }
      p.sqrtPriceX96 = word(s0, 0);
      p.tick = Number(BigInt.asIntN(24, word(s0, 1)));
      p.liquidity = word(liq, 0);
      // Pool en el extremo del rango de precios (tick mínimo/máximo): el swap on-chain revierte con SPL y
      // la liquidez virtual no significa nada. Se trata como sin liquidez.
      if (p.sqrtPriceX96 <= MIN_SQRT_RATIO * 4n || p.sqrtPriceX96 >= MAX_SQRT_RATIO / 4n) { p.reserve0 = p.reserve1 = 0n; continue; }
      [p.reserve0, p.reserve1] = v3VirtualReserves(p.sqrtPriceX96, p.liquidity);
    } else {
      const res = r[k++];
      if (!res) { p.reserve0 = p.reserve1 = 0n; continue; }
      p.reserve0 = word(res, 0);
      p.reserve1 = word(res, 1);
    }
  }
}

/**
 * Tabla de ticks inicializados alrededor del precio para pools v3/v4 (bitmap ± `words` palabras, hasta `maxTicks`
 * por lado). Con ella `swapOut` simula el cruce de ticks exactamente como el contrato del pool.
 */
export async function refreshTicks(ethers, provider, pools, { words = 2, maxTicks = 40, blockTag = "latest" } = {}) {
  const iface = makeIface(ethers);
  const cl = pools.filter((p) => (p.kind === "v3" || p.kind === "v4") && p.tickSpacing > 0 && p.tick !== undefined && p.reserve0 > 0n);
  if (!cl.length) return 0;
  const calls = [];
  for (const p of cl) {
    const w0 = CL.wordPosOf(p.tick, p.tickSpacing);
    for (let w = w0 - words; w <= w0 + words; w++) {
      calls.push(p.kind === "v4" ? [p.stateView, enc(iface, "getTickBitmap", [p.address, w])] : [p.address, enc(iface, "tickBitmap", [w])]);
    }
  }
  const bm = await multicall(ethers, provider, calls, blockTag);
  const n = 2 * words + 1;
  const wanted = []; // [pool, tick]
  cl.forEach((p, i) => {
    const w0 = CL.wordPosOf(p.tick, p.tickSpacing);
    let ticks = [];
    for (let j = 0; j < n; j++) { const raw = bm[i * n + j]; if (raw) ticks.push(...CL.ticksFromBitmapWord(w0 - words + j, word(raw, 0), p.tickSpacing)); }
    ticks.sort((a, b) => a - b);
    const below = ticks.filter((t) => t <= p.tick).slice(-maxTicks), above = ticks.filter((t) => t > p.tick).slice(0, maxTicks);
    p._tickList = below.concat(above);
    for (const t of p._tickList) wanted.push([p, t]);
  });
  const calls2 = wanted.map(([p, t]) => (p.kind === "v4" ? [p.stateView, enc(iface, "getTickLiquidity", [p.address, t])] : [p.address, enc(iface, "ticks", [t])]));
  const tl = calls2.length ? await multicall(ethers, provider, calls2, blockTag) : [];
  const byPool = new Map();
  wanted.forEach(([p, t], k) => {
    const raw = tl[k];
    if (!raw) return;
    const net = BigInt.asIntN(128, word(raw, 1));
    (byPool.get(p) ?? byPool.set(p, []).get(p)).push({ tick: t, liquidityNet: net });
  });
  for (const p of cl) { p.ticks = (byPool.get(p) ?? []).sort((a, b) => a.tick - b.tick); p.ticksRange = p._tickList.length ? [p._tickList[0], p._tickList[p._tickList.length - 1]] : null; delete p._tickList; }
  return cl.length;
}

/** Filtro del punto 1: liquidez mínima del token base en el pool; pools token-token solo si ambos tokens ya tienen un pool base aceptable. */
export function filterPools(pools, baseAddrs, minLiq) {
  const base = new Set(baseAddrs.map((a) => a.toLowerCase()));
  const good = new Set(base);
  const kept = [];
  for (const p of pools) {
    if (p.reserve0 === 0n || p.reserve1 === 0n) continue;
    for (const t of [p.token0, p.token1]) {
      const key = t.address.toLowerCase();
      if (base.has(key) && reservesFor(p, t.address)[0] >= (minLiq[key] ?? 0n)) { kept.push(p); good.add(other(p, t.address).address.toLowerCase()); break; }
    }
  }
  for (const p of pools) {
    if (kept.includes(p) || p.reserve0 === 0n || p.reserve1 === 0n) continue;
    if (good.has(p.token0.address.toLowerCase()) && good.has(p.token1.address.toLowerCase())) kept.push(p);
  }
  return kept;
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

/** Salida de un pool para `amountIn` de `tokenIn`: exacta con cruce de ticks si el pool tiene tabla de ticks. */
export function swapOut(p, tokenIn, amountIn) {
  if (amountIn <= 0n) return 0n;
  if ((p.kind === "v3" || p.kind === "v4") && p.ticks && p.liquidity !== undefined) {
    if (p.liquidity === 0n && !p.ticks.length) return 0n;
    const r = CL.swapExactIn({ sqrtPriceX96: p.sqrtPriceX96, tick: p.tick, liquidity: p.liquidity, feePips: p.feePips, tickSpacing: p.tickSpacing, ticks: p.ticks }, tokenIn === p.token0.address, amountIn);
    return r.amountOut; // si se agotó la tabla, es un piso (conservador)
  }
  const [ri, ro] = reservesFor(p, tokenIn);
  return amountOut(amountIn, ri, ro, p.feePips);
}

export function routeOut(x, start, route) {
  let t = start, a = x;
  for (const p of route) {
    a = swapOut(p, t, a);
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

export function enumerateCycles(pools, startSyms = ["WETH", "USDC"], maxHops = 3, maxCycles = 15000) {
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
  // liquidez aproximada de un ciclo: la menor reserva del token de inicio (en sus unidades) entre sus pools de entrada/salida
  const liqOf = (c) => { const a = reservesFor(c.route[0], c.start)[0], b = reservesFor(c.route[c.route.length - 1], c.start)[0]; return a < b ? a : b; };
  const addrOf = new Map();
  for (const p of pools) for (const t of [p.token0, p.token1]) addrOf.set(t.sym, t.address);
  for (const sym of startSyms) {
    const s = addrOf.get(sym) ?? TOKENS[sym]?.address;
    if (!s) continue;
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
  if (out.length > maxCycles) {
    // demasiados ciclos: se conservan todos los de 2 saltos y los de 3 saltos con más liquidez
    const two = out.filter((c) => c.route.length === 2), three = out.filter((c) => c.route.length === 3);
    three.sort((x, y) => (liqOf(y) > liqOf(x) ? 1 : liqOf(y) < liqOf(x) ? -1 : 0));
    return two.concat(three.slice(0, Math.max(0, maxCycles - two.length)));
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

export const MIN_PRIORITY_WEI = 1_000_000n; // 0.001 gwei
export async function readGas(ethers, provider) {
  const iface = makeIface(ethers);
  const [block, prio] = await Promise.all([
    provider.getBlock("latest"),
    provider.send("eth_maxPriorityFeePerGas", []).catch(() => "0x0"),
  ]);
  let l1Fee = 0n;
  if (GAS_ORACLE) try {
    const dummy = "0x" + "ab".repeat(CALLDATA_BYTES);
    const raw = await provider.call({ to: GAS_ORACLE, data: enc(iface, "getL1Fee", [dummy]) });
    l1Fee = BigInt(raw);
  } catch { /* cadena sin oráculo L1 (p. ej. local) */ }
  return {
    number: block.number,
    timestamp: block.timestamp,
    baseFee: block.baseFeePerGas ?? 0n,
    priority: BigInt(prio) > MIN_PRIORITY_WEI ? BigInt(prio) : MIN_PRIORITY_WEI, // piso: el secuenciador no incluye tx con propina 0
    l1Fee,
  };
}

// ------------------------------------------------------------------ Evaluación (pipeline completo)

// ------------------------------------------------------------------ Dimensionamiento (monto óptimo con restricción de flashloan)

function ternaryMax(f, lo, hi) {
  if (hi < lo) return [0n, 0n];
  // 1) barrido geométrico (la curva es cóncava en log-monto): 24 puntos entre lo y hi
  if (hi > lo * 16n) {
    const N = 16, ratio = Number(hi) / Number(lo);
    let bi = 0, bv = -(1n << 255n);
    const xs = [];
    for (let i = 0; i <= N; i++) { const x = BigInt(Math.max(1, Math.floor(Number(lo) * Math.pow(ratio, i / N)))); xs.push(x); const v = f(x); if (v > bv) { bv = v; bi = i; } }
    lo = xs[Math.max(0, bi - 1)]; hi = xs[Math.min(N, bi + 1)];
  }
  // 2) ternaria en el tramo acotado
  for (let i = 0; i < 40 && hi - lo > 2n; i++) {
    const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
    if (f(m1) < f(m2)) lo = m1; else hi = m2;
  }
  let bx = 0n, bv = 0n;
  for (const x of hi - lo <= 2n ? [lo, lo + 1n, hi] : [lo, (lo + hi) / 2n, hi]) {
    const v = f(x);
    if (v > bv) { bv = v; bx = x; }
  }
  return [bx, bv];
}

// Segmentos de préstamo: [hasta cuánto se puede pedir, a qué costo]. Primero gratuitos.
export function lenderSegments(lenders, sym) {
  const segs = [];
  const free = lenders.filter((l) => l.ok && l.feeBps === 0n && (l.liquidity[sym] ?? 0n) > 0n)
    .sort((a, b) => (b.liquidity[sym] > a.liquidity[sym] ? 1 : -1));
  if (free.length) segs.push({ name: free[0].name, max: free[0].liquidity[sym], bps: 0n });
  for (const l of lenders) {
    if (l.ok && l.feeBps !== null && l.feeBps > 0n && (l.liquidity[sym] ?? 0n) > 0n)
      segs.push({ name: l.name, max: l.liquidity[sym], bps: l.feeBps });
  }
  return segs;
}

// Para un monto x: qué proveedor se usa y cuánto cobra (null si nadie tiene tanta liquidez)
export function lenderFor(segs, x) {
  const fits = segs.filter((g) => g.max >= x).sort((a, b) => (a.bps < b.bps ? -1 : a.bps > b.bps ? 1 : 0));
  if (!fits.length) return null;
  return { name: fits[0].name, fee: (x * fits[0].bps) / 10000n, bps: fits[0].bps };
}

// Óptimo de beneficio en token: max_x  out(x) - x - comisión_flash(x), con x <= cap y <= liquidez del proveedor
export function optimize(start, route, segs, cap) {
  let best = { x: 0n, gross: 0n, fee: 0n, lender: null };
  for (const g of segs) {
    const hi = g.max < cap ? g.max : cap;
    const f = (x) => routeOut(x, start, route) - x - (x * g.bps) / 10000n;
    const [x, v] = ternaryMax(f, 1n, hi);
    const fee = (x * g.bps) / 10000n;
    if (x > 0n && v > best.gross - best.fee) best = { x, gross: v + fee, fee, lender: g.name };
  }
  return best;
}

// Curva de beneficio vs monto prestado (escala logarítmica), para la gráfica de dimensionamiento
export function profitCurve(start, route, segs, loX, hiX, toUsd, gasUsd, n = 90) {
  const pts = [];
  if (hiX <= 1n) return pts;
  const hi = Number(hiX), lo = Math.max(1, Math.min(Number(loX), hi / 10));
  for (let i = 0; i <= n; i++) {
    const x = BigInt(Math.max(1, Math.floor(lo * Math.pow(hi / lo, i / n))));
    const out = routeOut(x, start, route);
    const gross = out - x;
    const l = lenderFor(segs, x);
    const fee = l ? l.fee : 0n;
    pts.push({
      x, xUsd: toUsd(x), outUsd: toUsd(out), grossUsd: toUsd(gross), feeUsd: toUsd(fee), gasUsd,
      netUsd: toUsd(gross - fee) - gasUsd, lender: l ? l.name : "sin liquidez", ok: !!l,
    });
  }
  return pts;
}

export function tokenToUsd(tok, ethUsd) {
  return (amt) => {
    const units = Number(amt) / 10 ** tok.decimals;
    return tok.sym === "USDC" ? units : tok.sym === "WETH" ? units * ethUsd : NaN;
  };
}

// Escenario: aplica un swap hipotético a una copia de los pools (para ver cómo nace una oportunidad)
export function withSwap(pools, poolAddr, tokenAddr, amountIn) {
  const copy = pools.map((p) => ({ ...p }));
  const p = copy.find((q) => q.address === poolAddr);
  if (!p || amountIn <= 0n) return copy;
  const [ri, ro] = reservesFor(p, tokenAddr);
  const out = swapOut(p, tokenAddr, amountIn);
  p.ticks = null; // tras un swap hipotético el estado de ticks ya no es válido: vuelve a reservas virtuales
  if (tokenAddr === p.token0.address) { p.reserve0 = ri + amountIn; p.reserve1 = ro - out; }
  else { p.reserve1 = ri + amountIn; p.reserve0 = ro - out; }
  return copy;
}

// ------------------------------------------------------------------ Evaluación (pipeline completo)

export function evaluateAll({ pools, cycles, lenders, gas, ethUsd, minNetUsd = 0, maxOptimize = 150 }) {
  const results = [];
  const gasWeiFor = (hops) => (GAS_BASE + GAS_PER_HOP * BigInt(hops)) * (gas.baseFee + gas.priority) + gas.l1Fee;
  // 1) sondeo marginal de todos los ciclos (barato); 2) optimización solo de los positivos, los mejores primero
  const pre = [];
  for (const c of cycles) {
    const startTok = c.route[0].token0.address === c.start ? c.route[0].token0 : c.route[0].token1;
    if (c.route.some((p) => p.reserve0 === 0n || p.reserve1 === 0n)) continue;
    const firstRes = reservesFor(c.route[0], c.start)[0];
    const probe = firstRes / 1000000n || 1n;
    const marginalBps = Number(((routeOut(probe, c.start, c.route) - probe) * 1000000n) / probe) / 100;
    pre.push({ c, startTok, firstRes, marginalBps });
  }
  const order = pre.filter((x) => x.marginalBps > 0).sort((a, b) => b.marginalBps - a.marginalBps);
  const toOptimize = new Set(order.slice(0, maxOptimize).map((x) => x.c));
  for (const { c, startTok, firstRes, marginalBps } of pre) {
    const cap = firstRes / 2n; // tope de búsqueda; el óptimo real queda muy por debajo por el deslizamiento
    const segs = lenderSegments(lenders, startTok.sym);
    const toUsd = tokenToUsd(startTok, ethUsd);
    const gasUsd = (Number(gasWeiFor(c.route.length)) / 1e18) * ethUsd;
    // si una operación mínima ya pierde, ningún monto gana (la curva es cóncava): no hace falta optimizar
    let o = toOptimize.has(c) ? optimize(c.start, c.route, segs, cap) : { x: 0n, gross: 0n, fee: 0n, lender: null };
    // Filtro de cordura: un ciclo real entre pools públicos no devuelve más de un 10% del monto.
    // Más que eso = pool con liquidez virtual absurda, token trampa o reservas falsas -> se descarta.
    let suspicious = false;
    if (o.x > 0n && o.gross * 10n > o.x) { suspicious = true; o = { x: 0n, gross: 0n, fee: 0n, lender: null }; }
    const grossUsd = o.x > 0n ? toUsd(o.gross) : 0;
    const flashFeeUsd = o.x > 0n ? toUsd(o.fee) : 0;
    const netUsd = grossUsd - flashFeeUsd - gasUsd;
    results.push({
      key: c.key, start: startTok.sym, startTok, route: c.route, hops: c.route.length,
      marginalBps, feesBps: c.route.reduce((s, p) => s + p.feeBps, 0),
      amountIn: o.x, amountInUsd: o.x > 0n ? toUsd(o.x) : 0,
      grossUsd, gasUsd, flashFeeUsd,
      lender: o.lender ?? (segs.length ? "—" : "sin liquidez"),
      netUsd, profitable: o.x > 0n && netUsd > minNetUsd, cap, segs,
      needsV4: c.route.some((p) => p.kind === "v4"),
      suspicious,
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

// ------------------------------------------------------------------ Vaults, rebalanceos y zaps (punto 6)
//
// Detección 100% on-chain, sin depender de la API de ningún protocolo:
//  - un REBALANCEO es una transacción en la que el mismo dueño quema (Burn) y vuelve a abrir (Mint)
//    posiciones en un pool concentrado, normalmente con un Swap en medio (Gamma, Beefy CLM, ICHI, Steer);
//  - un ZAP es una transacción con Swap + Mint en el mismo pool (Beefy Zap, zaps de los DEX);
//  - una SALIDA grande es Burn + Swap (retiro de vault que vende una pata).
// Los "managers" (dueños de posiciones que rebalancean) se identifican y se etiquetan leyendo su symbol()
// o el de su vault(); si exponen callReward() son estrategias de Beefy y se evalúa su harvest.

const VAULT_ABI = [
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event MintV2(address indexed sender, uint256 amount0, uint256 amount1)",
  "event BurnV2(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
  "event SwapV2(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "function symbol() view returns (string)",
  "function vault() view returns (address)",
  "function callReward() view returns (uint256)",
  "function lastHarvest() view returns (uint256)",
  "function harvestOnDeposit() view returns (bool)",
];
let vaultIface = null;
const vIface = (ethers) => (vaultIface ??= new ethers.Interface(VAULT_ABI));

export const VAULT_TOPICS = (ethers) => {
  const i = vIface(ethers);
  const t = (sig) => "0x" + ethers.keccak256(ethers.toUtf8Bytes(sig)).slice(2);
  return {
    mint: t("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
    burn: t("Burn(address,int24,int24,uint128,uint256,uint256)"),
    swap: t("Swap(address,address,int256,int256,uint160,uint128,int24)"),
    swapPcs: t("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
    mintV2: t("Mint(address,uint256,uint256)"),
    burnV2: t("Burn(address,uint256,uint256,address)"),
    swapV2: t("Swap(address,uint256,uint256,uint256,uint256,address)"),
    _i: i,
  };
};

/** Lee los eventos de un bloque sobre los pools vigilados y los clasifica por transacción. */
export async function scanVaultEvents(ethers, provider, pools, block) {
  const T = VAULT_TOPICS(ethers);
  const byAddr = new Map(pools.filter((p) => p.kind !== "v4").map((p) => [p.address.toLowerCase(), p]));
  const addrs = [...byAddr.keys()];
  if (!addrs.length) return [];
  const logs = [];
  for (let i = 0; i < addrs.length; i += 400) {
    logs.push(...(await provider.getLogs({ address: addrs.slice(i, i + 400), fromBlock: block, toBlock: block,
      topics: [[T.mint, T.burn, T.swap, T.swapPcs, T.mintV2, T.burnV2, T.swapV2]] })));
  }
  const addr20 = (topic) => ethers.getAddress("0x" + topic.slice(-40));
  const txs = new Map(); // txHash|pool -> {pool, mints, burns, swaps, owners}
  for (const lg of logs) {
    const p = byAddr.get(lg.address.toLowerCase());
    if (!p) continue;
    const key = lg.transactionHash + "|" + p.address;
    const e = txs.get(key) ?? { tx: lg.transactionHash, pool: p, mints: [], burns: [], swaps: [], owners: new Set(), senders: new Set(), swapOut: 0n, swapOutTok: null };
    txs.set(key, e);
    const t0 = lg.topics[0];
    if (t0 === T.mint) {
      const owner = addr20(lg.topics[1]);
      const [, a0, a1] = [0, word(lg.data, 2), word(lg.data, 3)];
      e.mints.push({ owner, amount0: a0, amount1: a1 }); e.owners.add(owner);
    } else if (t0 === T.burn) {
      const owner = addr20(lg.topics[1]);
      e.burns.push({ owner, amount0: word(lg.data, 1), amount1: word(lg.data, 2) }); e.owners.add(owner);
    } else if (t0 === T.swap || t0 === T.swapPcs) {
      const sender = addr20(lg.topics[1]);
      const a0 = BigInt.asIntN(256, word(lg.data, 0)), a1 = BigInt.asIntN(256, word(lg.data, 1));
      e.swaps.push({ sender, amount0: a0, amount1: a1 }); e.senders.add(sender);
    } else if (t0 === T.mintV2) {
      const sender = addr20(lg.topics[1]);
      e.mints.push({ owner: sender, amount0: word(lg.data, 0), amount1: word(lg.data, 1) }); e.owners.add(sender);
    } else if (t0 === T.burnV2) {
      const sender = addr20(lg.topics[1]);
      e.burns.push({ owner: sender, amount0: word(lg.data, 0), amount1: word(lg.data, 1) }); e.owners.add(sender);
    } else if (t0 === T.swapV2) {
      const sender = addr20(lg.topics[1]);
      const in0 = word(lg.data, 0), in1 = word(lg.data, 1), out0 = word(lg.data, 2), out1 = word(lg.data, 3);
      e.swaps.push({ sender, amount0: in0 - out0, amount1: in1 - out1 }); e.senders.add(sender);
    }
  }
  const events = [];
  for (const e of txs.values()) {
    const both = [...e.owners].filter((o) => e.burns.some((b) => b.owner === o) && e.mints.some((m) => m.owner === o));
    let kind = null, actor = null;
    if (both.length) { kind = "rebalanceo"; actor = both[0]; }
    else if (e.swaps.length && e.mints.length) { kind = "zap"; actor = e.mints[0].owner; }
    else if (e.swaps.length && e.burns.length) { kind = "salida"; actor = e.burns[0].owner; }
    if (!kind) continue;
    // tamaño de la venta que movió el precio: suma de las patas vendidas en los swaps del actor (o de cualquiera en zaps)
    let sold0 = 0n, sold1 = 0n;
    for (const s of e.swaps) { if (s.amount0 > 0n) sold0 += s.amount0; if (s.amount1 > 0n) sold1 += s.amount1; }
    events.push({ block, tx: e.tx, pool: e.pool, kind, actor, sold0, sold1, nMints: e.mints.length, nBurns: e.burns.length, nSwaps: e.swaps.length });
  }
  return events;
}

/** Etiqueta a un manager: symbol() propio o del vault(); detecta estrategias de Beefy por callReward(). */
export async function describeManagers(ethers, provider, addrs, known = new Map()) {
  const i = vIface(ethers);
  const todo = addrs.filter((a) => !known.has(a));
  if (!todo.length) return known;
  const calls = [];
  for (const a of todo) calls.push([a, i.encodeFunctionData("symbol")], [a, i.encodeFunctionData("vault")], [a, i.encodeFunctionData("callReward")], [a, i.encodeFunctionData("lastHarvest")]);
  const res = await multicall(ethers, provider, calls);
  const vaultSyms = [];
  todo.forEach((a, k) => {
    const [sym, vault, cr, lh] = res.slice(4 * k, 4 * k + 4);
    const m = { address: a, label: null, vault: null, beefy: false, callReward: null, lastHarvest: null };
    try { if (sym && sym.length > 66) m.label = i.decodeFunctionResult("symbol", sym)[0]; } catch { /* no es ERC20 */ }
    if (vault && vault.length >= 66) { const v = ethers.getAddress("0x" + vault.slice(-40)); if (v !== ZERO) { m.vault = v; vaultSyms.push(m); } }
    if (cr) { m.beefy = true; m.callReward = word(cr, 0); }
    if (lh) m.lastHarvest = Number(word(lh, 0));
    known.set(a, m);
  });
  if (vaultSyms.length) {
    const r2 = await multicall(ethers, provider, vaultSyms.map((m) => [m.vault, i.encodeFunctionData("symbol")]));
    vaultSyms.forEach((m, k) => { try { if (r2[k] && r2[k].length > 66) m.label = i.decodeFunctionResult("symbol", r2[k])[0]; } catch { /* sin símbolo */ } });
  }
  for (const m of known.values()) {
    if (!m.label) m.label = (m.beefy ? "Estrategia Beefy " : "Manager ") + m.address.slice(0, 8) + "…";
    m.kind = m.beefy ? "Beefy" : /moo|cow|clm/i.test(m.label) ? "Beefy" : /^x?[A-Z]+-[A-Z]+|hype|gamma/i.test(m.label) ? "Gamma" : /ichi|IV-/i.test(m.label) ? "ICHI" : /steer|SSS/i.test(m.label) ? "Steer" : "otro";
  }
  return known;
}

/** Refresca callReward()/lastHarvest() de las estrategias Beefy conocidas. */
export async function refreshHarvest(ethers, provider, managers) {
  const i = vIface(ethers);
  const list = [...managers.values()].filter((m) => m.beefy);
  if (!list.length) return;
  const calls = list.flatMap((m) => [[m.address, i.encodeFunctionData("callReward")], [m.address, i.encodeFunctionData("lastHarvest")]]);
  const res = await multicall(ethers, provider, calls);
  list.forEach((m, k) => { if (res[2 * k]) m.callReward = word(res[2 * k], 0); if (res[2 * k + 1]) m.lastHarvest = Number(word(res[2 * k + 1], 0)); });
}

export const HARVEST_GAS = 2_000_000n; // harvests de posiciones concentradas en Base: ~1.5–2.5M gas
