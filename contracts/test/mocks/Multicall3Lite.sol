// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Subconjunto de Multicall3 (solo aggregate3) para pruebas locales con anvil.
contract Multicall3Lite {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory r) {
        r = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (r[i].success, r[i].returnData) = calls[i].target.call(calls[i].callData);
            require(calls[i].allowFailure || r[i].success, "call failed");
        }
    }
}
