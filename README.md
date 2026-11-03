# Simulador del protocolo de arbitraje con flashloan (Base)

Página estática que lee la red Base en vivo desde el navegador y corre el pipeline del protocolo:
descubre pools (Uniswap v2/v3, PancakeSwap v2/v3, Aerodrome, Slipstream) de WETH/USDC/cbBTC,
lee reservas y comisiones on-chain, busca ciclos de 2-3 saltos, calcula el monto óptimo,
descuenta comisiones, flashloan (Morpho, Balancer v3, Aave v3) y gas real (L2 + L1), y decide
si enviaría la operación. **No envía transacciones.**

Dos universos: **pares principales** (WETH/USDC/cbBTC) y **long tail** (tokens cuyos pools se crearon en las
últimas N horas, más sus pools existentes en todos los DEX, filtrados por liquidez mínima). Uniswap v4 se lee
vía StateView y se marca como "requiere hop v4" porque el contrato aún no lo ejecuta.

- `public/index.html`: página publicada, un solo archivo (incluye ethers v6).
- `src/`: código fuente (`core.js` lógica on-chain, `worker.js` worker 24/7, `vaultsim.js` punto 6). La página de Netlify (`public/index.html`) se genera con `node scripts/build-page.mjs` a partir de `server/dashboard.html` y lee los datos del servidor en Railway.
- `server/index.mjs`: servicio 24/7 en Railway (worker continuo + `GET /api/stats`).

Contabilidad del acumulado: una ruta rentable en bloques consecutivos cuenta una vez (primer bloque). Es un tope
superior: supone que el protocolo gana todas. Variables opcionales: `RPC_URL` (RPC propio de Base), `LT_HOURS`
(ventana long tail del worker, por defecto 2).

## Servicio 24/7 en Railway

`server/index.mjs` corre el worker sin parar (tandas de 1 h) y expone `GET /api/stats` con CORS para el panel.
Railway lo arranca con `npm start` desde la raíz del repo. Recomendado: un volumen montado en `/data` para que
el acumulado sobreviva a reinicios. Variables opcionales: `RPC_URL`, `LT_HOURS`. Cuando el servicio tenga dominio
público, se pone su URL + `/api/stats` en `<meta name="stats-url">` de la página.

## Fase 1 (ejecución) desde Railway

`server/executor.mjs`. Variables en Railway (nunca en el repo):
- `PRIVATE_KEY`: llave de la wallet que paga gas y recibe el beneficio (el contrato no guarda fondos).
- `AUTO_DEPLOY=1`: despliega `ArbExecutor` una vez si no hay dirección guardada (artefacto en `server/artifacts/`).
- `EXECUTE_MODE=simulate|live` (por defecto simulate: solo `eth_call`, nunca envía).
- Límites en live: `MAX_GAS_USD` (0.25), `MAX_TX_PER_HOUR` (20), `PAUSE_AFTER_REVERTS` (3), `MIN_NET_USD` (0.05).
