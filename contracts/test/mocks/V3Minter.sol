// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./Mocks.sol";

interface IV3PoolMint {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// Añade liquidez a un pool Uniswap v3 real (pagando en el callback) para las pruebas con ticks.
contract V3Minter {
    function mint(address pool, int24 lower, int24 upper, uint128 amount) external returns (uint256 a0, uint256 a1) {
        (a0, a1) = IV3PoolMint(pool).mint(address(this), lower, upper, amount, "");
    }

    /// Swap exact-input pagando en el callback; con staticCall sirve de cotizador exacto.
    function swap(address pool, bool zeroForOne, uint256 amountIn) external returns (int256 a0, int256 a1) {
        (a0, a1) = IV3PoolMint(pool).swap(
            address(this), zeroForOne, int256(amountIn),
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341, ""
        );
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (amount0Delta > 0) MockERC20(IV3PoolMint(msg.sender).token0()).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) MockERC20(IV3PoolMint(msg.sender).token1()).transfer(msg.sender, uint256(amount1Delta));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (amount0Owed > 0) MockERC20(IV3PoolMint(msg.sender).token0()).transfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) MockERC20(IV3PoolMint(msg.sender).token1()).transfer(msg.sender, amount1Owed);
    }
}
