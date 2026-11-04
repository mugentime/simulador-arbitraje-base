// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Factory falsa estilo UniswapV2 para pruebas: registra pares y emite PairCreated.
contract MockFactory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    function register(address t0, address t1, address pair) external {
        getPair[t0][t1] = pair;
        getPair[t1][t0] = pair;
        allPairs.push(pair);
        emit PairCreated(t0, t1, pair, allPairs.length);
    }
}
