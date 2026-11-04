// Registro de cadenas. El protocolo es el mismo en todas: lo que cambia son direcciones (tokens, factories, prestamistas),
// nodos y particularidades (mempool público, fee L1 de OP Stack, flashblocks).
//
// Las direcciones se VERIFICAN on-chain al arrancar (código desplegado + llamada de vista): lo que no responde se desactiva
// con aviso en la bitácora, así una dirección equivocada no rompe la cadena entera.
//
// Roles de tokens: WETH = token nativo envuelto (WPOL en Polygon, WBNB en BSC), USDC = dólar de referencia. El modelo
// valora todo contra esos dos; `label` es el símbolo real para mostrar.

const UNI_V3_CANON = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const PANCAKE_V3 = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const AAVE_V3_CANON = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const BALANCER_V3 = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
const SUSHI_V2 = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";
const UNI_FEES = [100, 500, 3000, 10000];
const CAKE_FEES = [100, 500, 2500, 10000];

export const CHAINS = {
  base: {
    key: "base", id: 8453, name: "Base", native: "ETH", beefy: "base", morphoApiChainId: 8453,
    rpcs: ["https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://mainnet.base.org", "https://1rpc.io/base", "https://base.drpc.org"],
    ws: ["wss://base-rpc.publicnode.com", "wss://base.drpc.org", "wss://mainnet.base.org"],
    fastRpc: "https://mainnet.base.org", fastMs: 250, // flashblocks: estado pending cada 200 ms
    publicMempool: false, l1GasOracle: "0x420000000000000000000000000000000000000F", blockMs: 2000,
    tokens: {
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, label: "WETH" },
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, label: "USDC" },
      cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, label: "cbBTC" },
    },
    extraTokens: [
      { sym: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" }, { sym: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
      { sym: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" }, { sym: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" },
      { sym: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" }, { sym: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
      { sym: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A" }, { sym: "rETH", address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c" },
      { sym: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" }, { sym: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
      { sym: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" }, { sym: "BRETT", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
      { sym: "MORPHO", address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842" }, { sym: "WELL", address: "0xA88594D404727625A9437C3f886C7643872296AE" },
      { sym: "ZRO", address: "0x6985884C4392D348587B19cb9eAAf157F13271cd" },
    ],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", params: UNI_FEES },
      { name: "PancakeSwap v3", kind: "v3fee", address: PANCAKE_V3, params: CAKE_FEES },
      { name: "Aerodrome Slipstream", kind: "v3tick", address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", params: [1, 50, 100, 200] },
      { name: "Uniswap v2", kind: "v2pair", address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", feeBps: 30 },
      { name: "PancakeSwap v2", kind: "v2pair", address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E", feeBps: 25 },
      { name: "Aerodrome", kind: "aero", address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" },
      { name: "Uniswap v4", kind: "v4", address: "0x498581fF718922c3f8e6A244956aF099B2652b2b", stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71", combos: [[100, 1], [500, 10], [3000, 60], [10000, 200]] },
    ],
    lenders: [
      { name: "Morpho Blue", kind: "balance", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", feeBps: 0n },
      { name: "Balancer v3", kind: "balance", address: BALANCER_V3, feeBps: 0n },
      { name: "Aave v3", kind: "aave", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", feeBps: null },
    ],
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  },

  polygon: {
    key: "polygon", id: 137, name: "Polygon", native: "POL", beefy: "polygon", morphoApiChainId: 137,
    rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com", "https://1rpc.io/matic", "https://polygon.drpc.org", "https://rpc.ankr.com/polygon"],
    ws: ["wss://polygon-bor-rpc.publicnode.com", "wss://polygon.drpc.org"],
    fastRpc: "https://polygon-bor-rpc.publicnode.com", fastMs: 400,
    publicMempool: true, l1GasOracle: null, blockMs: 2000,
    tokens: {
      WETH: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, label: "WPOL" },
      USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, label: "USDC" },
      ETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, label: "WETH" },
    },
    extraTokens: [
      { sym: "USDC.e", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" }, { sym: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
      { sym: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" }, { sym: "WBTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
      { sym: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39" }, { sym: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B" },
      { sym: "wstETH", address: "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD" }, { sym: "MaticX", address: "0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6" },
    ],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: UNI_V3_CANON, params: UNI_FEES },
      { name: "QuickSwap v2", kind: "v2pair", address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", feeBps: 30 },
      { name: "SushiSwap v2", kind: "v2pair", address: SUSHI_V2, feeBps: 30 },
    ],
    lenders: [
      { name: "Aave v3", kind: "aave", address: AAVE_V3_CANON, feeBps: null },
      { name: "Morpho Blue", kind: "balance", address: "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67", feeBps: 0n },
    ],
    aavePool: AAVE_V3_CANON, morpho: "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67",
  },

  bsc: {
    key: "bsc", id: 56, name: "BNB Chain", native: "BNB", beefy: "bsc", morphoApiChainId: null,
    rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org", "https://1rpc.io/bnb", "https://bsc.drpc.org", "https://binance.llamarpc.com"],
    ws: ["wss://bsc-rpc.publicnode.com", "wss://bsc.drpc.org"],
    fastRpc: "https://bsc-rpc.publicnode.com", fastMs: 300,
    publicMempool: true, l1GasOracle: null, blockMs: 750,
    tokens: {
      WETH: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18, label: "WBNB" },
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, label: "USDC" },
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, label: "USDT" },
    },
    extraTokens: [
      { sym: "ETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" }, { sym: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
      { sym: "CAKE", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" }, { sym: "DAI", address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" },
      { sym: "XRP", address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE" }, { sym: "SOL", address: "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF" },
      { sym: "DOGE", address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43" },
    ],
    factories: [
      { name: "PancakeSwap v3", kind: "v3fee", address: PANCAKE_V3, params: CAKE_FEES },
      { name: "Uniswap v3", kind: "v3fee", address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", params: UNI_FEES },
      { name: "PancakeSwap v2", kind: "v2pair", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", feeBps: 25 },
      { name: "Biswap v2", kind: "v2pair", address: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE", feeBps: 20, pairFee: "swapFee" }, // comisión por par (swapFee/1000)
      { name: "Uniswap v2", kind: "v2pair", address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", feeBps: 30 },
    ],
    lenders: [
      { name: "Aave v3", kind: "aave", address: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", feeBps: null },
    ],
    aavePool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", morpho: null,
  },

  arbitrum: {
    key: "arbitrum", id: 42161, name: "Arbitrum One", native: "ETH", beefy: "arbitrum", morphoApiChainId: 42161,
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc", "https://1rpc.io/arb", "https://arbitrum.drpc.org", "https://arbitrum.llamarpc.com"],
    ws: ["wss://arbitrum-one-rpc.publicnode.com", "wss://arbitrum.drpc.org"],
    fastRpc: "https://arb1.arbitrum.io/rpc", fastMs: 250,
    publicMempool: false, l1GasOracle: null, blockMs: 250, // Timeboost: subasta de prioridad; sin mempool público
    tokens: {
      WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, label: "WETH" },
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, label: "USDC" },
      WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, label: "WBTC" },
    },
    extraTokens: [
      { sym: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" }, { sym: "USDC.e", address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" },
      { sym: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" }, { sym: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548" },
      { sym: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529" }, { sym: "weETH", address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe" },
      { sym: "GMX", address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a" }, { sym: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4" },
      { sym: "PENDLE", address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8" }, { sym: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
    ],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: UNI_V3_CANON, params: UNI_FEES },
      { name: "PancakeSwap v3", kind: "v3fee", address: PANCAKE_V3, params: CAKE_FEES },
      { name: "SushiSwap v2", kind: "v2pair", address: SUSHI_V2, feeBps: 30 },
      { name: "Camelot v2", kind: "v2pair", address: "0x6EcCab422D763aC031210895C81787E87B43A652", feeBps: 30 },
    ],
    lenders: [
      { name: "Aave v3", kind: "aave", address: AAVE_V3_CANON, feeBps: null },
      { name: "Balancer v3", kind: "balance", address: BALANCER_V3, feeBps: 0n },
      { name: "Morpho Blue", kind: "balance", address: "0x6c247b1F6182318877311737BaC0844bAa518F5e", feeBps: 0n },
    ],
    aavePool: AAVE_V3_CANON, morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
  },

  optimism: {
    key: "optimism", id: 10, name: "OP Mainnet", native: "ETH", beefy: "optimism", morphoApiChainId: 10,
    rpcs: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io", "https://1rpc.io/op", "https://optimism.drpc.org", "https://optimism.llamarpc.com"],
    ws: ["wss://optimism-rpc.publicnode.com", "wss://optimism.drpc.org"],
    fastRpc: "https://mainnet.optimism.io", fastMs: 250,
    publicMempool: false, l1GasOracle: "0x420000000000000000000000000000000000000F", blockMs: 2000,
    tokens: {
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, label: "WETH" },
      USDC: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, label: "USDC" },
      WBTC: { address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8, label: "WBTC" },
    },
    extraTokens: [
      { sym: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" }, { sym: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" },
      { sym: "OP", address: "0x4200000000000000000000000000000000000042" }, { sym: "wstETH", address: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb" },
      { sym: "VELO", address: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db" }, { sym: "USDC.e", address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607" },
      { sym: "SNX", address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4" }, { sym: "rETH", address: "0x9Bcef72be871e61ED4fBbc7630889beE758eb81D" },
    ],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: UNI_V3_CANON, params: UNI_FEES },
      { name: "Velodrome Slipstream", kind: "v3tick", address: "0xCc0bDDB707055e04e09910ed7D0E70C7D6aD4Ba1", params: [1, 50, 100, 200] },
      { name: "Velodrome v2", kind: "aero", address: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a" },
      { name: "SushiSwap v2", kind: "v2pair", address: "0xFbc12984689e5f15626Bad03Ad60160Fe98B303C", feeBps: 30 },
    ],
    lenders: [
      { name: "Aave v3", kind: "aave", address: AAVE_V3_CANON, feeBps: null },
      { name: "Balancer v3", kind: "balance", address: BALANCER_V3, feeBps: 0n },
      { name: "Morpho Blue", kind: "balance", address: "0xce95AfbB8EA029495c66020883F87aaE8864AF92", feeBps: 0n },
    ],
    aavePool: AAVE_V3_CANON, morpho: "0xce95AfbB8EA029495c66020883F87aaE8864AF92",
  },
};

export function chainByKey(key) {
  const c = CHAINS[String(key || "base").toLowerCase()];
  if (!c) throw new Error(`cadena desconocida: ${key} (disponibles: ${Object.keys(CHAINS).join(", ")})`);
  return c;
}

/**
 * Comprueba on-chain que cada dirección configurada existe y responde (código desplegado + una llamada de vista).
 * Devuelve una copia de la configuración solo con lo verificado y la lista de lo desactivado.
 */
export async function verifyChain(ethers, provider, cfg) {
  const out = { ...cfg, tokens: {}, extraTokens: [], factories: [], lenders: [] };
  const disabled = [];
  const hasCode = async (a) => { try { return (await provider.getCode(a)) !== "0x"; } catch { return false; } };
  const erc = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
  for (const [role, t] of Object.entries(cfg.tokens)) {
    try {
      const c = new ethers.Contract(t.address, erc, provider);
      const [sym, dec] = await Promise.all([c.symbol(), c.decimals()]);
      if (Number(dec) !== t.decimals) throw new Error(`decimales ${dec} ≠ ${t.decimals}`);
      out.tokens[role] = { ...t, label: t.label ?? sym, onchainSymbol: sym };
    } catch (e) { disabled.push(`token ${role} ${t.address}: ${e.shortMessage || e.message}`); }
  }
  if (!out.tokens.WETH || !out.tokens.USDC) throw new Error(`cadena ${cfg.name}: faltan los tokens de referencia (${disabled.join("; ")})`);
  out.extraTokens = cfg.extraTokens ?? []; // estos ya se verifican por símbolo al armar el universo
  const w = out.tokens.WETH.address, u = out.tokens.USDC.address;
  for (const f of cfg.factories) {
    try {
      if (!(await hasCode(f.address))) throw new Error("sin código");
      if (f.kind === "v3fee") { const c = new ethers.Contract(f.address, ["function getPool(address,address,uint24) view returns (address)"], provider); await c.getPool(w, u, f.params[1]); }
      else if (f.kind === "v3tick") { const c = new ethers.Contract(f.address, ["function getPool(address,address,int24) view returns (address)"], provider); await c.getPool(w, u, f.params[1]); }
      else if (f.kind === "v2pair") { const c = new ethers.Contract(f.address, ["function getPair(address,address) view returns (address)"], provider); await c.getPair(w, u); }
      else if (f.kind === "aero") { const c = new ethers.Contract(f.address, ["function getPool(address,address,bool) view returns (address)"], provider); await c.getPool(w, u, false); }
      else if (f.kind === "v4") { if (!(await hasCode(f.stateView))) throw new Error("StateView sin código"); }
      out.factories.push(f);
    } catch (e) { disabled.push(`${f.name} ${f.address}: ${e.shortMessage || e.message}`); }
  }
  for (const l of cfg.lenders) {
    try {
      if (!(await hasCode(l.address))) throw new Error("sin código");
      if (l.kind === "aave") { const c = new ethers.Contract(l.address, ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"], provider); await c.FLASHLOAN_PREMIUM_TOTAL(); }
      out.lenders.push(l);
    } catch (e) { disabled.push(`${l.name} ${l.address}: ${e.shortMessage || e.message}`); }
  }
  if (out.aavePool && !out.lenders.some((l) => l.kind === "aave")) out.aavePool = null;
  if (out.morpho && !(await hasCode(out.morpho))) { disabled.push(`Morpho ${out.morpho}: sin código`); out.morpho = null; }
  if (out.l1GasOracle && !(await hasCode(out.l1GasOracle))) { disabled.push(`oráculo L1 ${out.l1GasOracle}: sin código`); out.l1GasOracle = null; }
  return { cfg: out, disabled };
}
