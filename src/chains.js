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
      // revisión horaria 2026-11-04: añadidos
      { sym: "ezETH", address: "0x2416092f143378750bb29b79eD961ab195CcEea5" }, { sym: "AIXBT", address: "0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825" },
      // 2026-11-04 05:50
      { sym: "TOSHI", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4" }, { sym: "tBTC", address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b" },
      // 2026-11-04 06:45
      { sym: "ZORA", address: "0x1111111111166b7FE7bd91427724B487980aFc69" }, { sym: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" }, // LBTC verificado pero 0 pools en estas factories
      // 2026-11-04 07:45
      { sym: "cbXRP", address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af" }, { sym: "KAITO", address: "0x98d0baa52b2D063E780DE12F615f963Fe8537553" },
      // 2026-11-04 08:45
      { sym: "wrsETH", address: "0xEDfa23602D0EC14714057867A78d01e94176BEA0" }, { sym: "PRIME", address: "0xfA980cEd6895AC314E7dE34Ef1bFAE90a5AdD21b" },
      // 2026-11-04 09:45
      { sym: "CLANKER", address: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb" }, { sym: "SPX", address: "0x50dA645f148798F68EF2d7dB7C1CB22A6819bb2C" },
      // 2026-11-04 10:45
      { sym: "SEAM", address: "0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85" }, { sym: "SNX", address: "0x22e6966B799c4D5B13BE962E1D117b56327FDa66" },
      // 2026-11-04 11:45
      { sym: "cbDOGE", address: "0xcbD06E5A2B0C65597161de254AA074E489dEb510" }, { sym: "MOG", address: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71" },
      // 2026-11-04 12:45
      { sym: "HIGHER", address: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe" }, { sym: "USDS", address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc" },
    ],
    // pares excluidos por la revisión horaria (símbolos de rol o etiqueta, o direcciones): ver doc 13
    excludedPairs: ["AERO/BRETT", "AERO/cbETH", "AERO/WELL", // 06:45, 07:45 y 08:45: 3+ corridas seguidas entre los 3 peores
      // 09:45 inactivos (s0: 0 episodios, 0 rutas, 0 ok, 0 envíos; ≥3 h vigilados; métricas acumuladas)
      "AERO/ezETH", "AERO/tBTC", "AIXBT/MORPHO", "AIXBT/USDT", "BRETT/cbBTC", "BRETT/MORPHO", "BRETT/USDT", "DAI/cbBTC", "DAI/EURC", "DAI/weETH",
      // 10:45 inactivos
      "AERO/ZORA", "AIXBT/ZORA", "cbBTC/weETH", "DAI/wstETH", "DEGEN/ezETH", "DEGEN/USDbC", "DEGEN/VIRTUAL", "DEGEN/WELL", "DEGEN/ZRO", "EURC/USDbC",
      // 11:45 inactivos
      "AERO/cbXRP", "AERO/KAITO", "DEGEN/cbXRP", "ezETH/rETH", "KAITO/VIRTUAL", "KAITO/ZRO", "MORPHO/cbBTC", "MORPHO/cbETH", "MORPHO/USDbC", "MORPHO/USDT",
      // 12:45 inactivos
      "AERO/TOSHI", "AERO/VIRTUAL", "AIXBT/USDC", "cbBTC/cbXRP", "cbBTC/wstETH", "cbETH/weETH", "cbETH/wstETH", "EURC/USDT", "EURC/wstETH", "KAITO/USDC"],
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
      { sym: "USDC.e", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", symbols: ["USDC", "USDCe"] }, { sym: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbols: ["USDT0", "USD₮0", "USD₮"] },
      { sym: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" }, { sym: "WBTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
      { sym: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39" }, { sym: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B" },
      { sym: "wstETH", address: "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD" }, { sym: "MaticX", address: "0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6" },
      // revisión horaria 2026-11-04: añadidos
      { sym: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17" }, { sym: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF" },
      // 2026-11-04 05:50
      { sym: "SAND", address: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683" }, { sym: "GHST", address: "0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7" },
      // 2026-11-04 06:45
      { sym: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f" }, { sym: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a" },
      // 2026-11-04 07:45
      { sym: "BAL", address: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3" }, { sym: "TEL", address: "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32" },
      // 2026-11-04 08:45
      { sym: "GNS", address: "0xE5417Af564e4bFDA1c483642db72007871397896" }, { sym: "MANA", address: "0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4" },
      // 2026-11-04 09:45
      { sym: "COMP", address: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c" }, { sym: "1INCH", address: "0x9c2C5fd7b07E95EE044DDeba0E97a665F142394f" },
      // 2026-11-04 10:45
      { sym: "KNC", address: "0x1C954E8fe737F99f68Fa1CCda3e51ebDB291948C" }, { sym: "LDO", address: "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756" },
      // 2026-11-04 11:45
      { sym: "GRT", address: "0x5fe2B58c013d7601147DcdD68C143A77499f5531" }, // WOO verificado pero 0 pools con liquidez ≥ MIN_LIQ_USD
      // 2026-11-04 12:45
      { sym: "XSGD", address: "0xDC3326e71D45186F113a2F448984CA0e8D201995" }, // SNX 0x50B728D8… y EURA 0xE0B52e49… verificados pero 0 pools
    ],
    // pares excluidos por la revisión horaria (símbolos de rol o etiqueta, o direcciones): ver doc 13
    excludedPairs: ["MaticX/USDC", "WBTC/wstETH", // 06:45 y 07:45: 3+ corridas seguidas entre los 3 peores
      // 09:45 inactivos (s0: 0 episodios, 0 rutas, 0 ok, 0 envíos; ≥3 h vigilados; métricas acumuladas)
      "AAVE/CRV", "AAVE/SAND", "CRV/QUICK", "CRV/SAND", "CRV/USDC", "DAI/QUICK", "GHST/LINK", "GHST/QUICK", "GHST/SAND", "GHST/WBTC",
      // 10:45 inactivos (ojo: en Polygon "WETH" es el rol de WPOL; para pares con WETH real usar direcciones)
      "GHST/SUSHI", "GHST/UNI", "LINK/SAND", "LINK/SUSHI", "MaticX/QUICK", "QUICK/SUSHI", "SAND/SUSHI", "SAND/UNI", "SAND/WBTC", "SUSHI/USDC",
      // 11:45: peor 3 corridas (09:45, 10:45, 11:45) + inactivos
      "QUICK/USDC.e",
      "AAVE/BAL", "BAL/LINK", "BAL/SUSHI", "BAL/UNI", "LINK/TEL", "QUICK/TEL", "SAND/TEL", "TEL/UNI", "TEL/USDC", "TEL/USDT",
      // 12:45 inactivos (WETH real = ETH puenteado → por dirección)
      "AAVE/LINK", "AAVE/TEL", "AAVE/UNI", "AAVE/USDC", "AAVE/USDT", "AAVE/WBTC", "DAI/LINK", "DAI/WBTC", "LINK/USDT", "TEL/WBTC"],
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
    ws: ["wss://bsc-rpc.publicnode.com", "wss://bsc.drpc.org", "wss://bsc.publicnode.com", "wss://bsc-ws-node.nariox.org:443"],
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
      // revisión horaria 2026-11-04: añadidos
      { sym: "FDUSD", address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409" }, { sym: "TWT", address: "0x4B0F1812e5Df2A09796481Ff14017e6005508003" },
      // 2026-11-04 05:50
      { sym: "slisBNB", address: "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B" }, { sym: "LINK", address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD" },
      // 2026-11-04 06:45
      { sym: "ADA", address: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47" }, { sym: "DOT", address: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402" },
      // 2026-11-04 07:45
      { sym: "AVAX", address: "0x1CE0c2827e2eF14D5C4f29a091d735A204794041" }, { sym: "UNI", address: "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1" },
      // 2026-11-04 08:45
      { sym: "TRX", address: "0xCE7de646e7208a4Ef112cb6ed5038FA6cC6b12e3" }, { sym: "LTC", address: "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94" },
      // 2026-11-04 09:45
      { sym: "BCH", address: "0x8fF795a6F4D97E7887C79beA79aba5cc76444aDf" }, { sym: "FIL", address: "0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153" },
      // 2026-11-04 10:45
      { sym: "XVS", address: "0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63" }, { sym: "SHIB", address: "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D" },
      // 2026-11-04 11:45
      { sym: "ATOM", address: "0x0Eb3a705fc54725037CC9e008bDede697f62F335" }, { sym: "MATIC", address: "0xCC42724C6683B7E57334c4E856f4c9965ED682bD", symbols: ["POL"] },
      // 2026-11-04 12:45
      { sym: "NEAR", address: "0x1Fa4a73a3F0133f0025378af00236f3aBDEE5D63" }, { sym: "INJ", address: "0xa2B726B1145A4773F68593CF171187d8EBe4d495" },
    ],
    // pares excluidos por la revisión horaria (símbolos de rol o etiqueta, o direcciones): ver doc 13
    excludedPairs: ["BTCB/DAI", "CAKE/DAI", "DAI/DOGE", // 06:45, 07:45 y 08:45: 3+ corridas seguidas entre los 3 peores
      "DAI/XRP", // 09:45: peor 3 corridas (07:45, 08:45, 09:45)
      // 09:45 inactivos (s0: 0 episodios, 0 rutas, 0 ok, 0 envíos; ≥3 h vigilados; métricas acumuladas)
      "BTCB/TWT", "CAKE/slisBNB", "DOGE/slisBNB", "ETH/FDUSD", "ETH/TWT", "LINK/SOL", "USDT/slisBNB", "XRP/slisBNB",
      // 10:45 inactivos
      "ADA/DAI", "ADA/DOT", "ADA/LINK", "ADA/SOL", "ADA/USDC", "DAI/DOT", "DOT/LINK", "DOT/USDC",
      // 11:45 inactivos
      "ADA/CAKE", "ADA/UNI", "AVAX/CAKE", "AVAX/ETH", "AVAX/LINK", "AVAX/SOL", "AVAX/USDC", "AVAX/XRP", "BTCB/UNI", "SOL/UNI",
      // 12:45 inactivos (FDUSD/WBNB y FDUSD/USDC protegidos: únicos enlaces base de FDUSD)
      "ADA/ETH", "BTCB/DOT", "BTCB/FDUSD", "BTCB/LINK", "BTCB/LTC", "BTCB/SOL", "CAKE/DOT", "CAKE/FDUSD", "CAKE/LINK", "CAKE/LTC"],
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
      { sym: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbols: ["USDT0", "USD₮0", "USD₮"] }, { sym: "USDC.e", address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", symbols: ["USDC", "USDCe"] },
      { sym: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" }, { sym: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548" },
      { sym: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529" }, { sym: "weETH", address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe" },
      { sym: "GMX", address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a" }, { sym: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4" },
      { sym: "PENDLE", address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8" }, { sym: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
      // revisión horaria 2026-11-04: añadidos
      { sym: "rETH", address: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8" }, { sym: "MAGIC", address: "0x539bdE0d7Dbd336b79148AA742883198BBF60342" },
      // 2026-11-04 05:50
      { sym: "ezETH", address: "0x2416092f143378750bb29b79eD961ab195CcEea5" }, { sym: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" },
      // 2026-11-04 06:45
      { sym: "GRT", address: "0x9623063377AD1B27544C965cCd7342f7EA7e88C7" }, { sym: "UNI", address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0" },
      // 2026-11-04 07:45
      { sym: "CRV", address: "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978" }, { sym: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196" },
      // 2026-11-04 08:45
      { sym: "ZRO", address: "0x6985884C4392D348587B19cb9eAAf157F13271cd" }, { sym: "GNS", address: "0x18c11FD286C5EC11c3b683Caa813B77f5163A122" },
      // 2026-11-04 09:45
      { sym: "RDNT", address: "0x3082CC23568eA640225c2467653dB90e9250AaA0" }, { sym: "STG", address: "0x6694340fc020c5E6B96567843da2df01b2CE1eb6" },
      // 2026-11-04 10:45
      { sym: "SUSHI", address: "0xd4d42F0b6DEF4CE0383636770eF773390d85c61A" }, { sym: "JOE", address: "0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07" },
      // 2026-11-04 11:45
      { sym: "tBTC", address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40" }, { sym: "FRAX", address: "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F" },
      // 2026-11-04 12:45
      { sym: "LUSD", address: "0x93b346b6BC2548dA6A1E7d98E9a421B42541425b" }, // WOO 0xcAFcD85D… y GRAIL 0x3d9907F9… verificados pero 0 pools
    ],
    // pares excluidos por la revisión horaria (símbolos de rol o etiqueta, o direcciones): ver doc 13
    excludedPairs: ["ARB/PENDLE", "DAI/wstETH", "LINK/PENDLE", // 06:45, 07:45 y 08:45: 3+ corridas seguidas entre los 3 peores
      // 09:45 inactivos (s0: 0 episodios, 0 rutas, 0 ok, 0 envíos; ≥3 h vigilados; métricas acumuladas)
      "GMX/MAGIC", "MAGIC/WBTC", "USDC/rETH", "USDe/WETH", "USDT/cbBTC", "weETH/wstETH",
      // 10:45 inactivos
      "GRT/USDC", "GRT/USDC.e", "GRT/USDT", "MAGIC/UNI",
      // 11:45 inactivos
      "AAVE/DAI", "AAVE/UNI", "ARB/CRV", "CRV/PENDLE", "CRV/UNI", "CRV/WBTC",
      // 12:45 inactivos (WETH/ezETH y GNS/WETH protegidos: únicos enlaces base)
      "AAVE/ARB", "AAVE/USDC", "AAVE/WBTC", "ARB/WBTC", "CRV/USDC", "DAI/WBTC", "LINK/UNI", "LINK/USDC.e", "LINK/USDT", "LINK/WBTC"],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: UNI_V3_CANON, params: UNI_FEES },
      { name: "PancakeSwap v3", kind: "v3fee", address: PANCAKE_V3, params: CAKE_FEES },
      { name: "SushiSwap v2", kind: "v2pair", address: SUSHI_V2, feeBps: 30 },
      { name: "Camelot v2", kind: "v2pair", address: "0x6EcCab422D763aC031210895C81787E87B43A652", feeBps: 30, stableFlag: "stableSwap" }, // pares estables: curva distinta, se descartan
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
      { sym: "VELO", address: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db" }, { sym: "USDC.e", address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", symbols: ["USDC", "USDCe"] },
      { sym: "SNX", address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4" }, { sym: "rETH", address: "0x9Bcef72be871e61ED4fBbc7630889beE758eb81D" },
      // revisión horaria 2026-11-04: añadidos
      { sym: "weETH", address: "0x5A7fACB970D094B6C7FF1df0eA68D99E6e73CBFF" }, { sym: "LINK", address: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6" },
      // 2026-11-04 05:50
      // cbETH y ezETH verificados pero con 0 pools fuera de Slipstream (factory sin código): sustituidos por WLD y AAVE
      { sym: "WLD", address: "0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1" }, { sym: "AAVE", address: "0x76FB31fb4af56892A25e32cFC43De717950c9278" },
      // 2026-11-04 06:45
      { sym: "UNI", address: "0x6fd9d7AD17242c41f7131d257212c54A0e816691" }, { sym: "PERP", address: "0x9e1028F5F1D5eDE59748FFceE5532509976840E0" }, // LDO verificado pero 0 pools (liquidez en Slipstream)
      // 2026-11-04 07:45
      { sym: "LUSD", address: "0xc40F949F8a4e094D1b49a23ea9241D289B7b2819" },
      // 2026-11-04 08:45
      { sym: "tBTC", address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40" }, { sym: "ZRO", address: "0x6985884C4392D348587B19cb9eAAf157F13271cd" },
      // 2026-11-04 09:45
      { sym: "CRV", address: "0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53" }, { sym: "KWENTA", address: "0x920Cf626a271321C151D027030D5d08aF699456b" }, // DOLA verificado pero 0 pools (liquidez en Slipstream)
      // 2026-11-04 10:45
      { sym: "THALES", address: "0x217D47011b23BB961eB6D93cA9945B7501a5BB11" }, // sETH, frxETH y alUSD verificados pero 0 pools (liquidez en Slipstream)
      // 2026-11-04 11:45
      { sym: "STG", address: "0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97" }, // alETH verificado pero 0 pools con liquidez ≥ MIN_LIQ_USD
      // 2026-11-04 12:45 (sUSD 0x8c6f28f2… retirado: sus transferencias revierten con "sUSD retired")
      // FXS 0x67CCEA5b…, USDe 0x5d3a1Ff2…, PENDLE 0xBC7B1Ff1… y BAL 0xFE8B128b… verificados pero 0 pools (sin pools ≥ MIN_LIQ_USD fuera de Slipstream)
    ],
    // pares excluidos por la revisión horaria (símbolos de rol o etiqueta, o direcciones): ver doc 13
    excludedPairs: ["DAI/VELO", "OP/wstETH", // 06:45 y 07:45: 3+ corridas seguidas entre los 3 peores
      // 09:45 inactivos (s0: 0 episodios, 0 rutas, 0 ok, 0 envíos; ≥3 h vigilados; métricas acumuladas)
      "AAVE/OP", "AAVE/SNX", "AAVE/USDC", "AAVE/USDT", "DAI/WLD", "LINK/OP", "LINK/SNX", "LINK/USDT", "LINK/WBTC", "OP/weETH",
      // 10:45 inactivos
      "AAVE/UNI", "DAI/UNI", "LINK/UNI", "rETH/wstETH", "SNX/VELO", "SNX/wstETH", "UNI/USDC", "UNI/USDT", "UNI/WBTC", "USDC.e/WLD",
      // 11:45 inactivos
      "LUSD/OP", "LUSD/SNX", "LUSD/VELO", "sUSD/weETH", "sUSD/wstETH", "UNI/sUSD", "USDT/rETH", "USDT/VELO", "USDT/WLD", "VELO/sUSD",
      // 12:45 inactivos (LUSD/WETH, WETH/tBTC, PERP/USDC y WETH/WLD protegidos: únicos enlaces base)
      "DAI/LINK", "LINK/USDC", "LUSD/USDC.e", "OP/USDT", "OP/VELO", "UNI/USDC.e", "USDC/WLD", "USDC/wstETH", "USDC/ZRO", "USDT/WBTC"], // PERP/USDC no: era el único pool de PERP con token base (sin él, PERP quedaba con 0 pools)
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

  // Robinhood Chain (Arbitrum Orbit, 2026-11-04): secuenciador FCFS en AWS us-east-2, ~100 ms por bloque, sin mempool público ni prioridad por gas.
  // Fuentes de direcciones: Dwellir (verificadas con llamadas en vivo), docs de Bags, RHCSwap. Morpho: dirección no documentada → candidatos probados al arrancar.
  robinhood: {
    key: "robinhood", id: 4663, name: "Robinhood Chain", native: "ETH", beefy: null, morphoApiChainId: 4663,
    rpcs: ["https://rpc.mainnet.chain.robinhood.com"], // público con límite; RPC_URL/WS_RPC_URL (Alchemy) van delante
    ws: [],
    fastRpc: "https://rpc.mainnet.chain.robinhood.com", fastMs: 250,
    publicMempool: false, l1GasOracle: null, blockMs: 100,
    tokens: {
      WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, label: "WETH" },
      USDC: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, label: "USDG" }, // rol dólar = USDG (stable principal de la cadena)
    },
    extraTokens: [{ sym: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" }], // Stock Token oficial (pool v3 NVDA/USDG 0.05 %)
    excludedPairs: [],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", params: UNI_FEES },
      { name: "Uniswap v2", kind: "v2pair", address: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f", feeBps: 30 },
      { name: "Uniswap v4", kind: "v4", address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b", combos: [[100, 1], [500, 10], [3000, 60], [10000, 200]] },
    ],
    lenders: [
      ...["0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010", // citada por deadpixelslabs/flashloan como Morpho Blue en 4663
        "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", "0xc85CE8ffdA27b646D269516B8d0Fa6ec2E958B55", "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD",
        "0x01b0Bd309AA75547f7a37Ad7B1219A898E67a83a", "0xd24ECdD8C1e0E57a4E26B1a7bbeAa3e95466A569", "0xDF9a1DC07e5dEe5ccCCaBeC35e446C70fAF7434e",
        "0xbCE7364E63C3B13C73E9977a83c9704E2aCa876e", "0xa6030627d724bA78a59aCf43Be7550b4C5a0653b", "0x18120312A7cf44DcfEc6dCe5632a431579ED9100"]
        .map((address) => ({ name: "Morpho Blue", kind: "balance", address, feeBps: 0n, probe: "morpho" })),
    ],
    aavePool: null, morpho: "auto",
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
      if (l.probe === "morpho") { const c = new ethers.Contract(l.address, ["function isIrmEnabled(address) view returns (bool)"], provider); await c.isIrmEnabled(ethers.ZeroAddress); }
      out.lenders.push(l);
    } catch (e) { disabled.push(`${l.name} ${l.address}: ${e.shortMessage || e.message}`); }
  }
  if (out.aavePool && !out.lenders.some((l) => l.kind === "aave")) out.aavePool = null;
  if (out.morpho === "auto") out.morpho = out.lenders.find((l) => l.probe === "morpho")?.address ?? null; // dirección no documentada: candidatos verificados arriba
  if (out.morpho && !(await hasCode(out.morpho))) { disabled.push(`Morpho ${out.morpho}: sin código`); out.morpho = null; }
  if (out.l1GasOracle && !(await hasCode(out.l1GasOracle))) { disabled.push(`oráculo L1 ${out.l1GasOracle}: sin código`); out.l1GasOracle = null; }
  return { cfg: out, disabled };
}
