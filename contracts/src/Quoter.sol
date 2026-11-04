// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IUniswapV3Pool, IPoolManager} from "./interfaces/IExternal.sol";

/// @title Quoter
/// @notice Cotizador exacto sin tokens: ejecuta el swap y revierte en el callback con los deltas (truco del
///         Quoter de Uniswap). Solo para eth_call. Cubre pools tipo v3 (y forks con callback renombrado) y Uniswap v4.
contract Quoter {
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    error QuoteResult(int256 amount0, int256 amount1);

    // ---------------------------------------------------------------- v3
    /// Devuelve la cantidad de salida (v3: el delta negativo es lo que recibe el que llama).
    function quoteV3(address pool, bool zeroForOne, uint256 amountIn) external returns (uint256 amountOut) {
        try IUniswapV3Pool(pool).swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE, ""
        ) {} catch (bytes memory reason) {
            (int256 a0, int256 a1) = _parse(reason);
            return uint256(-(zeroForOne ? a1 : a0));
        }
        revert("no revert");
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external pure {
        revert QuoteResult(a0, a1);
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external pure {
        revert QuoteResult(a0, a1);
    }

    // ---------------------------------------------------------------- v4
    /// Devuelve la cantidad de salida (v4: el delta positivo es lo que recibe el que llama).
    function quoteV4(address manager, IPoolManager.PoolKey calldata key, bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        try IPoolManager(manager).unlock(abi.encode(key, zeroForOne, amountIn)) {} catch (bytes memory reason) {
            (int256 a0, int256 a1) = _parse(reason);
            return uint256(zeroForOne ? a1 : a0);
        }
        revert("no revert");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (IPoolManager.PoolKey memory key, bool zeroForOne, uint256 amountIn) =
            abi.decode(data, (IPoolManager.PoolKey, bool, uint256));
        int256 delta = IPoolManager(msg.sender).swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE
            }),
            ""
        );
        revert QuoteResult(int256(int128(delta >> 128)), int256(int128(delta)));
    }

    function _parse(bytes memory reason) internal pure returns (int256 a0, int256 a1) {
        if (reason.length != 4 + 64) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        bytes4 sel;
        assembly {
            sel := mload(add(reason, 32))
        }
        require(sel == QuoteResult.selector, "otro revert");
        assembly {
            a0 := mload(add(reason, 36))
            a1 := mload(add(reason, 68))
        }
    }
}
