// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Estrategia LP delta-neutral v2 (cobertura completa): posición Uniswap v3 WETH/cbBTC como colateral en Revert Lend
/// (deuda USDC) y cobertura en Extra Finance XLend (copia de Aave v3): colateral USDC, deuda WETH + deuda cbBTC,
/// cada una por la parte de esa moneda que tiene el LP. Todo atómico con flashloan de USDC en Morpho (0 %).
///  - open:       USDC del dueño + flash → colateral en XLend → pide WETH y cbBTC → mint LP → Revert → borrow USDC = flash.
///  - recenter:   flash USDC → repaga Revert → saca NFT → cierra → reequilibra → mint centrado → Revert → borrow → flash.
///  - deleverage: flash USDC → repaga Revert → retira liquidez → cada moneda repaga su deuda en XLend (swap opcional
///                del sobrante hacia la otra deuda) → retira USDC de XLend → devuelve flash.
///  - revertToXlend / xlendToRevert: mueve USDC entre los dos lados para equilibrar las saludes.
///  - trimDebt:   retira USDC de XLend, compra WETH (o cbBTC vía WETH) y repaga esa deuda.
///  Solo el dueño opera. Los fondos solo salen al dueño (sweep / vaultBorrow / removeTo).
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IMorphoFlash {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// Pool de Aave v3 (XLend).
interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
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

contract NeutralLpManagerV2 {
    error Unauthorized();
    error BadCallback();
    error BadToken();
    error InsufficientToRepayFlash(uint256 have, uint256 need);

    event Opened(uint256 indexed tokenId, uint256 usdcIn, uint256 flash, uint256 borrowed0, uint256 borrowed1);
    event Recentered(uint256 indexed oldTokenId, uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint256 borrowed);
    event Deleveraged(uint256 indexed tokenId, uint256 flash, uint128 liquidity, uint256 usdcWithdrawn, bool closed);

    uint256 private constant VARIABLE = 2; // modo de tasa variable de Aave v3
    uint24 private constant USDC_WETH_FEE = 500; // pool WETH/USDC 0.05 % para trimDebt

    address public immutable owner;
    IRevertVault public immutable vault;
    INPM public immutable npm;
    IMorphoFlash public immutable morpho;
    ISwapRouter02 public immutable router;
    IPool public immutable pool; // XLend
    address public immutable usdc;
    address public immutable token0; // WETH
    address public immutable token1; // cbBTC
    address public immutable debt0; // token de deuda variable de WETH en XLend
    address public immutable debt1; // token de deuda variable de cbBTC en XLend
    uint24 public immutable poolFee; // pool de la posición (también se usa para reequilibrar)

    uint8 private op; // 1 open, 2 recenter, 3 deleverage
    uint256 public tokenId;

    struct OpenArgs {
        uint256 usdcIn; // USDC del dueño (transferFrom)
        uint256 borrow0; // WETH a pedir en XLend
        uint256 borrow1; // cbBTC a pedir en XLend
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
        uint256 withdrawUsdc; // USDC a retirar de XLend (cubre el flash; lo que sobre repaga Revert)
        bool sellToken0; // swap opcional del sobrante tras repagar cada deuda con su moneda
        uint256 swapAmountIn; // 0 = sin swap; se limita al saldo
        uint256 swapMinOut;
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
        address _pool,
        address _usdc,
        address _token0,
        address _token1,
        uint24 _poolFee,
        address _debt0,
        address _debt1
    ) {
        owner = _owner;
        vault = IRevertVault(_vault);
        npm = INPM(_npm);
        morpho = IMorphoFlash(_morpho);
        router = ISwapRouter02(_router);
        pool = IPool(_pool);
        usdc = _usdc;
        token0 = _token0;
        token1 = _token1;
        poolFee = _poolFee;
        debt0 = _debt0;
        debt1 = _debt1;
        IERC20(_usdc).approve(_vault, type(uint256).max);
        IERC20(_usdc).approve(_morpho, type(uint256).max);
        IERC20(_usdc).approve(_pool, type(uint256).max);
        IERC20(_usdc).approve(_router, type(uint256).max);
        IERC20(_token0).approve(_pool, type(uint256).max);
        IERC20(_token1).approve(_pool, type(uint256).max);
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

    /// Cripto subió: las deudas WETH/cbBTC crecen → pide USDC en Revert (su colateral también subió) y lo pone en XLend.
    function revertToXlend(uint256 id, uint256 amount) external onlyOwner {
        vault.borrow(id, amount);
        pool.supply(usdc, amount, address(this), 0);
    }

    /// Cripto bajó: el colateral de Revert cae → saca USDC de XLend (las deudas también bajaron) y repaga Revert.
    function xlendToRevert(uint256 id, uint256 amount) external onlyOwner {
        pool.withdraw(usdc, amount, address(this));
        vault.repay(id, amount, false);
    }

    /// Retira USDC de XLend, compra WETH (y, si `token` es cbBTC, lo cambia a cbBTC) y repaga esa deuda.
    function trimDebt(address token, uint256 usdcAmount, uint256 minOut) external onlyOwner {
        if (token != token0 && token != token1) revert BadToken();
        pool.withdraw(usdc, usdcAmount, address(this));
        uint256 got = _swapFee(usdc, token0, USDC_WETH_FEE, usdcAmount, token == token0 ? minOut : 0);
        if (token == token1) _swapFee(token0, token1, poolFee, got, minOut);
        _repayLeftovers();
    }

    function xlendSupply(address asset, uint256 amount) external onlyOwner {
        pool.supply(asset, amount == 0 ? IERC20(asset).balanceOf(address(this)) : amount, address(this), 0);
    }

    /// amount = type(uint256).max retira todo (solo sin deuda).
    function xlendWithdraw(address asset, uint256 amount) external onlyOwner {
        pool.withdraw(asset, amount, address(this));
    }

    function xlendRepayLeftovers() external onlyOwner {
        _repayLeftovers();
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
        pool.supply(usdc, a.usdcIn + assets, address(this), 0);
        if (a.borrow0 > 0) pool.borrow(token0, a.borrow0, VARIABLE, 0, address(this));
        if (a.borrow1 > 0) pool.borrow(token1, a.borrow1, VARIABLE, 0, address(this));
        uint256 id = _mintAll(a.tickLower, a.tickUpper, a.deadline);
        npm.safeTransferFrom(address(this), address(vault), id, "");
        vault.borrow(id, assets);
        _repayLeftovers();
        tokenId = id;
        emit Opened(id, a.usdcIn, assets, a.borrow0, a.borrow1);
    }

    function _recenter(uint256 assets, RecenterArgs memory a) internal {
        uint256 shares = vault.loans(a.tokenId);
        if (shares > 0) vault.repay(a.tokenId, shares, true);
        vault.remove(a.tokenId, address(this), "");
        (,,,,,,, uint128 liq,,,,) = npm.positions(a.tokenId);
        if (liq > 0) npm.decreaseLiquidity(INPM.DecreaseLiquidityParams(a.tokenId, liq, 0, 0, a.deadline));
        npm.collect(INPM.CollectParams(a.tokenId, address(this), type(uint128).max, type(uint128).max));
        if (a.swapAmountIn > 0) {
            if (a.sellToken0) _swapFee(token0, token1, poolFee, a.swapAmountIn, a.swapMinOut);
            else _swapFee(token1, token0, poolFee, a.swapAmountIn, a.swapMinOut);
        }
        uint256 id = _mintAll(a.tickLower, a.tickUpper, a.deadline);
        npm.safeTransferFrom(address(this), address(vault), id, "");
        uint256 have = IERC20(usdc).balanceOf(address(this));
        uint256 need = have >= assets ? 0 : assets - have;
        if (need > 0) vault.borrow(id, need);
        _repayLeftovers();
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
        _repayLeftovers(); // cada moneda repaga su propia deuda
        if (a.swapAmountIn > 0) {
            address tIn = a.sellToken0 ? token0 : token1;
            uint256 bal = IERC20(tIn).balanceOf(address(this));
            uint256 amt = a.swapAmountIn < bal ? a.swapAmountIn : bal;
            if (amt > 0) {
                _swapFee(tIn, a.sellToken0 ? token1 : token0, poolFee, amt, a.swapAmountIn == amt ? a.swapMinOut : 0);
                _repayLeftovers();
            }
        }
        if (a.withdrawUsdc > 0) pool.withdraw(usdc, a.withdrawUsdc, address(this));
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

    /// WETH y cbBTC sobrantes repagan su propia deuda en XLend (sin pasarse: lo que exceda la deuda se queda en el contrato).
    function _repayLeftovers() internal {
        _repayOne(token0, debt0);
        _repayOne(token1, debt1);
    }

    function _repayOne(address token, address debtToken) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 debt = IERC20(debtToken).balanceOf(address(this));
        uint256 amt = bal < debt ? bal : debt;
        if (amt > 0) pool.repay(token, amt, VARIABLE, address(this));
    }

    function _swapFee(address tIn, address tOut, uint24 fee, uint256 amountIn, uint256 minOut) internal returns (uint256) {
        return router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tIn,
                tokenOut: tOut,
                fee: fee,
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
