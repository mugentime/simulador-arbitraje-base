// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Dueño de préstamos en Revert Lend (V3Vault) con operaciones atómicas por flashloan de Morpho Blue (0 %).
///  - deleverage: flash USDC → repay → retirar liquidez → vender WETH → devolver flash; lo que sobra baja más la deuda.
///  - recenter:   flash USDC → repagar toda la deuda → sacar el NFT → cerrar → reequilibrar → nueva posición centrada →
///                depositar en el vault → borrow → devolver flash.
///  - borrow / repay / sweep: solo el dueño. Todos los fondos salen únicamente al dueño o a `to` que él indique.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IMorphoFlash {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IRevertVault {
    struct DecreaseLiquidityAndCollectParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint128 feeAmount0;
        uint128 feeAmount1;
        uint256 deadline;
        address recipient;
    }

    function borrow(uint256 tokenId, uint256 amount) external;
    function repay(uint256 tokenId, uint256 amount, bool isShare) external returns (uint256 assets, uint256 shares);
    function decreaseLiquidityAndCollect(DecreaseLiquidityAndCollectParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1);
    function remove(uint256 tokenId, address recipient, bytes calldata data) external;
    function loans(uint256 tokenId) external view returns (uint256 debtShares);
}

interface INPM {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata) external payable returns (uint256 tokenId, uint128 liquidity, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128 liquidity, uint256, uint256, uint128, uint128);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract RevertLoanManager {
    error Unauthorized();
    error BadCallback();
    error InsufficientToRepayFlash(uint256 have, uint256 need);

    event Deleveraged(uint256 indexed tokenId, uint256 flash, uint128 liquidity, uint256 extraRepaid);
    event Recentered(uint256 indexed oldTokenId, uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint256 borrowed);

    address public immutable owner;
    IRevertVault public immutable vault;
    INPM public immutable npm;
    IMorphoFlash public immutable morpho;
    ISwapRouter02 public immutable router;
    address public immutable token0; // WETH
    address public immutable token1; // USDC (activo del vault)
    uint24 public immutable poolFee; // fee del pool de la posición
    uint24 public immutable swapFee; // fee del pool para reequilibrar

    uint8 private op; // 1 = deleverage, 2 = recenter (solo durante el flash)
    uint256 public lastTokenId;

    struct DeleverageArgs {
        uint256 tokenId;
        uint128 liquidity;
        uint256 minUsdcOut; // mínimo por vender el WETH retirado
        uint256 deadline;
    }

    struct RecenterArgs {
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        bool sellToken0; // true: vender WETH por USDC; false: vender USDC por WETH
        uint256 swapAmountIn;
        uint256 swapMinOut;
        uint256 deadline;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(
        address _owner,
        address _vault,
        address _npm,
        address _morpho,
        address _router,
        address _token0,
        address _token1,
        uint24 _poolFee,
        uint24 _swapFee
    ) {
        owner = _owner;
        vault = IRevertVault(_vault);
        npm = INPM(_npm);
        morpho = IMorphoFlash(_morpho);
        router = ISwapRouter02(_router);
        token0 = _token0;
        token1 = _token1;
        poolFee = _poolFee;
        swapFee = _swapFee;
        IERC20(_token1).approve(_vault, type(uint256).max);
        IERC20(_token1).approve(_morpho, type(uint256).max);
        IERC20(_token0).approve(_router, type(uint256).max);
        IERC20(_token1).approve(_router, type(uint256).max);
        IERC20(_token0).approve(_npm, type(uint256).max);
        IERC20(_token1).approve(_npm, type(uint256).max);
    }

    // ------------------------------------------------------------------ dueño

    function borrow(uint256 tokenId, uint256 amount, address to) external onlyOwner {
        vault.borrow(tokenId, amount);
        _transfer(token1, to, amount);
    }

    /// Repaga con el USDC que ya está en este contrato (el dueño lo envía antes).
    function repay(uint256 tokenId, uint256 amount) external onlyOwner returns (uint256 assets) {
        (assets,) = vault.repay(tokenId, amount, false);
    }

