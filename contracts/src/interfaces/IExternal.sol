// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Interfaces mínimas de los protocolos externos que usa ArbExecutor.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

// ---------- Proveedores de flashloan ----------

/// Morpho Blue: flashloan gratuito, callback onMorphoFlashLoan, devuelve con transferFrom.
interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// Balancer v3 Vault: unlock -> sendTo -> (lógica) -> transfer + settle. Sin comisión.
interface IBalancerVault {
    function unlock(bytes calldata data) external returns (bytes memory);
    function sendTo(address token, address to, uint256 amount) external;
    function settle(address token, uint256 amountHint) external returns (uint256 credit);
}

/// Aave v3 Pool: flashLoanSimple, callback executeOperation, devuelve amount+premium con transferFrom.
/// liquidationCall: paga deuda de `user` en `debtAsset` y recibe `collateralAsset` con bono.
interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

/// Morpho Blue: liquidate entrega el colateral y cobra el préstamo con transferFrom tras el callback (vacío aquí).
interface IMorphoBlue {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256 seized, uint256 repaid);
}

// ---------- DEX ----------

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// Uniswap v4 PoolManager (singleton): unlock -> unlockCallback -> swap + sync/settle/take.
/// `Currency` y `BalanceDelta` son tipos de valor sobre address e int256: se usan directamente.
interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negativo = exact input
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}
