// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Estrategia LP delta-neutral: posición Uniswap v3 WETH/cbBTC como colateral en Revert Lend (deuda USDC) y
/// cobertura en Compound v3 (colateral USDC, deuda WETH). Todo atómico con flashloan de USDC en Morpho (0 %).
///  - open:      USDC del dueño + flash → colateral en Compound → pide WETH → compra cbBTC → mint LP → Revert →
///               borrow USDC = flash → devuelve flash.
///  - recenter:  flash USDC → repaga Revert → saca NFT → cierra → reequilibra → mint centrado → Revert → borrow → flash.
///  - deleverage: flash USDC → repaga Revert → retira liquidez → cbBTC→WETH → repaga WETH en Compound →
///               retira USDC de Compound → devuelve flash. Reduce todo en proporción (sigue neutral).
///  - revertToComet / cometToRevert: mueve USDC entre los dos lados para equilibrar las saludes.
///  Solo el dueño opera. Los fondos solo salen al dueño (sweep / borrow).
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IMorphoFlash {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IComet {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
    function borrowBalanceOf(address account) external view returns (uint256);
    function collateralBalanceOf(address account, address asset) external view returns (uint128);
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

contract NeutralLpManager {
    error Unauthorized();
    error BadCallback();
    error InsufficientToRepayFlash(uint256 have, uint256 need);

    event Opened(uint256 indexed tokenId, uint256 usdcIn, uint256 flash, uint256 wethBorrowed);
    event Recentered(uint256 indexed oldTokenId, uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint256 borrowed);
    event Deleveraged(uint256 indexed tokenId, uint256 flash, uint128 liquidity, uint256 usdcWithdrawn, bool closed);

    address public immutable owner;
    IRevertVault public immutable vault;
    INPM public immutable npm;
    IMorphoFlash public immutable morpho;
    ISwapRouter02 public immutable router;
    IComet public immutable comet;
    address public immutable usdc;
    address public immutable token0; // WETH (base de Compound)
    address public immutable token1; // cbBTC
    uint24 public immutable poolFee; // pool de la posición (también se usa para reequilibrar)

    uint8 private op; // 1 open, 2 recenter, 3 deleverage
    uint256 public tokenId;

    struct OpenArgs {
        uint256 usdcIn; // USDC del dueño (transferFrom)
        uint256 borrowWeth; // WETH a pedir en Compound
        uint256 sellWeth; // WETH a vender por cbBTC
        uint256 minBtcOut;
        int24 tickLower;
        int24 tickUpper;
        uint256 deadline;
    }

    struct RecenterArgs {
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        bool sellToken0; // true: WETH→cbBTC
        uint256 swapAmountIn;
        uint256 swapMinOut;
        uint256 deadline;
    }

    struct DeleverageArgs {
        uint256 tokenId;
        uint128 liquidity;
        uint256 withdrawUsdc; // USDC a retirar de Compound (cubre el flash; lo que sobre repaga Revert)
        uint256 minWethOut; // por vender el cbBTC retirado
        bool close; // repaga toda la deuda de Revert y saca el NFT
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
        address _comet,
        address _usdc,
        address _token0,
        address _token1,
        uint24 _poolFee
    ) {
        owner = _owner;
        vault = IRevertVault(_vault);
        npm = INPM(_npm);
        morpho = IMorphoFlash(_morpho);
        router = ISwapRouter02(_router);
        comet = IComet(_comet);
        usdc = _usdc;
        token0 = _token0;
        token1 = _token1;
        poolFee = _poolFee;
        IERC20(_usdc).approve(_vault, type(uint256).max);
        IERC20(_usdc).approve(_morpho, type(uint256).max);
        IERC20(_usdc).approve(_comet, type(uint256).max);
        IERC20(_token0).approve(_comet, type(uint256).max);
        IERC20(_token0).approve(_router, type(uint256).max);
        IERC20(_token1).approve(_router, type(uint256).max);
        IERC20(_token0).approve(_npm, type(uint256).max);
        IERC20(_token1).approve(_npm, type(uint256).max);
    }

    // ------------------------------------------------------------------ dueño

    function open(OpenArgs calldata a, uint256 flashAmount) external onlyOwner {
        if (a.usdcIn > 0) require(IERC20(usdc).transferFrom(msg.sender, address(this), a.usdcIn), "transferFrom");
        op = 1;
        morpho.flashLoan(usdc, flashAmount, abi.encode(a));
        op = 0;
    }

    function recenter(RecenterArgs calldata a, uint256 flashAmount) external onlyOwner {
        op = 2;
        morpho.flashLoan(usdc, flashAmount, abi.encode(a));
        op = 0;
    }

    function deleverage(DeleverageArgs calldata a, uint256 flashAmount) external onlyOwner {
        op = 3;
        morpho.flashLoan(usdc, flashAmount, abi.encode(a));
        op = 0;
        uint256 extra = IERC20(usdc).balanceOf(address(this));
        if (!a.close && extra > 0 && vault.loans(a.tokenId) > 0) vault.repay(a.tokenId, extra, false);
    }

    /// Cripto subió: la deuda WETH crece → pide USDC en Revert (su colateral también subió) y lo pone en Compound.
    function revertToComet(uint256 id, uint256 amount) external onlyOwner {
        vault.borrow(id, amount);
        comet.supply(usdc, amount);
    }

    /// Cripto bajó: el colateral de Revert cae → saca USDC de Compound (la deuda WETH también bajó) y repaga Revert.
    function cometToRevert(uint256 id, uint256 amount) external onlyOwner {
        comet.withdraw(usdc, amount);
        vault.repay(id, amount, false);
    }

    function cometSupply(address asset, uint256 amount) external onlyOwner {
        comet.supply(asset, amount == 0 ? IERC20(asset).balanceOf(address(this)) : amount);
    }

    function cometWithdraw(address asset, uint256 amount) external onlyOwner {
        comet.withdraw(asset, amount);
    }

    function vaultRepay(uint256 id, uint256 amount) external onlyOwner {
        vault.repay(id, amount, false);
    }

    function vaultBorrow(uint256 id, uint256 amount) external onlyOwner {
        vault.borrow(id, amount);
        _transfer(usdc, owner, amount);
    }

    function removeTo(uint256 id) external onlyOwner {
        vault.remove(id, owner, "");
    }

    function sweep(address token, uint256 amount) external onlyOwner {
        _transfer(token, owner, amount == 0 ? IERC20(token).balanceOf(address(this)) : amount);
    }

    // ------------------------------------------------------------------ flashloan

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho) || op == 0) revert BadCallback();
        if (op == 1) _open(assets, abi.decode(data, (OpenArgs)));
        else if (op == 2) _recenter(assets, abi.decode(data, (RecenterArgs)));
        else _deleverage(assets, abi.decode(data, (DeleverageArgs)));
        uint256 bal = IERC20(usdc).balanceOf(address(this));
        if (bal < assets) revert InsufficientToRepayFlash(bal, assets);
    }

    function _open(uint256 assets, OpenArgs memory a) internal {
        comet.supply(usdc, a.usdcIn + assets);
        comet.withdraw(token0, a.borrowWeth); // préstamo de WETH
        if (a.sellWeth > 0) _swap(token0, token1, a.sellWeth, a.minBtcOut);
        uint256 id = _mintAll(a.tickLower, a.tickUpper, a.deadline);
        npm.safeTransferFrom(address(this), address(vault), id, "");
        vault.borrow(id, assets);
        _repayWethLeftover();
        tokenId = id;
        emit Opened(id, a.usdcIn, assets, a.borrowWeth);
    }

    function _recenter(uint256 assets, RecenterArgs memory a) internal {
        uint256 shares = vault.loans(a.tokenId);
        if (shares > 0) vault.repay(a.tokenId, shares, true);
        vault.remove(a.tokenId, address(this), "");
        (,,,,,,, uint128 liq,,,,) = npm.positions(a.tokenId);
        if (liq > 0) npm.decreaseLiquidity(INPM.DecreaseLiquidityParams(a.tokenId, liq, 0, 0, a.deadline));
        npm.collect(INPM.CollectParams(a.tokenId, address(this), type(uint128).max, type(uint128).max));
        if (a.swapAmountIn > 0) {
            if (a.sellToken0) _swap(token0, token1, a.swapAmountIn, a.swapMinOut);
            else _swap(token1, token0, a.swapAmountIn, a.swapMinOut);
        }
        uint256 id = _mintAll(a.tickLower, a.tickUpper, a.deadline);
        npm.safeTransferFrom(address(this), address(vault), id, "");
        uint256 have = IERC20(usdc).balanceOf(address(this));
        uint256 need = have >= assets ? 0 : assets - have;
        if (need > 0) vault.borrow(id, need);
        _repayWethLeftover();
        tokenId = id;
        emit Recentered(a.tokenId, id, a.tickLower, a.tickUpper, need);
    }

    function _deleverage(uint256 assets, DeleverageArgs memory a) internal {
        if (a.close) {
            uint256 shares = vault.loans(a.tokenId);
            if (shares > 0) vault.repay(a.tokenId, shares, true);
            vault.remove(a.tokenId, address(this), "");
            (,,,,,,, uint128 liq,,,,) = npm.positions(a.tokenId);
            if (liq > 0) npm.decreaseLiquidity(INPM.DecreaseLiquidityParams(a.tokenId, liq, 0, 0, a.deadline));
            npm.collect(INPM.CollectParams(a.tokenId, address(this), type(uint128).max, type(uint128).max));
        } else {
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
        }
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        if (b1 > 0) _swap(token1, token0, b1, a.minWethOut);
        _repayWethLeftover();
        if (a.withdrawUsdc > 0) comet.withdraw(usdc, a.withdrawUsdc);
        emit Deleveraged(a.tokenId, assets, a.liquidity, a.withdrawUsdc, a.close);
    }

    // ------------------------------------------------------------------ internos

    function _mintAll(int24 lower, int24 upper, uint256 deadline) internal returns (uint256 id) {
        (id,,,) = npm.mint(
            INPM.MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: IERC20(token0).balanceOf(address(this)),
                amount1Desired: IERC20(token1).balanceOf(address(this)),
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: deadline
            })
        );
    }

    /// WETH sobrante repaga la deuda de Compound (sin pasarse: lo que exceda la deuda se queda en el contrato).
    function _repayWethLeftover() internal {
        uint256 w = IERC20(token0).balanceOf(address(this));
        uint256 debt = comet.borrowBalanceOf(address(this));
        uint256 amt = w < debt ? w : debt;
        if (amt > 0) comet.supply(token0, amt);
    }

    function _swap(address tIn, address tOut, uint256 amountIn, uint256 minOut) internal {
        router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tIn,
                tokenOut: tOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(npm)) revert Unauthorized();
        return this.onERC721Received.selector;
    }

    function _transfer(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory r) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
    }
}