    function deleverage(DeleverageArgs calldata a, uint256 flashAmount) external onlyOwner {
        op = 1;
        morpho.flashLoan(token1, flashAmount, abi.encode(a));
        op = 0;
        // lo que sobra de USDC baja más la deuda (si aún hay deuda)
        uint256 extra = IERC20(token1).balanceOf(address(this));
        if (extra > 0 && vault.loans(a.tokenId) > 0) (extra,) = vault.repay(a.tokenId, extra, false);
        else extra = 0;
        emit Deleveraged(a.tokenId, flashAmount, a.liquidity, extra);
    }

    function recenter(RecenterArgs calldata a, uint256 flashAmount) external onlyOwner {
        op = 2;
        morpho.flashLoan(token1, flashAmount, abi.encode(a));
        op = 0;
    }

    function sweep(address token, address to, uint256 amount) external onlyOwner {
        _transfer(token, to, amount == 0 ? IERC20(token).balanceOf(address(this)) : amount);
    }

    /// Saca del vault un NFT sin deuda (p. ej. para cerrar la prueba) y lo manda al dueño.
    function removeTo(uint256 tokenId, address to) external onlyOwner {
        vault.remove(tokenId, to, "");
    }

    // ------------------------------------------------------------------ flashloan

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho) || op == 0) revert BadCallback();
        if (op == 1) _deleverage(assets, abi.decode(data, (DeleverageArgs)));
        else _recenter(assets, abi.decode(data, (RecenterArgs)));
        uint256 bal = IERC20(token1).balanceOf(address(this));
        if (bal < assets) revert InsufficientToRepayFlash(bal, assets);
        // Morpho cobra con transferFrom (allowance máxima desde el constructor)
    }

    function _deleverage(uint256 assets, DeleverageArgs memory a) internal {
        vault.repay(a.tokenId, assets, false);
        vault.decreaseLiquidityAndCollect(
            IRevertVault.DecreaseLiquidityAndCollectParams({
                tokenId: a.tokenId,
                liquidity: a.liquidity,
                amount0Min: 0,
                amount1Min: 0,
                feeAmount0: type(uint128).max,
                feeAmount1: type(uint128).max,
                deadline: a.deadline,
                recipient: address(this)
            })
        );
        uint256 w = IERC20(token0).balanceOf(address(this));
        if (w > 0) _swap(token0, token1, w, a.minUsdcOut);
    }

    function _recenter(uint256 assets, RecenterArgs memory a) internal {
        // 1) deuda a cero (todas las participaciones) y NFT de vuelta a este contrato
        uint256 shares = vault.loans(a.tokenId);
        if (shares > 0) vault.repay(a.tokenId, shares, true);
        vault.remove(a.tokenId, address(this), "");
        // 2) cerrar la posición
        (,,,,,,, uint128 liq,,,,) = npm.positions(a.tokenId);
        if (liq > 0) {
            npm.decreaseLiquidity(INPM.DecreaseLiquidityParams(a.tokenId, liq, 0, 0, a.deadline));
        }
        npm.collect(INPM.CollectParams(a.tokenId, address(this), type(uint128).max, type(uint128).max));
        // 3) reequilibrar para el rango nuevo
        if (a.swapAmountIn > 0) {
            if (a.sellToken0) _swap(token0, token1, a.swapAmountIn, a.swapMinOut);
            else _swap(token1, token0, a.swapAmountIn, a.swapMinOut);
        }
        // 4) nueva posición con todo el saldo, salvo lo necesario para devolver el flash (se pide prestado después)
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        (uint256 newId,,,) = npm.mint(
            INPM.MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: a.tickLower,
                tickUpper: a.tickUpper,
                amount0Desired: b0,
                amount1Desired: b1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: a.deadline
            })
        );
        // 5) al vault (dueño = este contrato) y borrow para devolver el flash
        npm.safeTransferFrom(address(this), address(vault), newId, "");
        uint256 have = IERC20(token1).balanceOf(address(this));
        uint256 need = have >= assets ? 0 : assets - have;
        if (need > 0) vault.borrow(newId, need);
        lastTokenId = newId;
        emit Recentered(a.tokenId, newId, a.tickLower, a.tickUpper, need);
    }

    // ------------------------------------------------------------------ NFTs (mint, remove del vault)

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(npm)) revert Unauthorized();
        return this.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ internos

    function _swap(address tIn, address tOut, uint256 amountIn, uint256 minOut) internal {
        router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tIn,
                tokenOut: tOut,
                fee: swapFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _transfer(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory r) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
    }
}
