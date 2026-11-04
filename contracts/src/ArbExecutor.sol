// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, IMorpho, IBalancerVault, IAavePool, IUniswapV2Pair, IUniswapV3Pool, IPoolManager, IMorphoBlue, IWETH} from "./interfaces/IExternal.sol";

/// @title ArbExecutor
/// @notice Ejecuta un arbitraje cíclico atómico financiado con flashloan.
///         Flujo: execute() -> flashloan del proveedor -> callback -> swaps de la ruta
///         -> devolución del préstamo -> verificación de beneficio mínimo -> beneficio al owner.
///         Si el beneficio final es menor que minProfit, toda la transacción revierte
///         (solo se pierde el gas).
/// @dev    No guarda saldo entre operaciones. No soporta tokens fee-on-transfer ni rebase
///         (el bot los filtra antes). Requiere EVM Cancun (transient storage).
contract ArbExecutor {
    // ------------------------------------------------------------------ tipos

    enum Source {
        MORPHO, // 0% comisión
        BALANCER_V3, // 0% comisión
        AAVE_V3, // comisión variable (premium que pasa Aave en el callback)
        V3_FLASH // flash de un pool v3 (PancakeSwap/Uniswap): `lender` = pool que contiene `token`; comisión = la del pool
    }

    enum DexKind {
        UNI_V2, // pares tipo UniswapV2 (getReserves + swap)
        UNI_V3, // pools tipo UniswapV3 (swap con callback)
        UNI_V4, // Uniswap v4: `pool` es el PoolManager; la pool se identifica por (tokens, fee, tickSpacing), sin hooks
        AAVE_LIQ, // liquidación en Aave v3: `pool` = Pool; tokenIn = deuda, tokenOut = colateral; extra = abi.encode(user)
        MORPHO_LIQ // liquidación en Morpho Blue: `pool` = Morpho; tokenIn = préstamo, tokenOut = colateral; extra = abi.encode(MarketParams, borrower, seizedAssets)
    }

    struct Hop {
        DexKind kind;
        address pool; // par V2 / pool V3 / PoolManager V4
        address tokenIn;
        address tokenOut;
        uint16 feeBps; // solo UNI_V2: comisión del par en bps (30 = 0.30%)
        uint24 fee; // solo UNI_V4: comisión en pips (500 = 0.05%)
        int24 tickSpacing; // solo UNI_V4
        bytes extra; // solo liquidaciones: parámetros del protocolo
    }

    struct Plan {
        Source source;
        address lender; // dirección de Morpho / Vault de Balancer v3 / Pool de Aave
        address token; // token prestado; la ruta empieza y termina en él
        uint256 amount; // monto del flashloan
        uint256 minProfit; // beneficio neto mínimo en `token`, ya descontada la comisión
        Hop[] hops;
    }

    // ------------------------------------------------------------------ errores / eventos

    error NotOwner();
    error NotOperator();
    error UnexpectedCaller();
    error NotInFlash();
    error BadRoute();
    error InsufficientProfit(uint256 got, uint256 required);
    error TransferFailed();

    event Executed(address indexed token, uint256 amount, uint256 profit, Source source);
    event OperatorSet(address indexed operator, bool allowed);

    // ------------------------------------------------------------------ estado

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    address public immutable owner;
    mapping(address => bool) public operators;

    // Guardas en transient storage: solo válidas durante la transacción en curso.
    address transient expectedLender; // proveedor del que esperamos el callback
    address transient expectedPool; // pool V3 / PoolManager V4 del que esperamos el callback

    /// ETH nativo solo durante saltos v4 (WETH.withdraw y PoolManager.take); se re-envuelve en el mismo salto.
    receive() external payable {}

    constructor(address _owner) {
        owner = _owner;
        operators[_owner] = true;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    function setOperator(address op, bool allowed) external onlyOwner {
        operators[op] = allowed;
        emit OperatorSet(op, allowed);
    }

    /// @notice Recupera tokens que hayan quedado en el contrato (no debería pasar).
    function sweep(address token, uint256 amount) external onlyOwner {
        _safeTransfer(token, owner, amount);
    }

    // ------------------------------------------------------------------ entrada

    /// @notice Punto de entrada del bot. Revierte si la ruta no deja `minProfit`.
    function execute(Plan calldata plan) external onlyOperator returns (uint256 profit) {
        _validateRoute(plan);

        uint256 balanceBefore = IERC20(plan.token).balanceOf(address(this));
        bytes memory data = abi.encode(plan);
        expectedLender = plan.lender;

        if (plan.source == Source.MORPHO) {
            IMorpho(plan.lender).flashLoan(plan.token, plan.amount, data);
        } else if (plan.source == Source.BALANCER_V3) {
            IBalancerVault(plan.lender).unlock(abi.encodeCall(this.balancerV3Callback, (data)));
        } else if (plan.source == Source.AAVE_V3) {
            IAavePool(plan.lender).flashLoanSimple(address(this), plan.token, plan.amount, data, 0);
        } else {
            // el pool prestamista queda bloqueado durante el flash: la ruta no puede pasar por él
            for (uint256 i = 0; i < plan.hops.length; ++i) if (plan.hops[i].pool == plan.lender) revert BadRoute();
            bool isToken0 = IUniswapV3Pool(plan.lender).token0() == plan.token;
            IUniswapV3Pool(plan.lender).flash(address(this), isToken0 ? plan.amount : 0, isToken0 ? 0 : plan.amount, data);
        }

        expectedLender = address(0);

        uint256 balanceAfter = IERC20(plan.token).balanceOf(address(this));
        profit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (profit < plan.minProfit) revert InsufficientProfit(profit, plan.minProfit);

        _safeTransfer(plan.token, owner, balanceAfter);
        emit Executed(plan.token, plan.amount, profit, plan.source);
    }

    // ------------------------------------------------------------------ callbacks de flashloan

    /// Morpho Blue
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        _checkLender();
        Plan memory plan = abi.decode(data, (Plan));
        _runRoute(plan);
        _safeApprove(plan.token, msg.sender, assets); // Morpho cobra con transferFrom
    }

    /// Balancer v3 (llamado por el Vault vía unlock)
    function balancerV3Callback(bytes calldata data) external {
        _checkLender();
        Plan memory plan = abi.decode(data, (Plan));
        IBalancerVault vault = IBalancerVault(msg.sender);
        vault.sendTo(plan.token, address(this), plan.amount);
        _runRoute(plan);
        _safeTransfer(plan.token, msg.sender, plan.amount);
        vault.settle(plan.token, plan.amount);
    }

    /// Aave v3
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        _checkLender();
        if (initiator != address(this)) revert UnexpectedCaller();
        Plan memory plan = abi.decode(params, (Plan));
        _runRoute(plan);
        _safeApprove(asset, msg.sender, amount + premium); // Aave cobra con transferFrom
        return true;
    }

    /// Flash de pool v3: Uniswap y PancakeSwap usan nombres distintos para el mismo callback.
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _v3Flash(fee0, fee1, data);
    }

    function pancakeV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _v3Flash(fee0, fee1, data);
    }

    function _v3Flash(uint256 fee0, uint256 fee1, bytes calldata data) internal {
        _checkLender();
        Plan memory plan = abi.decode(data, (Plan));
        _runRoute(plan);
        _safeTransfer(plan.token, msg.sender, plan.amount + fee0 + fee1); // solo una de las dos comisiones es > 0
    }

    // ------------------------------------------------------------------ callback de swap V3

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    /// Algunos forks (PancakeSwap v3) usan otro nombre para el mismo callback.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    function _v3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        if (msg.sender != expectedPool || expectedPool == address(0)) revert UnexpectedCaller();
        address tokenIn = abi.decode(data, (address));
        uint256 pay = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        _safeTransfer(tokenIn, msg.sender, pay);
    }

    // ------------------------------------------------------------------ ruta

    function _validateRoute(Plan calldata plan) internal pure {
        uint256 n = plan.hops.length;
        if (n == 0 || n > 4) revert BadRoute();
        if (plan.hops[0].tokenIn != plan.token) revert BadRoute();
        if (plan.hops[n - 1].tokenOut != plan.token) revert BadRoute();
        for (uint256 i = 1; i < n; ++i) {
            if (plan.hops[i].tokenIn != plan.hops[i - 1].tokenOut) revert BadRoute();
        }
    }

    function _runRoute(Plan memory plan) internal {
        uint256 amountIn = plan.amount;
        uint256 n = plan.hops.length;
        for (uint256 i = 0; i < n; ++i) {
            Hop memory h = plan.hops[i];
            if (h.kind == DexKind.UNI_V2) amountIn = _swapV2(h, amountIn);
            else if (h.kind == DexKind.UNI_V3) amountIn = _swapV3(h, amountIn);
            else if (h.kind == DexKind.UNI_V4) amountIn = _swapV4(h, amountIn);
            else if (h.kind == DexKind.AAVE_LIQ) amountIn = _liquidateAave(h, amountIn);
            else amountIn = _liquidateMorpho(h, amountIn);
        }
    }

    function _swapV2(Hop memory h, uint256 amountIn) internal returns (uint256 amountOut) {
        IUniswapV2Pair pair = IUniswapV2Pair(h.pool);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool zeroForOne = h.tokenIn < h.tokenOut;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        uint256 amountInWithFee = amountIn * (10_000 - h.feeBps);
        amountOut = (amountInWithFee * rOut) / (rIn * 10_000 + amountInWithFee);

        _safeTransfer(h.tokenIn, h.pool, amountIn);
        (uint256 out0, uint256 out1) = zeroForOne ? (uint256(0), amountOut) : (amountOut, uint256(0));
        pair.swap(out0, out1, address(this), "");
    }

    function _swapV3(Hop memory h, uint256 amountIn) internal returns (uint256 amountOut) {
        if (amountIn > uint256(type(int256).max)) revert BadRoute();
        bool zeroForOne = h.tokenIn < h.tokenOut;
        expectedPool = h.pool;
        (int256 a0, int256 a1) = IUniswapV3Pool(h.pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            abi.encode(h.tokenIn)
        );
        expectedPool = address(0);
        amountOut = uint256(-(zeroForOne ? a1 : a0));
    }

    // ------------------------------------------------------------------ Uniswap v4

    function _swapV4(Hop memory h, uint256 amountIn) internal returns (uint256 amountOut) {
        if (amountIn > uint256(type(int256).max)) revert BadRoute();
        expectedPool = h.pool;
        bytes memory ret = IPoolManager(h.pool).unlock(abi.encode(h, amountIn));
        expectedPool = address(0);
        amountOut = abi.decode(ret, (uint256));
    }

    /// Llamado por el PoolManager dentro de unlock(): swap con contabilidad flash (sync/settle/take).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != expectedPool || expectedPool == address(0)) revert UnexpectedCaller();
        (Hop memory h, uint256 amountIn) = abi.decode(data, (Hop, uint256));
        IPoolManager pm = IPoolManager(msg.sender);
        // Pools con ETH nativo: `extra` = abi.encode(weth). tokenIn/tokenOut siguen siendo WETH (ERC20) para el resto
        // de la ruta; aquí WETH se convierte en la moneda nativa (address(0)) del PoolManager.
        address weth = h.extra.length == 32 ? abi.decode(h.extra, (address)) : address(0);
        address cIn = (weth != address(0) && h.tokenIn == weth) ? address(0) : h.tokenIn;
        address cOut = (weth != address(0) && h.tokenOut == weth) ? address(0) : h.tokenOut;
        bool zeroForOne = cIn < cOut;
        IPoolManager.PoolKey memory key = IPoolManager.PoolKey({
            currency0: zeroForOne ? cIn : cOut,
            currency1: zeroForOne ? cOut : cIn,
            fee: h.fee,
            tickSpacing: h.tickSpacing,
            hooks: address(0)
        });
        int256 delta = pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE
            }),
            ""
        );
        // BalanceDelta: amount0 en los 128 bits altos, amount1 en los bajos (negativo = debemos al manager)
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        (int128 dIn, int128 dOut) = zeroForOne ? (d0, d1) : (d1, d0);
        if (dIn > 0 || dOut < 0) revert BadRoute();
        uint256 owed = uint256(uint128(-dIn));
        uint256 amountOut = uint256(uint128(dOut));
        if (cIn == address(0)) {
            IWETH(weth).withdraw(owed);
            pm.sync(address(0));
            pm.settle{value: owed}();
        } else {
            pm.sync(cIn);
            _safeTransfer(cIn, address(pm), owed);
            pm.settle();
        }
        pm.take(cOut, address(this), amountOut);
        if (cOut == address(0)) IWETH(weth).deposit{value: amountOut}();
        return abi.encode(amountOut);
    }

    // ------------------------------------------------------------------ liquidaciones como "saltos"

    /// Aave v3: paga hasta `amountIn` de deuda y recibe colateral (subyacente) con bono. La deuda no usada queda en el contrato.
    function _liquidateAave(Hop memory h, uint256 amountIn) internal returns (uint256 amountOut) {
        address user = abi.decode(h.extra, (address));
        uint256 before = IERC20(h.tokenOut).balanceOf(address(this));
        _safeApprove(h.tokenIn, h.pool, amountIn);
        IAavePool(h.pool).liquidationCall(h.tokenOut, h.tokenIn, user, amountIn, false);
        _safeApprove(h.tokenIn, h.pool, 0);
        amountOut = IERC20(h.tokenOut).balanceOf(address(this)) - before;
    }

    /// Morpho Blue: toma `seizedAssets` de colateral y paga el préstamo correspondiente (Morpho cobra con transferFrom).
    function _liquidateMorpho(Hop memory h, uint256 amountIn) internal returns (uint256 amountOut) {
        (IMorphoBlue.MarketParams memory mp, address borrower, uint256 seizedAssets) =
            abi.decode(h.extra, (IMorphoBlue.MarketParams, address, uint256));
        _safeApprove(h.tokenIn, h.pool, amountIn); // tope: lo que trajo el préstamo
        (uint256 seized,) = IMorphoBlue(h.pool).liquidate(mp, borrower, seizedAssets, 0, "");
        _safeApprove(h.tokenIn, h.pool, 0);
        amountOut = seized;
    }

    // ------------------------------------------------------------------ utilidades

    function _checkLender() internal view {
        if (expectedLender == address(0)) revert NotInFlash();
        if (msg.sender != expectedLender) revert UnexpectedCaller();
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
