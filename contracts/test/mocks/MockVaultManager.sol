// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20, MockV2Pair} from "./Mocks.sol";

/// Manager de liquidez falso sobre un par v2: emite los mismos eventos que un rebalanceo/zap real
/// (Burn + Swap + Mint en una transacción) y mueve el precio de verdad vendiendo en el par.
contract MockVaultManager {
    string public symbol;
    uint256 public callReward;
    uint256 public lastHarvest;
    MockV2Pair public pair;

    constructor(string memory s, MockV2Pair p, uint256 reward) {
        symbol = s;
        pair = p;
        callReward = reward;
        lastHarvest = block.timestamp;
    }

    /// Rebalanceo real sobre el par: retira (Burn), vende `sellAmount` de tokenIn (Swap) y vuelve a aportar (Mint).
    function rebalance(address tokenIn, uint256 sellAmount) external {
        bool isT0 = tokenIn == pair.token0();
        pair.burn(address(this), isT0 ? sellAmount / 10 : 0, isT0 ? 0 : sellAmount / 10);
        uint256 got = _sell(tokenIn, sellAmount);
        address other = isT0 ? pair.token1() : pair.token0();
        MockERC20(other).transfer(address(pair), got / 2);
        pair.mint(address(this));
        lastHarvest = block.timestamp;
    }

    /// Zap: vende la mitad y aporta (Swap + Mint).
    function zap(address tokenIn, uint256 sellAmount) external {
        uint256 got = _sell(tokenIn, sellAmount);
        address other = tokenIn == pair.token0() ? pair.token1() : pair.token0();
        MockERC20(other).transfer(address(pair), got / 2);
        MockERC20(tokenIn).transfer(address(pair), sellAmount / 2);
        pair.mint(address(this));
    }

    function _sell(address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool zeroForOne = tokenIn == pair.token0();
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inFee = amountIn * (10000 - pair.feeBps());
        out = inFee * rOut / (rIn * 10000 + inFee);
        MockERC20(tokenIn).transfer(address(pair), amountIn);
        pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), "");
    }
}
