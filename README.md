# Simulador del protocolo de arbitraje con flashloan (Base)

Página estática que lee la red Base en vivo desde el navegador y corre el pipeline del protocolo:
descubre pools (Uniswap v2/v3, PancakeSwap v2/v3, Aerodrome, Slipstream) de WETH/USDC/cbBTC,
lee reservas y comisiones on-chain, busca ciclos de 2-3 saltos, calcula el monto óptimo,
descuenta comisiones, flashloan (Morpho, Balancer v3, Aave v3) y gas real (L2 + L1), y decide
si enviaría la operación. **No envía transacciones.**

- `index.html`: versión publicada, un solo archivo (incluye ethers v6).
- `src/`: código fuente legible (`core.js` lógica, `app.js` interfaz).

Publicación: Netlify con `publish = "."` (ver `netlify.toml`), sin paso de build.
