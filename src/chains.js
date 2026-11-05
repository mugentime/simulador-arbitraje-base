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
      { sym: "SEAM", address: "0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85" }, // SNX 0x22e6966B… retirado 14:45 (SNX/WETH y SNX/USDC s0, 1 pool cada uno)
      // 2026-11-04 11:45
      /* cbDOGE 0xcbD06E5A… retirado 15:45 (WETH/cbDOGE y cbBTC/cbDOGE s0, 1 pool cada uno) */ { sym: "MOG", address: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71" },
      // 2026-11-04 12:45
      { sym: "HIGHER", address: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe" }, { sym: "USDS", address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc" },
      // 2026-11-04 13:45
      { sym: "BNKR", address: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b" }, { sym: "DOGINME", address: "0x6921B130D297cc43754afba22e5EAc0FBf8Db75b" },
      // 2026-11-04 14:45
      { sym: "LINK", address: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196" }, { sym: "SKI", address: "0x768BE13e1680b5ebE0024C42c896E3dB59ec0149" },
      // 2026-11-04 15:45
      { sym: "VVV", address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf" }, /* KTA 0xc0634090… retirado 2026-11-05 01:45 (KTA/WETH peor 3 corridas, su único par) */
      // 2026-11-04 16:45
      { sym: "AAVE", address: "0x63706e401c06ac8513145b7687A14804d17f814b" }, // GHST 0xcD2F2223… retirado 20:45 (único pool GHST/WETH s0)
      // 2026-11-04 17:45 (agentes de Virtuals y memecoin con pools en Uniswap/Aerodrome)
      { sym: "BENJI", address: "0xBC45647eA894030a4E9801Ec03479739FA2485F0" }, { sym: "TYBG", address: "0x0d97F261b1e88845184f678e2d1e7a98D9FD38dE" }, // LUNA 0x55cD6469… verificado pero 0 pools (liquidez contra VIRTUAL)
      // 2026-11-04 18:45 (perps de Base y token de juegos con pools WETH/USDC)
      { sym: "AVNT", address: "0x696F9436B67233384889472Cd7cD58A6fB5DF4f1" }, { sym: "DRB", address: "0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2" }, // B3 0xB3B32F9f… verificado pero 0 pools
      // 2026-11-04 19:45 (Cookie DAO y memecoin con pools WETH/USDC en Uniswap y Aerodrome)
      { sym: "COOKIE", address: "0xC0041EF357B183448B235a8Ea73Ce4E4eC8c265F" }, { sym: "KEYCAT", address: "0x9a26F5433671751C3276a065f57e5a02D2817973" },
      // 2026-11-04 20:45 (GAME de Virtuals con pools WETH/USDC/VIRTUAL; uSOL de Universal con pools WETH/USDC)
      /* GAME 0x1C4CcA7C… retirado 2026-11-05 00:45 (GAME/WETH s0 p1 era su único enlace base; GAME/VIRTUAL sin actividad) */ { sym: "uSOL", address: "0x9B8Df6E244526ab5F6e6400d331DB28C8fdDdb55" },
      // 2026-11-04 21:45 (memecoins con pools WETH en Uniswap/Aerodrome: Mister Miggles y mfercoin, éste también contra VIRTUAL/Mog)
      { sym: "MIGGLES", address: "0xB1a03EdA10342529bBF8EB700a06C60441fEf25d" }, { sym: "mfer", address: "0xE3086852A4B125803C815a158249ae468A3254Ca", symbols: ["$mfer", "MFER"] },
      // 2026-11-04 22:45 (Freysa FAI con pools WETH; uSUI de Universal con pools WETH/USDC/uSOL)
      { sym: "FAI", address: "0xb33Ff54b9F7242EF1593d2C9Bcd8f9df46c77935" }, /* uSUI 0xb0505e5a… retirado 2026-11-05 02:45 (WETH/uSUI s0 p1 era su único enlace base; uSOL/uSUI sin actividad) */ // SPEC 0x96419929… y ODOS 0xca73ed18… verificados pero 0 pools
      // 2026-11-04 23:45 (Coinbase Wrapped LTC con pools USDC/cbBTC/WETH en Aerodrome/Uniswap; Resolv USR con pools USDC/WETH)
      /* cbLTC 0xcb17C9Db… retirado 2026-11-05 03:45 (WETH/cbLTC y cbBTC/cbLTC s0, 1 pool cada uno) */ // USR 0x35E5dB67… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 00:45 (GHO de Aave con pools USDC/WETH/USDS en Aerodrome/Uniswap; Coinbase Wrapped ADA con pools USDC/uADA)
      { sym: "GHO", address: "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee" }, /* cbADA 0xcbADA732… retirado 2026-11-05 04:45 (sin WETH/cbADA s0 quedó en 0 pools: trampa 1) */
      // 2026-11-05 01:45 (Autonolas OLAS con pools WETH/USDC; FLock.io FLOCK con pools USDC/cbBTC/USDT/VVV)
      /* OLAS 0x54330d28… retirado 2026-11-05 05:45 (único pool OLAS/USDC s0) */ { sym: "FLOCK", address: "0x5aB3D4c385B400F3aBB49e80DE2fAF6a88A7B691" },
      // 2026-11-05 02:45 (Horizen ZEN, migrado a Base, con pools ZRO/WETH/USDC en Aerodrome/Uniswap; Talent Protocol TALENT con pools cbBTC/AERO/WETH)
      /* ZEN 0xf43eB8De… retirado 2026-11-05 06:45 (WETH/ZEN y ZEN/cbBTC s0 p1 al entrar al ranking; USDC/ZEN sin actividad; WETH/ZEN era su único enlace al nativo) */ // TALENT 0x9a334061… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 03:45 (Reserve Rights RSR con pools WETH/USDC en Aerodrome/Uniswap; Wrapped BTC WBTC (OFT de BitGo) con pools cbBTC/WETH/USDC)
      { sym: "RSR", address: "0xaB36452DbAC151bE02b16Ca17d8919826072f64a" }, { sym: "WBTC", address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" },
      // 2026-11-05 04:45 (Pendle PENDLE y Curve CRV puenteados, con pools WETH/USDC en Aerodrome/Uniswap)
      /* PENDLE 0xA99F6e67… (1 pool) y CRV 0x8Ee73c48… (CRV/WETH, CRV/USDC p1) retirados 2026-11-05 08:45: s0 al entrar al ranking */
      // 2026-11-05 05:45 (Uniswap UNI y Compound COMP puenteados, con pools WETH/USDC en Uniswap/Aerodrome)
      { sym: "UNI", address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83" }, { sym: "COMP", address: "0x9e1028F5F1D5eDE59748FFceE5532509976840E0" },
      // 2026-11-05 06:45 (Inverse DOLA con pools USDC/USDbC/USD+ en Aerodrome; Wormhole W (NTT) con pools WETH/ZRO)
      { sym: "DOLA", address: "0x4621b7A9c75199271F773Ebd9A499dbd165c3191" }, /* W 0xB0fFa800… retirado 2026-11-05 10:45 (token de 1 pool, W/WETH s0 al entrar al ranking) */
      // 2026-11-05 07:45 (Sky sUSDS, ERC-4626 sin rebase, con pools USDC en Aerodrome/Uniswap; Origin wsuperOETHb, envoltorio sin rebase, con pools WETH/superOETHb)
      /* sUSDS 0x5875eEE1… retirado 2026-11-05 11:45 (USDC/sUSDS y WETH/sUSDS s0 p1 al entrar al ranking) */ // wsuperOETHb 0x7FcD174E… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 08:45 (TN100x memecoin con pools WETH/USDC/HAMFREN; ResearchCoin RSC con pools WETH/BIO/REI en Uniswap/Aerodrome)
      /* TN100x 0x5B5dee44… y RSC 0xFbB75A59… retirados 2026-11-05 12:45 (tokens de 1 pool, TN100x/WETH y RSC/WETH s0 al entrar al ranking) */
      // 2026-11-05 09:45 (Mamo MAMO con pools en Aerodrome/Uniswap contra WETH/VIRTUAL/AIXBT/cbXRP; Ethena sUSDe OFT con pool sUSDe/USDC)
      { sym: "MAMO", address: "0x7300B37DfdfAb110d83290A29DfB31B1740219fE" }, /* sUSDe 0x211Cc4DD… retirado 2026-11-05 13:45 (único pool USDC/sUSDe s0 al entrar al ranking) */
      // 2026-11-05 10:45 (Extra Finance EXTRA con pools USDC/USDbC/cbBTC en Aerodrome; Stargate STG con pools WETH/USDC)
      { sym: "EXTRA", address: "0x2dAD3a13ef0C6366220f989157009e501e7938F8" }, /* STG 0xE3B53AF7… retirado 2026-11-05 14:45 (STG/WETH y STG/USDC s0 p1 al entrar al ranking) */
      // 2026-11-05 11:45 (agentes de Virtuals: VaderAI VADER con pools VIRTUAL/WETH; Acolyt ACOLYT con pools WETH)
      { sym: "ACOLYT", address: "0x79dacb99A8698052a9898E81Fdf883c29efb93cb" }, // VADER 0x731814e4… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 12:45 (Auki AUKI con pools WETH/USDC/AERO en Uniswap/Aerodrome; Aerostrategy AEROSTRAT con pools AERO en Aerodrome)
      { sym: "AUKI", address: "0xF9569cFb8FD265e91aa478d86ae8c78b8AF55Df4" }, // AEROSTRAT 0x1A85b97F… verificado pero 0 pools ≥ MIN_LIQ_USD (solo contra AERO)
      // 2026-11-05 13:45 (Fantom Bomb fBOMB con pools USDC/AERO/WETH/wstETH/TYBG en Aerodrome/Uniswap; Super Champs CHAMP con pools WETH/USDC/cbBTC/AERO)
      { sym: "fBOMB", address: "0x74ccbe53F77b08632ce0CB91D3A545bF6B8E0979" }, { sym: "CHAMP", address: "0xEb6d78148F001F3aA2f588997c5E102E489Ad341" },
      // 2026-11-05 14:45 (CreatorBid BID con pools WETH en Uniswap v3 (2 tiers) y Aerodrome; Metronome msUSD con pools USDC en Uniswap v3 (~$2.7M/día) y AERO en Aerodrome)
      { sym: "BID", address: "0xa1832f7F4e534aE557f9B5AB76dE54B1873e498B" }, { sym: "msUSD", address: "0x526728DBc96689597F85ae4cd716d4f7fCcBAE9d" },
    ],
    // pares excluidos por la revisión horaria (símbolos de rol o etiqueta, o direcciones): ver doc 13
    excludedPairs: ["EXTRA/cbBTC", /* 2026-11-05 14:45 inactivo (s0 p1 al entrar al ranking; EXTRA sigue con EXTRA/WETH y AERO/EXTRA) */ "MAMO/USDC", "MAMO/cbBTC", "MAMO/ZORA", "AIXBT/MAMO", /* 2026-11-05 13:45 inactivos (s0 p1 al entrar al ranking; MAMO sigue con MAMO/WETH y MAMO/VIRTUAL) */ "COMP/USDC", /* 2026-11-05 12:45 peor 3 corridas (s0 p1; COMP sigue con COMP/WETH p2) */ "KEYCAT/VIRTUAL", /* 2026-11-05 11:45 peor 3 corridas (s-0.5 p1; KEYCAT sigue con KEYCAT/WETH) */ "DOLA/WETH", /* 2026-11-05 10:45 inactivo (s0 p1 al entrar al ranking; DOLA sigue con DOLA/USDC) */ "AERO/BRETT", "AERO/cbETH", "AERO/WELL", // 06:45, 07:45 y 08:45: 3+ corridas seguidas entre los 3 peores
      // 09:45 inactivos (s0: 0 episodios, 0 rutas, 0 ok, 0 envíos; ≥3 h vigilados; métricas acumuladas)
      "AERO/ezETH", "AERO/tBTC", "AIXBT/MORPHO", "AIXBT/USDT", "BRETT/cbBTC", "BRETT/MORPHO", "BRETT/USDT", "DAI/cbBTC", "DAI/EURC", "DAI/weETH",
      // 10:45 inactivos
      "AERO/ZORA", "AIXBT/ZORA", "cbBTC/weETH", "DAI/wstETH", "DEGEN/ezETH", "DEGEN/USDbC", "DEGEN/VIRTUAL", "DEGEN/WELL", "DEGEN/ZRO", "EURC/USDbC",
      // 11:45 inactivos
      "AERO/cbXRP", "AERO/KAITO", "DEGEN/cbXRP", "ezETH/rETH", "KAITO/VIRTUAL", "KAITO/ZRO", "MORPHO/cbBTC", "MORPHO/cbETH", "MORPHO/USDbC", "MORPHO/USDT",
      // 12:45 inactivos
      "AERO/TOSHI", "AERO/VIRTUAL", "AIXBT/USDC", "cbBTC/cbXRP", "cbBTC/wstETH", "cbETH/weETH", "cbETH/wstETH", "EURC/USDT", "EURC/wstETH", "KAITO/USDC",
      // 13:45 inactivos
      "SPX/cbBTC", "SPX/cbETH", "SPX/USDC", "USDbC/cbBTC", "USDT/USDbC", "VIRTUAL/cbBTC", "weETH/wstETH",
      // 14:45: peor 3 corridas (12:45, 13:45, 14:45) + inactivos (+ token SNX retirado)
      "USDC/wstETH",
      "SEAM/USDbC",
      // 15:45: peor 4 corridas (12:45 → 15:45) + inactivo (+ token cbDOGE retirado)
      "USDC/cbETH",
      "MOG/SPX",
      // 16:45 inactivo (USDS sigue con USDC/USDS)
      "USDS/WETH",
      // 17:45: peor 3 corridas (15:45, 16:45, 17:45) + inactivos (DEGEN sigue con DEGEN/WETH; BNKR con BNKR/WETH)
      "DEGEN/USDC",
      "DAI/USDT", "AIXBT/BNKR",
      // 18:45 inactivo (LINK sigue con LINK/WETH, 3 pools)
      "LINK/USDC",
      // 19:45 inactivos (VVV sigue con VVV/WETH, 6 pools, y USDC/VVV, 3)
      "USDT/VVV", "VVV/cbBTC",
      // 21:45: peor 3 corridas (19:45, 20:45, 21:45; KTA sigue con KTA/WETH, 4 pools)
      "KTA/USDC",
      // 22:45: peor 3 corridas (20:45, 21:45, 22:45; AERO y wstETH siguen con sus pares WETH) + inactivo (DRB sigue con DRB/WETH, 4 pools)
      "AERO/wstETH",
      "BNKR/DRB",
      // 23:45: peor 3 corridas (21:45, 22:45, 23:45; ZORA sigue con USDC/ZORA, 3 pools) + inactivo (COOKIE sigue con COOKIE/WETH, 3 pools)
      "WETH/ZORA",
      "COOKIE/VIRTUAL",
      // 2026-11-05 00:45 inactivo (entra al ranking ya en s0; uSOL sigue con WETH/uSOL y uSOL/uSUI)
      "cbBTC/uSOL",
      // 2026-11-05 04:45 inactivos (entran al ranking ya en s0; GHO sigue con GHO/USDC p3, cbADA con cbADA/cbBTC p2)
      "GHO/USDT", "WETH/cbADA",
      // 2026-11-05 05:45: peor 3 corridas (03:45, 04:45, 05:45; MORPHO sigue con MORPHO/WETH p5) + inactivo (FLOCK sigue con FLOCK/WETH y FLOCK/USDC, p2 cada uno)
      "AERO/MORPHO",
      "AERO/FLOCK",
      // 2026-11-05 07:45 inactivo (s0 p1 al entrar al ranking; WBTC sigue con WBTC/WETH, WBTC/cbBTC, USDC/WBTC; tBTC con WETH/USDC/cbBTC)
      "WBTC/tBTC"],
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
    rpcs: ["https://polygon-bor-rpc.publicnode.com", /* polygon-rpc.com: 401 "tenant disabled" desde 2026-11-04 */ "https://1rpc.io/matic", "https://polygon.drpc.org", "https://rpc.ankr.com/polygon"],
    ws: ["wss://polygon-bor-rpc.publicnode.com", "wss://polygon.drpc.org"],
    fastRpc: "https://polygon-bor-rpc.publicnode.com", fastMs: 400,
    publicMempool: true, l1GasOracle: null, blockMs: 2000,
    minPriorityGwei: 25, // Bor rechaza propinas < 25 gwei ("gas tip cap … minimum needed 25000000000", 2026-11-05 15:29 UTC)
    tokens: {
      WETH: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, label: "WPOL" },
      USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, label: "USDC" },
      ETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, label: "WETH" },
    },
    extraTokens: [
      { sym: "USDC.e", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", symbols: ["USDC", "USDCe"] }, { sym: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbols: ["USDT0", "USD₮0", "USD₮"] },
      { sym: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" }, { sym: "WBTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
      { sym: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39" }, { sym: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B" },
      { sym: "wstETH", address: "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD" }, /* MaticX 0xfa68FB46… retirado 2026-11-05 14:45 (MaticX/WPOL, su único par, peor 4 corridas 11:45–14:45) */
      // revisión horaria 2026-11-04: añadidos
      // QUICK 0xB5C064F9… retirado 13:45 (solo le quedaban QUICK/WPOL s−0.7 y WETH/QUICK s0: sin pares útiles)
      { sym: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF" },
      // 2026-11-04 05:50
      { sym: "SAND", address: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683" }, { sym: "GHST", address: "0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7" },
      // 2026-11-04 06:45
      { sym: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f" }, { sym: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a" },
      // 2026-11-04 07:45
      { sym: "BAL", address: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3" }, { sym: "TEL", address: "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32" },
      // 2026-11-04 08:45
      { sym: "GNS", address: "0xE5417Af564e4bFDA1c483642db72007871397896" }, // MANA 0xA1c57f48… retirado 17:45 (MANA/WPOL y WETH/MANA s0)
      // 2026-11-04 09:45
      /* COMP 0x8505b9d2… retirado 13:45: único par COMP/WPOL s0 */ { sym: "1INCH", address: "0x9c2C5fd7b07E95EE044DDeba0E97a665F142394f" },
      // 2026-11-04 10:45
      { sym: "KNC", address: "0x1C954E8fe737F99f68Fa1CCda3e51ebDB291948C" }, /* LDO 0xC3C7d422… retirado 2026-11-05 04:45 (LDO/WPOL peor 3 corridas, su único par) */
      // 2026-11-04 11:45
      /* GRT 0x5fe2B58c… retirado 20:45 (GRT/WPOL peor 3 corridas; WETH/GRT s−0.3 quedaba solo) */ // WOO verificado pero 0 pools con liquidez ≥ MIN_LIQ_USD
      // 2026-11-04 12:45
      /* XSGD 0xDC3326e7… retirado 2026-11-05 13:45 (USDC/XSGD peor 3 corridas, su único par) */ // SNX 0x50B728D8… y EURA 0xE0B52e49… verificados pero 0 pools
      // 2026-11-04 13:45
      // PAXG descartado (comisión por transferencia); STG 0x2F6F07CD… y FRAX 0x45c32fA6… verificados pero 0 pools
      // 2026-11-04 14:45: MAI 0xa3Fa99A1… y VOXEL 0xd0258a3f… probados, 0 pools ≥ MIN_LIQ_USD → retirados
      // 2026-11-04 15:45
      // DIMO 0xE261D618… retirado 19:45 (DIMO/WPOL, DIMO/USDC, DIMO/USDT s0, 1 pool cada uno) // AXL 0x6e4E6241… verificado pero 0 pools
      // 2026-11-04 16:45
      /* AVAX 0x2C89bbc9… retirado 2026-11-05 07:45 (AVAX/WPOL peor 3 corridas 05:45–07:45; su único par) */ // SOL 0xd93f7E27… retirado 20:45 (SOL/WPOL, SOL/USDC, SOL/USDT, WETH/SOL s0, 1 pool cada uno)
      // 2026-11-04 17:45
      /* ZRO 0x69858… retirado 21:45 (único pool WPOL/ZRO s0) */ // APE 0xB7b31a6B… y ORBS 0x614389Ea… verificados pero 0 pools
      // 2026-11-04 18:45 (tBTC de Threshold vía Wormhole; NAKA con pools NAKA/WPOL en QuickSwap)
      /* NAKA 0x31143416… retirado 2026-11-05 01:45 (NAKA/WPOL peor 4 corridas, su único enlace) */ // tBTC 0x236aa509… verificado pero 0 pools
      // 2026-11-04 19:45 (MKR con pool WPOL/MKR; YFI con WETH/YFI)
      // MKR 0x6f7C932e… y YFI 0xDA537104… verificados pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-04 20:45 (Polytrade TRADE y REVV, con pools contra WPOL en QuickSwap/Uniswap)
      /* TRADE 0x692AC1e3… y REVV 0x70c00687… retirados 2026-11-05 00:45 (inactivos: TRADE/WPOL y REVV/WPOL, REVV/USDC.e s0 p1; únicos enlaces base) */
      // 2026-11-04 21:45 (QiDao QI con pools QI/DAI/WPOL en QuickSwap; PolyDoge con pools contra WPOL en QuickSwap v2/v3)
      /* QI 0x580A84C7… y PolyDoge 0x8A953CfE… retirados 2026-11-05 01:45 (único pool QI/WPOL y PolyDoge/WPOL s0) */
      // 2026-11-04 22:45 (PlanetIX IXT con pools WPOL/USDT en QuickSwap; Monerium EURe con pools USDC/USDC.e/USDT)
      /* stMATIC 0x3A58a54C… retirado 2026-11-05 10:45 (WPOL/stMATIC s0 p1, peor 3 corridas; su único par) */ /* EURe 0x18ec0A6E… retirado 2026-11-05 02:45 (EURe/USDC s0 p1 era su único enlace base) */ // IXT 0xE06Bd4F5… verificado pero 0 pools
      // 2026-11-04 23:45 (Glo Dollar USDGLO con pools USDC en Uniswap; MANTRA OM con pools WPOL/WETH/USDC.e en QuickSwap/Sushi)
      // 2026-11-05 02:45 (Longinus LGNS con pools DAI/USDT en QuickSwap)
      // LGNS 0xeB51D9A3… verificado pero 0 pools (liquidez contra DAI, que no es token base en Polygon)
      /* USDGLO 0x4F604735… retirado 2026-11-05 03:45 (USDC/USDGLO s0, token de 1 pool) */ // OM 0xC3Ec8034… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 00:45 (BRZ, stable del real brasileño con pools USDT/USDC/WPOL; BNB puenteado PoS con pools WPOL/WETH/AAVE)
      // BRZ 0x4eD14111… y BNB 0xA649325A… verificados pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 01:45 (KlimaDAO KLIMA con pools USDC/WPOL en Sushi/QuickSwap; Vulcan Forged PYR con pools WPOL/WETH en QuickSwap)
      // KLIMA 0x4e78011C… y PYR 0x430EF926… verificados pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 03:45 (Render RNDR con pools WPOL/WETH en QuickSwap/Uniswap; SHIBA INU (PoS) con pools WPOL/WETH/USDC)
      /* RNDR 0x61299774… retirado 2026-11-05 07:45 (token de 1 pool, RNDR/WPOL s0 al entrar al ranking) */ /* SHIB 0x6f8a0644… retirado 2026-11-05 11:45 (SHIB/WPOL peor 3 corridas, su único par) */
      // 2026-11-05 07:45 (Agora AUSD con pools USDC/USDT; GensoKishi MV con pools WPOL/WETH en QuickSwap)
      // AUSD 0x00000000eFE302BE… y MV 0xA3c322Ad… verificados pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 06:45 (STASIS EURS (PoS) con pools USDC/WPOL en Uniswap/QuickSwap)
      /* EURS 0xE111178A… retirado 2026-11-05 10:45 (EURS/USDC s0 p1 al entrar al ranking: su único enlace base; EURS/USDC.e sin sims ni rutas) */
      // 2026-11-05 04:45 (Fetch.ai FET (PoS) con pools WPOL en QuickSwap)
      // FET 0x7583FEDD… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 05:45 (Ocean Token (PoS) con pools en QuickSwap/Sushi)
      // OCEAN 0x282d8efC… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 13:45 (Sunflower Land SFL con pools WPOL/USDC.e en QuickSwap/Uniswap)
      { sym: "SFL", address: "0xD1f9c58e33933a993A3891F8acFe05a68E1afC05" },
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
      "AAVE/LINK", "AAVE/TEL", "AAVE/UNI", "AAVE/USDC", "AAVE/USDT", "AAVE/WBTC", "DAI/LINK", "DAI/WBTC", "LINK/USDT", "TEL/WBTC",
      // 13:45 inactivos (+ tokens COMP y QUICK retirados)
      "UNI/USDC", "UNI/USDT",
      // 14:45: peor 3 corridas (12:45, 13:45, 14:45): WETH real (ETH puenteado)/SUSHI por dirección + inactivo
      ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a"],
      "LDO/USDC.e",
      // 17:45: peor 3 corridas (15:45, 16:45, 17:45) + inactivos (+ token MANA retirado; XSGD sigue con USDC/XSGD)
      "USDC/USDT",
      "LINK/USDC", "USDC.e/XSGD", ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xDC3326e71D45186F113a2F448984CA0e8D201995"],
      // 18:45: peor 4 corridas (15:45 → 18:45): WETH real (ETH puenteado)/GNS por dirección (GNS sigue con GNS/WPOL, GNS/USDC, DAI/GNS)
      ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xE5417Af564e4bFDA1c483642db72007871397896"],
      // 19:45: peor 5 corridas (15:45 → 19:45): WETH real/LDO por dirección (LDO sigue con LDO/WPOL, 3 pools, y LDO/USDC)
      ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756"],
      // 20:45 inactivo: WETH real/AVAX por dirección (AVAX sigue con AVAX/WPOL, 2 pools)
      ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b"],
      // 21:45: peor 3 corridas (19:45, 20:45, 21:45; LDO sigue con LDO/WPOL, 3 pools)
      "LDO/USDC",
      // 23:45: peor 3 corridas (21:45, 22:45, 23:45; s0 p3, también inactivo; WBTC sigue con WBTC/WPOL, USDT/WBTC, USDC/WBTC…)
      "USDC.e/WBTC",
      // 2026-11-05 00:45: peor 3 corridas (22:45, 23:45, 00:45; NAKA sigue con NAKA/WPOL, 2 pools)
      "NAKA/USDC.e",
      // 2026-11-05 05:45: peor 4 corridas (02:45 → 05:45; UNI sigue con UNI/WPOL, UNI/USDC.e y LINK/UNI)
      ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xb33EaAd8d922B1083446DC23f610c2567fB5180f"],
      // 2026-11-05 06:45: peor 3 corridas (04:45, 05:45, 06:45): WETH real/AAVE (AAVE sigue con AAVE/USDC.e y AAVE/WPOL)
      ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xD6DF932A45C0f255f85145f286eA0b292B21C90B"],
      // 2026-11-05 07:45 inactivo (s0 p1 al entrar al ranking): WETH real/SHIB (SHIB sigue con SHIB/WPOL, 2 pools)
      ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0x6f8a06447Ff6FcF75d803135a7de15CE88C1d4ec"]],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: UNI_V3_CANON, params: UNI_FEES },
      { name: "QuickSwap v2", kind: "v2pair", address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", feeBps: 30 },
      { name: "SushiSwap v2", kind: "v2pair", address: SUSHI_V2, feeBps: 30 },
      { name: "Uniswap v2", kind: "v2pair", address: "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C", feeBps: 30 }, // 2026-11-05 13:45
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
      // 2026-11-04 13:45 (FLOKI descartado: impuesto por transferencia)
      { sym: "PEPE", address: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00" }, /* TON 0x76A797A5… retirado 2026-11-05 01:45 (sin TON/WBNB quedó con 0 pools: TON/USDT no pasa el filtro de liquidez) */
      // 2026-11-04 14:45
      { sym: "USD1", address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d" }, { sym: "AAVE", address: "0xfb6115445Bff7b52FeB98650C87f44907E58f802" },
      // 2026-11-04 15:45
      // ETC 0x3d6545b0… retirado 19:45 (ETC/WBNB, CAKE/ETC, DOGE/ETC, ETC/XVS s0, 1 pool cada uno) // USDe 0x5d3a1Ff2… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-04 16:45 (tokens de gobernanza de DEX: Biswap y BakerySwap)
      { sym: "BSW", address: "0x965F527D9159dCe6288a2219DB51fc6Eef120dD1" }, /* SXP 0x47BEAd25… retirado 20:45 (único pool SXP/WBNB s0) */ // BAKE 0xE02dF9e3… verificado pero 0 pools
      // 2026-11-04 17:45 (LST de BNB y token de agregador)
      /* ankrBNB 0x52F24a5e… retirado 21:45 (único pool WBNB/ankrBNB s0) */ { sym: "1INCH", address: "0x111111111117dC0aa78b770fA6A738034120C302" },
      // 2026-11-04 18:45 (LST/CDP de BNB y perps con pools en PancakeSwap)
      /* LISTA 0xFceB31A7… retirado 22:45 (LISTA/WBNB, LISTA/USDT, CAKE/LISTA s0, 1 pool cada uno) */ { sym: "ASTER", address: "0x000Ae314E2A2172a039B26378814C252734f556A" },
      // 2026-11-04 19:45 (SafePal y Coin98, con pools contra WBNB/USDT en PancakeSwap)
      { sym: "SFP", address: "0xD41FDb03Ba84762dD66a0af1a6C8540FF1ba5dfb" }, { sym: "C98", address: "0xaEC945e04baF28b135Fa7c640f624f8D90F1C3a6" },
      // 2026-11-04 20:45 (LST de ETH de Binance y BTC de Solv, con pools contra ETH/BTCB/WBNB en PancakeSwap)
      /* SolvBTC 0x4aae823a… retirado 2026-11-05 00:45 (SolvBTC/WBNB s0 p1 era su único enlace base; BTCB/SolvBTC sin actividad) */ // wBETH 0xa2E33566… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-04 21:45 (AXS con pools WBNB/CAKE en PancakeSwap; WOO con pools WBNB/USDT)
      { sym: "AXS", address: "0x715D400F88C167884bbCc41C5FeA407ed4D2f8A0" }, /* WOO 0x4691937a… retirado 2026-11-05 01:45 (único pool WBNB/WOO s0) */
      // 2026-11-04 22:45 (Thena THE con pools WBNB/USDT/ETH/BTCB; STEPN GMT con pools WBNB/USDT en PancakeSwap)
      /* GMT 0x3019BF2a… retirado 2026-11-05 02:45 (GMT/USDC y GMT/USDT s0, 1 pool cada uno) */
      // 2026-11-04 23:45 (Lista lisUSD con pools USDT/WBNB en PancakeSwap; Mobox MBOX con pools WBNB/USDT; TrueUSD TUSD)
      /* lisUSD 0x0782b6d8… retirado 2026-11-05 03:45 (WBNB/lisUSD s0 p1, su único par contra el nativo; USDT/lisUSD sin actividad) */ { sym: "MBOX", address: "0x3203c9E46cA618C8C1cE5dC67e7e9D75f5da2377" },
      // 2026-11-05 00:45 (World Liberty WLFI con pools WBNB/USDT/USD1 en PancakeSwap; Binance-Peg Zcash con pools WBNB/USDC/BTCB)
      { sym: "WLFI", address: "0x47474747477b199288bF72a1D702f7Fe0Fb1DEeA" }, { sym: "ZEC", address: "0x1Ba42e5193dfA8B03D15dd1B86a3113bbBEF8Eeb" },
      // 2026-11-05 01:45 (memecoins de four.meme con pools WBNB/USDT/USDC en PancakeSwap: Test TST y CZ'S DOG Broccoli)
      { sym: "TST", address: "0x86Bb94DdD16Efc8bc58e6b056e8df71D9e666429" }, { sym: "BROCCOLI", address: "0x6d5AD1592ed9D6D1dF9b93c793AB759573Ed6714", symbols: ["Broccoli"] },
      // 2026-11-05 02:45 (memecoins con pools WBNB/USDT en PancakeSwap: Mubarak y Banana For Scale BANANAS31)
      /* MUBARAK 0x5C85D6C6… y BANANAS31 0x3d4f0513… retirados 2026-11-05 06:45 (tokens de 1 pool, MUBARAK/WBNB y BANANAS31/WBNB s0 al entrar al ranking) */
      // 2026-11-05 03:45 (My Neighbor Alice ALICE con pools WBNB/USDT/CAKE en PancakeSwap; DODO con pools WBNB/CAKE/USDT en PancakeSwap/DODO)
      /* ALICE 0xAC51066d… (1 pool) y DODO 0x67ee3Cb0… (DODO/WBNB, CAKE/DODO p1) retirados 2026-11-05 07:45: s0 al entrar al ranking */
      // 2026-11-05 07:45 (48 Club KOGE con pools WBNB/USD1/USDT en PancakeSwap v3; Four FORM con pools WBNB/TST/USDT)
      // 2026-11-05 08:45 (Solv Protocol SOLV con pools WBNB/USDT en PancakeSwap; Polyhedra ZKJ con pools WBNB/USDC/USDT en PancakeSwap v3)
      /* SOLV 0xabE8E5Ca… (1 pool) y ZKJ 0xC71B5F63… (WBNB/ZKJ, USDT/ZKJ p1) retirados 2026-11-05 12:45: s0 al entrar al ranking */
      // 2026-11-05 09:45 (MYX Finance MYX con pools WBNB/USDT en PancakeSwap; Lorenzo BANK con pools WBNB)
      { sym: "MYX", address: "0xD82544bf0dfe8385eF8FA34D67e6e4940CC63e16" }, /* BANK 0x3AeE7602… retirado 2026-11-05 13:45 (único pool BANK/WBNB s0 al entrar al ranking) */
      // 2026-11-05 10:45 (Stargate STG con pools WBNB/USDT en PancakeSwap; Tutorial TUT con pools WBNB y memecoins de four.meme)
      /* STG 0xB0D502E9… retirado 2026-11-05 14:45 (STG/WBNB y STG/USDC s0 p1 al entrar al ranking) */ { sym: "TUT", address: "0xCAAE2A2F939F51d97CdFa9A86e79e3F085b799f3" },
      // 2026-11-05 11:45 (memecoin 币安人生 de four.meme con pools WBNB y memes; SIREN con pools WBNB/USDC/USDT)
      { sym: "币安人生", address: "0x924fa68a0FC644485b8df8AbfA0A41C2e7744444" }, { sym: "SIREN", address: "0x997A58129890bBdA032231A52eD1ddC845fc18e1" },
      // 2026-11-05 12:45 (Astherus asBNB, LST de BNB sin rebase, con pools WBNB/CAKE en PancakeSwap; Solidus AITECH con pools WBNB/USDT/CAKE)
      { sym: "asBNB", address: "0x77734e70b6E88b4d82fE632a168EDf6e700912b6" }, { sym: "AITECH", address: "0x2D060Ef4d6BF7f9e5edDe373Ab735513c0e4F944" },
      // 2026-11-05 13:45: memes 0xF7454880… (four.meme) verificado pero 0 pools ≥ MIN_LIQ_USD en estas factories
      // 2026-11-05 14:45 (MGO con 2 pools WBNB en PancakeSwap v3, ~$50M/día; World Mobile WMTX con pools WBNB/USDT; Falcon Finance FF con pools USDT/USDC)
      { sym: "MGO", address: "0x5e0d6791EdbEEBa6a14D1d38e2b8233257118EB1" }, { sym: "WMTX", address: "0xDBB5Cf12408a3Ac17d668037Ce289f9eA75439D7" }, // FF 0xAC23B90A… verificado pero 0 pools ≥ MIN_LIQ_USD
      { sym: "KOGE", address: "0xe6DF05CE8C8301223373CF5B969AFCb1498c5528" }, // FORM 0x5b73A93b… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 04:45 (Binance-Peg IoTeX IOTX y Band Protocol BAND con pools WBNB/USDT en PancakeSwap)
      { sym: "IOTX", address: "0x9678E42ceBEb63F23197D726B29b1CB20d0064E5" }, { sym: "BAND", address: "0xAD6cAEb32CD2c308980a548bD0Bc5AA4306c6c18" },
      // 2026-11-05 05:45 (Binance-Peg EOS y Tezos XTZ con pools WBNB/USDT en PancakeSwap)
      // 2026-11-05 06:45 (Binance-Peg Compound COMP con pools ETH/WBNB/USDT; Binance-Peg SushiToken SUSHI con pools WBNB/USDT/USDC en PancakeSwap)
      // COMP 0x52CE071B… y SUSHI 0x947950Bc… verificados pero 0 pools ≥ MIN_LIQ_USD
      { sym: "EOS", address: "0x56b6fB708fC5732DEC1Afc8D8556423A2EDcCbD6" }, // XTZ 0x16939ef7… verificado pero 0 pools ≥ MIN_LIQ_USD
      // TUSD 0x40af3827… verificado pero 0 pools (liquidez contra BUSD) // THE 0xF4C8E32E… e ID 0x2dfF88A5… verificados pero 0 pools (THE: liquidez en Thena)
    ],
    // pares excluidos por la revisión horaria (símbolos de rol o etiqueta, o direcciones): ver doc 13
    excludedPairs: [/* MYX/WBNB: excluido y revertido 13:45 (sin él MYX daba 0 pools: depende del par contra el nativo) */ "AAVE/USDT", /* 2026-11-05 11:45 peor 3 corridas (s-0.2 p2; AAVE sigue con AAVE/WBNB) */ "BTCB/DAI", "CAKE/DAI", "DAI/DOGE", // 06:45, 07:45 y 08:45: 3+ corridas seguidas entre los 3 peores
      "DAI/XRP", // 09:45: peor 3 corridas (07:45, 08:45, 09:45)
      "TON/WBNB", // 2026-11-05 01:45: peor 3 corridas (23:45, 00:45, 01:45; TON sigue con TON/USDT, 4 pools)
      // 09:45 inactivos (s0: 0 episodios, 0 rutas, 0 ok, 0 envíos; ≥3 h vigilados; métricas acumuladas)
      "BTCB/TWT", "CAKE/slisBNB", "DOGE/slisBNB", "ETH/FDUSD", "ETH/TWT", "LINK/SOL", "USDT/slisBNB", "XRP/slisBNB",
      // 10:45 inactivos
      "ADA/DAI", "ADA/DOT", "ADA/LINK", "ADA/SOL", "ADA/USDC", "DAI/DOT", "DOT/LINK", "DOT/USDC",
      // 11:45 inactivos
      "ADA/CAKE", "ADA/UNI", "AVAX/CAKE", "AVAX/ETH", "AVAX/LINK", "AVAX/SOL", "AVAX/USDC", "AVAX/XRP", "BTCB/UNI", "SOL/UNI",
      // 12:45 inactivos (FDUSD/WBNB y FDUSD/USDC protegidos: únicos enlaces base de FDUSD)
      "ADA/ETH", "BTCB/DOT", "BTCB/FDUSD", "BTCB/LINK", "BTCB/LTC", "BTCB/SOL", "CAKE/DOT", "CAKE/FDUSD", "CAKE/LINK", "CAKE/LTC",
      // 13:45 inactivos
      "BCH/LTC", "CAKE/UNI", "DOGE/LTC", "DOGE/USDC", "DOT/ETH", "ETH/LTC", "ETH/UNI", "SOL/USDC", "UNI/USDC", "USDC/XRP",
      // 14:45 inactivos
      "ETH/XVS", "FIL/XVS", "LTC/XVS", "SHIB/USDT", "USDT/XVS",
      // 15:45 inactivos
      "ATOM/USDT",
      // 16:45 inactivos (NEAR e INJ siguen con sus pares WBNB/USDT)
      "ETH/INJ", "ETH/NEAR", "NEAR/USDC",
      // 17:45: peor 3 corridas (15:45, 16:45, 17:45) + inactivos (DOT sigue con DOT/WBNB; PEPE con PEPE/WBNB)
      "DOT/USDT",
      "SOL/XRP", "PEPE/USDT",
      // 18:45 inactivos (AAVE sigue con AAVE/WBNB y AAVE/USDT; USD1 con USDT/WBNB/USDC)
      "AAVE/ETH", "ETH/USD1",
      // 20:45 inactivo (FDUSD sigue con FDUSD/USDT, 2 pools, y FDUSD/WBNB, 1)
      "FDUSD/USDC",
      // 21:45 inactivo (1INCH sigue con 1INCH/WBNB, 3 pools)
      "1INCH/CAKE",
      // 22:45 inactivos (ASTER sigue con ASTER/USDT, 8 pools, y ASTER/WBNB, 6; + token LISTA retirado)
      "ASTER/USDC", "ASTER/BTCB", "ASTER/CAKE", "ASTER/TRX",
      // 23:45 inactivo (SFP sigue con SFP/WBNB, 3 pools)
      "SFP/USDT",
      // 2026-11-05 04:45 inactivos (entran al ranking ya en s0; ZEC sigue con WBNB/ZEC p4, USDT/ZEC p5, BTCB/ZEC p3)
      "DOGE/ZEC", "ETH/ZEC", "SOL/ZEC",
      // 2026-11-05 08:45 inactivos (entran al ranking ya en s0; IOTX y BAND siguen con X/WBNB p2)
      "BAND/ETH", "ETH/IOTX"],
    factories: [
      { name: "PancakeSwap v3", kind: "v3fee", address: PANCAKE_V3, params: CAKE_FEES },
      { name: "Uniswap v3", kind: "v3fee", address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", params: UNI_FEES },
      { name: "PancakeSwap v2", kind: "v2pair", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", feeBps: 25 },
      { name: "Biswap v2", kind: "v2pair", address: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE", feeBps: 20, pairFee: "swapFee" }, // comisión por par (swapFee/1000)
      { name: "Uniswap v2", kind: "v2pair", address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", feeBps: 30 },
    ],
    lenders: [
      { name: "Aave v3", kind: "aave", address: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", feeBps: null },
      // flash de pools v3 al 0.01 % (1 bps, contra 5 bps de Aave): los pools concretos se resuelven al arrancar (verifyChain)
      { name: "PancakeSwap v3 flash", kind: "v3flash", factory: PANCAKE_V3, fee: 100 },
      { name: "Uniswap v3 flash", kind: "v3flash", factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", fee: 100 },
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
      /* ezETH 0x2416092f… retirado 13:45 (único pool WETH/ezETH s0) */ /* USDe 0x5d3a1Ff2… retirado 2026-11-05 11:45 (USDC/USDe peor 3 corridas: su único enlace base; USDT/USDe se va con él) */
      // 2026-11-04 06:45
      /* GRT 0x96230633… retirado 2026-11-05 03:45 (GRT/WETH peor 3 corridas 01:45–03:45; su único par) */ { sym: "UNI", address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0" },
      // 2026-11-04 07:45
      { sym: "CRV", address: "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978" }, { sym: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196" },
      // 2026-11-04 08:45
      { sym: "ZRO", address: "0x6985884C4392D348587B19cb9eAAf157F13271cd" }, // GNS 0x18c11FD2… retirado 13:45 (único pool GNS/WETH s0)
      // 2026-11-04 09:45
      { sym: "RDNT", address: "0x3082CC23568eA640225c2467653dB90e9250AaA0" }, // STG 0x6694340f… retirado 13:45 (STG/WETH y ARB/STG s0)
      // 2026-11-04 10:45
      /* SUSHI 0xd4d42F0b… retirado 2026-11-05 09:45 (SUSHI/WETH peor 3 corridas, su único par) */ { sym: "JOE", address: "0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07" },
      // 2026-11-04 11:45
      { sym: "tBTC", address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40" }, // FRAX 0x17FC002b… retirado 15:45 (FRAX/USDC y FRAX/USDT s0, 1 pool cada uno)
      // 2026-11-04 12:45
      /* LUSD 0x93b346b6… retirado 16:45 (único pool LUSD/USDC s0) */ // WOO 0xcAFcD85D… y GRAIL 0x3d9907F9… verificados pero 0 pools
      // 2026-11-04 13:45
      // ETHFI 0x7189fb5B… y XAI 0x4Cb9a7AE… retirados 17:45 (ETHFI/WETH, ETHFI/PENDLE y WETH/XAI s0, 1 pool cada uno)
      // 2026-11-04 14:45
      // rsETH 0x4186BFC7… y LDO 0x13Ad51ed… retirados 18:45 (WETH/rsETH, rsETH/wstETH, LDO/WETH, LDO/USDC, LDO/USDT, ARB/LDO s0, 1 pool cada uno)
      // 2026-11-04 15:45
      /* ATH 0xc87B37a5… retirado 19:45 (ATH/WETH y ATH/USDC s0, 1 pool cada uno) */ /* SOL 0x2bcC6D6C… retirado 2026-11-05 06:45 (SOL/WETH peor 3 corridas 03:45 → 05:45, su único par) */
      // 2026-11-04 16:45
      /* PEPE 0x25d887Ce… retirado 2026-11-05 05:45 (PEPE/WETH peor 3 corridas 03:45–05:45; su único par) */ // COMP 0x354A6dA3… retirado 20:45 (único pool COMP/WETH s0)
      // 2026-11-04 17:45 (stable de Aave y OHM)
      { sym: "GHO", address: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33" }, /* OHM 0xf0cb2dc0… retirado 21:45 (único pool OHM/WETH s0) */
      // 2026-11-04 18:45 (Sanko DMT con pools WETH/DMT en Camelot y Uni v3; RPL de Rocket Pool)
      // DMT 0x8B0E6f19… y RPL 0xB766039c… verificados pero 0 pools (DMT: liquidez en Camelot v3; RPL: contra wstETH)
      // 2026-11-04 19:45 (SPELL con pools WETH/USDT en Uni v3 y Sushi; BAL de Balancer)
      /* SPELL 0x3E6648C5… retirado 23:45 (único pool SPELL/WETH s0) */ // BAL 0x040d1EdC… verificado pero 0 pools (liquidez en Balancer)
      // 2026-11-04 20:45 (Livepeer LPT con pools WETH/USDC en Uni v3; WINR con pools WETH/ARB en Camelot/Uni v3)
      /* LPT 0x289ba170… y WINR 0xD77B108d… retirados 2026-11-05 00:45 (único pool LPT/WETH y WETH/WINR s0) */
      // 2026-11-04 21:45 (stablecoins secundarias: MIM con pools WETH/ARB/USDT en Uni v3; USDS de Sky con pools USDC/WETH)
      /* MIM 0xFEa7a6a0… retirado 2026-11-05 01:45 (único pool MIM/WETH s0) */ // USDS 0x6491c05A… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-04 22:45 (CAKE con pools WETH/ARB/USDC en PancakeSwap v3; Wormhole W con pools WETH en Uni v3)
      /* CAKE 0x1b896893… y W 0xB0fFa800… retirados 2026-11-05 02:45 (CAKE/WETH y W/WETH s0, 1 pool cada uno) */
      // 2026-11-05 02:45 (Tether Gold XAUt0, OFT, con pools USDC/USDT0/PAXG en Uni v3/v4)
      /* XAUt0 0x40461291… retirado 2026-11-05 06:45 (USDC/XAUt0 y USDT/XAUt0 s0 p1 al entrar al ranking) */
      // 2026-11-05 06:45 (Frax frxETH y sfrxETH con pools WETH/wstETH en Camelot/Uni v3/Balancer)
      // frxETH 0x178412e7… y sfrxETH 0x95aB4587… verificados pero 0 pools ≥ MIN_LIQ_USD (liquidez en Curve/Balancer)
      // 2026-11-05 03:45 (Morpho MORPHO, OFT de LayerZero, con pools WETH en Uni v3)
      // MORPHO 0x40BD670A… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-04 23:45 (Animecoin ANIME con pools WETH/USDT0 en Uni v3/Camelot; Frax frxUSD con pools USDC)
      // ANIME 0x37a64564… y frxUSD 0x80Eede49… verificados pero 0 pools (ANIME: liquidez en Camelot v3/contra USDT0)
      // 2026-11-05 00:45 (Ethena ENA, OFT con la misma dirección en L2, pools WETH en Uni v3; cbETH de Coinbase con pools WETH en Uni v3/Balancer)
      /* cbETH 0x1DEBd73E… retirado 2026-11-05 04:45 (único pool WETH/cbETH s0) */ // ENA 0x58538e6A… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 01:45 (SolvBTC con pools WBTC/WETH en Uni v3/Camelot; Ethena sUSDe, OFT, con pools USDC/USDe)
      // SolvBTC 0x3647c54c… y sUSDe 0x211Cc4DD… verificados pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 04:45 (Inverse DOLA con pools USDC en Balancer/Uni v3)
      /* DOLA 0x6A766179… retirado 2026-11-05 08:45 (token de 1 pool, DOLA/USDC s0 al entrar al ranking) */
      // 2026-11-05 08:45 (Morpheus MOR con pools WETH/USDC en Uniswap v3)
      /* MOR 0x092bAaDB… retirado 2026-11-05 14:45 (MOR/WETH, su único par, peor 3 corridas 12:45–14:45) */
      // 2026-11-05 07:45 (Bedrock uniETH con pools WETH en Uniswap/Camelot; Avalanche Bitcoin BTC.b con pools WETH/WBTC)
      /* BTC.b 0x2297aEbD… retirado 2026-11-05 13:45 (BTC.b/WBTC peor 3 corridas; BTC.b/WETH s0 p1 quedaba solo) */ // uniETH 0x3d15fD46… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 05:45 (Curve crvUSD con pools USDC/USDT; yearn YFI con pools WETH)
      // crvUSD 0x498Bf2B1… y YFI 0x82e3A8F0… verificados pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-05 13:45 (RAIN con pools WETH/USDT0/USDC en Uniswap v3, ~$2–3M/día)
      { sym: "RAIN", address: "0x25118290e6A5f4139381D072181157035864099d" },
      // 2026-11-05 14:45 (Subsquid SQD con pools WETH en PancakeSwap v3 y Uniswap v3)
      { sym: "SQD", address: "0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1" },
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
      "AAVE/ARB", "AAVE/USDC", "AAVE/WBTC", "ARB/WBTC", "CRV/USDC", "DAI/WBTC", "LINK/UNI", "LINK/USDC.e", "LINK/USDT", "LINK/WBTC",
      // 13:45: peor 3 corridas (11:45, 12:45, 13:45) + inactivos (+ tokens ezETH, GNS y STG retirados)
      "AAVE/PENDLE",
      "PENDLE/UNI", "UNI/USDC", "UNI/USDC.e", "USDC/wstETH", "USDC.e/wstETH", "USDT/ZRO",
      // 14:45: peor 3 corridas (12:45, 13:45, 14:45)
      "GMX/USDC.e",
      // 16:45: peor 3 corridas (14:45, 15:45, 16:45)
      "AAVE/USDT",
      // 19:45 inactivos (SOL sigue con SOL/WETH, 2 pools)
      "SOL/USDC", "SOL/WBTC",
      // 20:45 inactivo (PEPE sigue con PEPE/WETH, 2 pools)
      "PEPE/USDC",
      // 21:45 inactivo (GHO sigue con GHO/USDC, 3 pools)
      "GHO/USDT",
      // 22:45: peor 3 corridas (20:45, 21:45, 22:45; ARB y DAI siguen con sus pares WETH/USDC/USDT)
      "ARB/DAI",
      // 2026-11-05 00:45: peor 3 corridas (22:45, 23:45, 00:45; GMX sigue con GMX/WETH, 4 pools)
      "GMX/USDC",
      // 2026-11-05 08:45 peor 3 corridas (06:45, 07:45, 08:45; ZRO sigue con WETH/ZRO p3)
      "USDC/ZRO"],
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: UNI_V3_CANON, params: UNI_FEES },
      { name: "PancakeSwap v3", kind: "v3fee", address: PANCAKE_V3, params: CAKE_FEES },
      { name: "SushiSwap v2", kind: "v2pair", address: SUSHI_V2, feeBps: 30 },
      { name: "Camelot v2", kind: "v2pair", address: "0x6EcCab422D763aC031210895C81787E87B43A652", feeBps: 30, stableFlag: "stableSwap", dirFee: true }, // pares estables: curva distinta, se descartan
      { name: "Uniswap v2", kind: "v2pair", address: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9", feeBps: 30 }, // 2026-11-05 13:45
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
      { sym: "SNX", address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4" }, // rETH 0x9Bcef72b… retirado 17:45 (único pool WETH/rETH s0)
      // revisión horaria 2026-11-04: añadidos
      { sym: "weETH", address: "0x5A7fACB970D094B6C7FF1df0eA68D99E6e73CBFF" }, /* LINK 0x350a791B… retirado 2026-11-05 14:45 (LINK/WETH, su único par, peor 3 corridas 12:45–14:45) */
      // 2026-11-04 05:50
      // cbETH y ezETH verificados pero con 0 pools fuera de Slipstream (factory sin código): sustituidos por WLD y AAVE
      /* WLD 0xdC6fF44d… retirado 13:45 (único pool WETH/WLD s0) */ { sym: "AAVE", address: "0x76FB31fb4af56892A25e32cFC43De717950c9278" },
      // 2026-11-04 06:45
      /* UNI 0x6fd9d7AD… retirado 2026-11-05 07:45 (UNI/WETH peor 3 corridas 05:45–07:45; su único par) */
      // 2026-11-05 07:45 (Moonwell WELL con pools WETH en Velodrome; Dinero pxETH con pools WETH)
      /* WELL 0xA88594D4… retirado 2026-11-05 11:45 (token de 1 pool, WELL/WETH s0 al entrar al ranking) */ /* pxETH 0x300d2c87… verificado pero 0 pools */ // PERP 0x9e1028F5… retirado 13:45 (único pool PERP/USDC s0) // LDO verificado pero 0 pools (liquidez en Slipstream)
      // 2026-11-04 07:45
      // LUSD 0xc40F949F… retirado 13:45 (único pool LUSD/WETH s0)
      // 2026-11-04 08:45
      { sym: "tBTC", address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40" }, { sym: "ZRO", address: "0x6985884C4392D348587B19cb9eAAf157F13271cd" },
      // 2026-11-04 09:45
      // CRV 0x0994206d… y KWENTA 0x920Cf626… retirados 13:45 (CRV/WETH, CRV/USDC y KWENTA/WETH s0) // DOLA verificado pero 0 pools (liquidez en Slipstream)
      // 2026-11-04 10:45
      { sym: "THALES", address: "0x217D47011b23BB961eB6D93cA9945B7501a5BB11" }, // sETH, frxETH y alUSD verificados pero 0 pools (liquidez en Slipstream)
      // 2026-11-04 11:45
      /* STG 0x296F55F8… retirado 2026-11-05 12:45 (STG/WETH peor 3 corridas 10:45–12:45; su único par) */ // alETH verificado pero 0 pools con liquidez ≥ MIN_LIQ_USD
      // 2026-11-04 12:45 (sUSD 0x8c6f28f2… retirado: sus transferencias revierten con "sUSD retired")
      // FXS 0x67CCEA5b…, USDe 0x5d3a1Ff2…, PENDLE 0xBC7B1Ff1… y BAL 0xFE8B128b… verificados pero 0 pools (sin pools ≥ MIN_LIQ_USD fuera de Slipstream)
      // 2026-11-04 13:45 (pools en Velodrome v2: OP/EXTRA, EXTRA/VELO, USDC/EXTRA)
      // EXTRA 0x2dAD3a13… retirado 17:45 (EXTRA/USDC y EXTRA/USDC.e s0, 1 pool cada uno)
      // 2026-11-04 14:45: USD+ 0x73cb180b… y MAI 0xdFA46478… probados, 0 pools fuera de Slipstream → retirados
      // 2026-11-04 15:45: msUSD 0x9dAbAE72… y msETH 0x1610e3c8… verificados, 0 pools fuera de Slipstream → retirados
      // 2026-11-04 16:45
      // FRAX 0x2E3D8707… y USDGLO 0x4F604735… retirados 20:45 (FRAX/USDC, FRAX/USDT y USDC/USDGLO s0, 1 pool cada uno)
      // 2026-11-04 17:45 (pools WETH/ACX y WETH/WCT en Velodrome)
      /* WCT 0xeF446189… retirado 21:45 (único pool WCT/WETH s0) */ // ACX 0xFf733b2A… verificado pero 0 pools fuera de Slipstream
      // 2026-11-04 18:45 (USDT0 nativo —distinto del USDT puenteado— con pools contra WETH/OP/USDT; kBTC de Kraken)
      // USDT0 0x01bFF417… y kBTC 0x73E0C0d4… verificados pero 0 pools fuera de Slipstream/v4
      // 2026-11-04 19:45 (wrsETH de Kelp con pools contra ETH/VELO/ezETH en Velodrome)
      // wrsETH 0x87eEE96D… verificado pero 0 pools (liquidez en Slipstream/contra ezETH)
      // 2026-11-04 20:45 (EXA de Exactly con pools WETH/OP en Velodrome; HAI con pools WETH/USDC en Velodrome)
      /* EXA 0x1e925De1… retirado 2026-11-05 00:45 (único pool EXA/WETH s0) */ { sym: "HAI", address: "0x10398AbC267496E49106B07dd6BE13364D10dC71" },
      // 2026-11-04 21:45 (dHEDGE DHT con pools WETH/OP en Velodrome; KNC con pools WETH/USDT/OP)
      /* DHT 0xAF9fE3B5… retirado 2026-11-05 01:45 (DHT/WETH y DHT/OP s0, 1 pool cada uno) */ // KNC 0xa00E3A35… verificado pero 0 pools ≥ MIN_LIQ_USD
      // 2026-11-04 22:45 (PoolTogether POOL con pools WETH en Velodrome/Uni v3; Wormhole W con pools WETH)
      /* POOL 0x395Ae52b… retirado 2026-11-05 02:45 (único pool POOL/WETH s0) */ // W 0xB0fFa800… y SUSHI 0x3eaEb77b… verificados pero 0 pools
      // 2026-11-04 23:45 (Beefy BIFI con pools WETH en Velodrome; Frax frxUSD con pools USDC en Velodrome)
      // BIFI 0x4E720DD3… y frxUSD 0x80Eede49… verificados pero 0 pools fuera de Slipstream
      // 2026-11-05 00:45 (Ethena ENA, OFT con la misma dirección en L2, pools WETH/USDC en Velodrome/Uni v3)
      // ENA 0x58538e6A… verificado pero 0 pools fuera de Slipstream
      // 2026-11-05 01:45 (CyberConnect CYBER con pools OP/USDC/WETH en Velodrome/Uni v3; Ethena sUSDe, OFT)
      // CYBER 0x14778860… y sUSDe 0x211Cc4DD… verificados pero 0 pools fuera de Slipstream
      // 2026-11-05 05:45 (Lyra LYRA con pools OP/USDC.e/VELO en Velodrome)
      // LYRA 0x50c57259… retirado 2026-11-05 09:45 (único pool LYRA/WETH s0 al entrar al ranking)
      // 2026-11-05 12:45 (con Slipstream ya activo en OP: USDT0 con pools USDC/WETH/USDT y Renzo ezETH con pools WETH, antes 0 pools solo por la factory sin código)
      { sym: "USDT0", address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", symbols: ["USD₮0"] }, // ezETH 0x2416092f… 0 pools también con Slipstream
      // 2026-11-05 13:45 (reintento con Slipstream activo: Kelp wrsETH con pools WETH; Kraken kBTC con pools WBTC/WETH)
      // wrsETH 0x87eEE96D…, kBTC 0x73E0C0d4…, ACX 0xFf733b2A… y ENA 0x58538e6A… verificados pero 0 pools ≥ MIN_LIQ_USD también con Slipstream y Uniswap v2
      // 2026-11-05 14:45 (reintento con Slipstream: Metronome msETH/msUSD con pools WETH/OP/USDC/msUSD-msETH; cbETH con pools WETH/wstETH/USDC)
      // msETH 0x1610e3c8… y msUSD 0x9dAbAE72… verificados pero 0 pools ≥ MIN_LIQ_USD también con Slipstream
      { sym: "cbETH", address: "0xadDb6A0412DE1BA0F936DCaeb8Aaa24578dcF3B2" },
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
      "DAI/LINK", "LINK/USDC", "LUSD/USDC.e", "OP/USDT", "OP/VELO", "UNI/USDC.e", "USDC/WLD", "USDC/wstETH", "USDC/ZRO", "USDT/WBTC",
      // 13:45 inactivos (+ tokens WLD, PERP, LUSD, CRV y KWENTA retirados: sin pares útiles)
      "USDT/ZRO", "VELO/wstETH",
      // 15:45 inactivos (STG queda con STG/WETH, 2 pools)
      "STG/USDC", "STG/USDC.e",
      // 17:45: peor 3 corridas (15:45, 16:45, 17:45) + inactivos (+ tokens rETH y EXTRA retirados; SNX/WETH protegido: único enlace base de SNX)
      "DAI/USDC",
      "USDC.e/WBTC", "USDC.e/VELO",
      // 20:45: peor 3 corridas (18:45, 19:45, 20:45; OP sigue con OP/WETH, 4 pools, y OP/USDC.e, 2)
      "OP/USDC",
      // 2026-11-05 08:45 inactivo 3 corridas (06:45, 07:45, 08:45; OP sigue con OP/WETH p4)
      "OP/USDC.e"], // PERP/USDC no: era el único pool de PERP con token base (sin él, PERP quedaba con 0 pools)
    factories: [
      { name: "Uniswap v3", kind: "v3fee", address: UNI_V3_CANON, params: UNI_FEES },
      { name: "Velodrome Slipstream", kind: "v3tick", address: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F" /* 2026-11-05 12:45: la anterior 0xCc0bDDB7…e09910ed… no tenía código y Slipstream estaba desactivado en OP */, params: [1, 50, 100, 200] },
      { name: "Velodrome v2", kind: "aero", address: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a" },
      { name: "SushiSwap v2", kind: "v2pair", address: "0xFbc12984689e5f15626Bad03Ad60160Fe98B303C", feeBps: 30 },
      { name: "Uniswap v2", kind: "v2pair", address: "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf", feeBps: 30 }, // 2026-11-05 13:45
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
    publicMempool: false, l1GasOracle: null, blockMs: 100, fcfs: true, // orden por llegada: propina inútil
    tokens: {
      WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, label: "WETH" },
      USDC: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, label: "USDG" }, // rol dólar = USDG (stable principal de la cadena)
    },
    // Stock Tokens (NVDA, TSLA…) NO: el contrato revisa cada transferencia contra un registro de wallets aprobadas;
    // nuestro ArbExecutor no puede recibirlos → rutas fantasma (transferFrom reverted). Se excluyen sus pools.
    // 2026-11-04: tokens de los CLM de Beefy con más APY/TVL (direcciones de api.beefy.finance/cow-vaults).
    extraTokens: [
      { sym: "AI", address: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18" }, { sym: "BONER", address: "0x98096d17e191B3dA1d5f99a6D7b3584351b11E18" },
      { sym: "CASHCAT", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" }, { sym: "PONS", address: "0x39dBED3a2bd333467115dE45665cC57F813C4571" },
      { sym: "TENDIES", address: "0x45242320DBB855EeA8Fd36804C6487E10E97FCF9" }, { sym: "ORBIO", address: "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3" },
      { sym: "UP", address: "0x57C0E45cB534413D1C20A4240955d6bB250BB4F1", symbols: ["UP33"] },
      // Stock Tokens: solo observación (desajustes entre pools alrededor de la apertura/cierre de NY); no entran a ciclos
      { sym: "AMD", address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", symbols: ["AMDrh"] }, { sym: "META", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", symbols: ["METArh"] },
      { sym: "AMC", address: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", symbols: ["AMCrh"] }, { sym: "CRCL", address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", symbols: ["CRCLrh"] },
      { sym: "SPCX", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", symbols: ["SPCXrh"] },
    ],
    observeTokens: ["0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa"],
    blockedTokens: ["0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"],
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
  for (const l of cfg.lenders.filter((x) => x.kind === "v3flash")) {
    // un prestamista por pool de 0.01 % entre los tokens de referencia (p. ej. WBNB/USDT, USDT/USDC)
    const roles = Object.values(out.tokens);
    const fac = new ethers.Contract(l.factory, ["function getPool(address,address,uint24) view returns (address)"], provider);
    for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) {
      try {
        const pool = await fac.getPool(roles[i].address, roles[j].address, l.fee);
        if (!pool || pool === ethers.ZeroAddress || !(await hasCode(pool))) continue;
        out.lenders.push({ name: `${l.name} ${roles[i].label}/${roles[j].label}`, kind: "balance", address: pool, feeBps: BigInt(l.fee / 100), source: 3, pool: true });
      } catch (e) { disabled.push(`${l.name} ${roles[i].label}/${roles[j].label}: ${e.shortMessage || e.message}`); }
    }
  }
  for (const l of cfg.lenders.filter((x) => x.kind !== "v3flash")) {
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
