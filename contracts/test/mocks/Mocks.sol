// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Mocks mínimos para probar ArbExecutor sin red.

contract MockERC20 {
    string public name;
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n) {
        name = n;
    }

    function symbol() external view returns (string memory) {
        return name;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
        emit Transfer(address(0), to, a);
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        emit Transfer(msg.sender, to, a);
        return true;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        emit Transfer(f, t, a);
        return true;
    }
}

/// Par constante-producto estilo UniswapV2 con comisión de 0.30%.
contract MockV2Pair {
    event Sync(uint112 reserve0, uint112 reserve1);
    event Swap(address indexed sender, uint256 a0In, uint256 a1In, uint256 a0Out, uint256 a1Out, address indexed to);
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);

    /// Aporta lo que ya se transfirió al par (como UniswapV2Pair.mint) y emite Mint.
    function mint(address) external {
        uint256 b0 = MockERC20(token0).balanceOf(address(this));
        uint256 b1 = MockERC20(token1).balanceOf(address(this));
        emit Mint(msg.sender, b0 - r0, b1 - r1);
        r0 = uint112(b0);
        r1 = uint112(b1);
        emit Sync(r0, r1);
    }

    /// Retira `amount0`/`amount1` a `to` (simplificado: sin LP tokens) y emite Burn.
    function burn(address to, uint256 amount0, uint256 amount1) external {
        if (amount0 > 0) MockERC20(token0).transfer(to, amount0);
        if (amount1 > 0) MockERC20(token1).transfer(to, amount1);
        r0 = uint112(MockERC20(token0).balanceOf(address(this)));
        r1 = uint112(MockERC20(token1).balanceOf(address(this)));
        emit Burn(msg.sender, amount0, amount1, to);
        emit Sync(r0, r1);
    }

    address public token0;
    address public token1;
    uint112 internal r0;
    uint112 internal r1;
    uint256 public feeBps = 30;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function sync() external {
        r0 = uint112(MockERC20(token0).balanceOf(address(this)));
        r1 = uint112(MockERC20(token1).balanceOf(address(this)));
        emit Sync(r0, r1);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, 0);
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        if (out0 > 0) MockERC20(token0).transfer(to, out0);
        if (out1 > 0) MockERC20(token1).transfer(to, out1);
        uint256 b0 = MockERC20(token0).balanceOf(address(this));
        uint256 b1 = MockERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        uint256 adj0 = b0 * 10000 - in0 * feeBps;
        uint256 adj1 = b1 * 10000 - in1 * feeBps;
        require(adj0 * adj1 >= uint256(r0) * uint256(r1) * 1e8, "K");
        r0 = uint112(b0);
        r1 = uint112(b1);
        emit Sync(r0, r1);
        emit Swap(msg.sender, in0, in1, out0, out1, to);
    }
}

interface IV3Cb {
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
}

/// Pool "V3" simplificado: precio fijo (token1 por token0, escala 1e18), cobra vía callback.
interface IV3Flash {
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external;
    function pancakeV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external;
}

contract MockV3Pool {
    address public token0;
    address public token1;
    uint256 public price; // token1 por token0 * 1e18

    constructor(address a, address b, uint256 p) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        price = p;
    }

    uint160 constant MIN_SQRT_RATIO = 4295128739;
    uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint24 public flashFeePips = 100; // 0.01 %
    bool public pancake;
    bool private locked;
    function setPancake(bool v) external { pancake = v; }

    /// Como UniswapV3Pool.flash: presta, llama al callback y exige saldo + comisión; bloquea el pool mientras tanto.
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        require(!locked, "LOK");
        locked = true;
        uint256 fee0 = (amount0 * flashFeePips + 999_999) / 1e6;
        uint256 fee1 = (amount1 * flashFeePips + 999_999) / 1e6;
        uint256 b0 = MockERC20(token0).balanceOf(address(this));
        uint256 b1 = MockERC20(token1).balanceOf(address(this));
        if (amount0 > 0) MockERC20(token0).transfer(recipient, amount0);
        if (amount1 > 0) MockERC20(token1).transfer(recipient, amount1);
        if (pancake) IV3Flash(msg.sender).pancakeV3FlashCallback(fee0, fee1, data);
        else IV3Flash(msg.sender).uniswapV3FlashCallback(fee0, fee1, data);
        require(MockERC20(token0).balanceOf(address(this)) >= b0 + fee0, "F0");
        require(MockERC20(token1).balanceOf(address(this)) >= b1 + fee1, "F1");
        locked = false;
    }

    uint160 public sqrtPriceX96 = 79228162514264337593543950336; // 2^96: precio 1 en el espacio de √P (solo para validar el límite)

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 a0, int256 a1)
    {
        require(!locked, "LOK");
        // misma validación que UniswapV3Pool.swap
        require(
            zeroForOne
                ? sqrtPriceLimitX96 < sqrtPriceX96 && sqrtPriceLimitX96 > MIN_SQRT_RATIO
                : sqrtPriceLimitX96 > sqrtPriceX96 && sqrtPriceLimitX96 < MAX_SQRT_RATIO,
            "SPL"
        );
        uint256 amtIn = uint256(amountSpecified);
        if (zeroForOne) {
            uint256 out = amtIn * price / 1e18;
            MockERC20(token1).transfer(recipient, out);
            uint256 before = MockERC20(token0).balanceOf(address(this));
            IV3Cb(msg.sender).uniswapV3SwapCallback(int256(amtIn), -int256(out), data);
            require(MockERC20(token0).balanceOf(address(this)) >= before + amtIn, "IIA");
            return (int256(amtIn), -int256(out));
        } else {
            uint256 out = amtIn * 1e18 / price;
            MockERC20(token0).transfer(recipient, out);
            uint256 before = MockERC20(token1).balanceOf(address(this));
            IV3Cb(msg.sender).uniswapV3SwapCallback(-int256(out), int256(amtIn), data);
            require(MockERC20(token1).balanceOf(address(this)) >= before + amtIn, "IIA");
            return (-int256(out), int256(amtIn));
        }
    }
}

interface IMorphoCb {
    function onMorphoFlashLoan(uint256, bytes calldata) external;
}

contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        MockERC20(token).transfer(msg.sender, assets);
        IMorphoCb(msg.sender).onMorphoFlashLoan(assets, data);
        MockERC20(token).transferFrom(msg.sender, address(this), assets);
    }
}

contract MockBalancerV3Vault {
    mapping(address => int256) public delta; // debe quedar en 0 al cerrar unlock
    mapping(address => uint256) internal reserves;
    address[] internal touched;

    function unlock(bytes calldata data) external returns (bytes memory r) {
        (bool ok, bytes memory ret) = msg.sender.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        for (uint256 i; i < touched.length; ++i) {
            require(delta[touched[i]] == 0, "BalanceNotSettled");
        }
        delete touched;
        return ret;
    }

    function sendTo(address token, address to, uint256 amount) external {
        reserves[token] = MockERC20(token).balanceOf(address(this)) - amount;
        delta[token] -= int256(amount);
        touched.push(token);
        MockERC20(token).transfer(to, amount);
    }

    function settle(address token, uint256 hint) external returns (uint256 credit) {
        uint256 bal = MockERC20(token).balanceOf(address(this));
        credit = bal - reserves[token];
        if (credit > hint) credit = hint;
        reserves[token] += credit;
        delta[token] += int256(credit);
    }
}

interface IAaveCb {
    function executeOperation(address, uint256, uint256, address, bytes calldata) external returns (bool);
}

contract MockAavePool {
    uint256 public premiumBps = 5; // 0.05%

    // posición liquidable simulada: deuda en `debt`, colateral en `col`, precio = colateral por unidad de deuda ×1e18
    struct Pos { address debt; address col; uint256 debtAmount; uint256 colAmount; uint256 price; uint256 bonusBps; }
    mapping(address => Pos) public pos;

    function setPosition(address user, address debt, address col, uint256 debtAmount, uint256 colAmount, uint256 price, uint256 bonusBps) external {
        pos[user] = Pos(debt, col, debtAmount, colAmount, price, bonusBps);
    }

    /// Como Aave: paga hasta el 50% de la deuda (close factor), entrega colateral = pagado × precio × (1 + bono).
    function liquidationCall(address col, address debt, address user, uint256 debtToCover, bool) external {
        Pos storage p = pos[user];
        require(p.debt == debt && p.col == col, "pos");
        uint256 maxCover = p.debtAmount / 2;
        uint256 cover = debtToCover < maxCover ? debtToCover : maxCover;
        uint256 colOut = cover * p.price / 1e18 * (10_000 + p.bonusBps) / 10_000;
        require(colOut <= p.colAmount, "col");
        MockERC20(debt).transferFrom(msg.sender, address(this), cover);
        MockERC20(col).transfer(msg.sender, colOut);
        p.debtAmount -= cover;
        p.colAmount -= colOut;
    }

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16)
        external
    {
        uint256 premium = amount * premiumBps / 10_000;
        MockERC20(asset).transfer(receiver, amount);
        require(IAaveCb(receiver).executeOperation(asset, amount, premium, msg.sender, params), "cb");
        MockERC20(asset).transferFrom(receiver, address(this), amount + premium);
    }
}

interface IUnlockCb {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// PoolManager de Uniswap v4 simplificado: precio fijo por pool (como MockV3Pool), contabilidad flash
/// por moneda (sync/settle/take) y verificación de que todo queda en cero al cerrar unlock.
contract MockV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    mapping(bytes32 => uint256) public price; // token1 por token0 * 1e18
    mapping(address => int256) public delta; // por moneda, del locker en curso
    mapping(address => uint256) internal synced;
    address internal syncedCurrency;
    address[] internal touched;
    bool public unlocked;

    function poolId(PoolKey memory k) public pure returns (bytes32) {
        return keccak256(abi.encode(k));
    }

    function initialize(PoolKey memory k, uint256 p) external {
        price[poolId(k)] = p;
    }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        r = IUnlockCb(msg.sender).unlockCallback(data);
        for (uint256 i; i < touched.length; ++i) {
            require(delta[touched[i]] == 0, "CurrencyNotSettled");
        }
        delete touched;
        unlocked = false;
    }

    function _touch(address c, int256 d) internal {
        if (delta[c] == 0) touched.push(c);
        delta[c] += d;
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (int256 d) {
        require(unlocked, "ManagerLocked");
        uint256 p = price[poolId(key)];
        require(p != 0, "PoolNotInitialized");
        require(params.amountSpecified < 0, "exact input only");
        uint256 amtIn = uint256(-params.amountSpecified);
        // comisión en pips sobre la entrada, como v3/v4
        uint256 amtInNet = amtIn * (1_000_000 - key.fee) / 1_000_000;
        int128 a0;
        int128 a1;
        if (params.zeroForOne) {
            uint256 out = amtInNet * p / 1e18;
            a0 = -int128(int256(amtIn));
            a1 = int128(int256(out));
            _touch(key.currency0, a0);
            _touch(key.currency1, a1);
        } else {
            uint256 out = amtInNet * 1e18 / p;
            a1 = -int128(int256(amtIn));
            a0 = int128(int256(out));
            _touch(key.currency0, a0);
            _touch(key.currency1, a1);
        }
        d = (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function sync(address currency) external {
        syncedCurrency = currency;
        if (currency != address(0)) synced[currency] = MockERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        address c = syncedCurrency;
        if (c == address(0)) paid = msg.value; // moneda nativa: se paga con msg.value, como el PoolManager real
        else { require(msg.value == 0, "NonzeroNativeValue"); paid = MockERC20(c).balanceOf(address(this)) - synced[c]; }
        _touch(c, int256(paid));
        syncedCurrency = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        _touch(currency, -int256(amount));
        if (currency == address(0)) { (bool ok,) = to.call{value: amount}(""); require(ok, "native take"); }
        else MockERC20(currency).transfer(to, amount);
    }

    receive() external payable {}
}

/// Estrategia de Beefy simplificada: harvest() paga callReward en WETH (native) a quien llama.
contract MockBeefyStrategy {
    address public native;
    uint256 public reward;
    uint256 public lastHarvest;
    bool public paused;

    constructor(address _native, uint256 _reward) {
        native = _native;
        reward = _reward;
    }

    function callReward() external view returns (uint256) {
        return paused ? 0 : reward;
    }

    function harvest(address callFeeRecipient) public {
        require(!paused, "paused");
        MockERC20(native).transfer(callFeeRecipient, reward);
        lastHarvest = block.timestamp;
        reward = 0;
    }

    function harvest() external {
        harvest(tx.origin);
    }

    function setReward(uint256 r) external {
        reward = r;
    }
}


/// Morpho Blue simplificado para liquidaciones: entrega `seizedAssets` de colateral y cobra el préstamo
/// equivalente (seized × precio / LIF) con transferFrom tras el callback.
contract MockMorphoBlue {
    struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }
    uint256 public price; // precio del colateral en préstamo, ×1e36 (como el oráculo de Morpho)
    uint256 public lifWad; // factor de incentivo ×1e18 (p. ej. 1.05e18)
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public borrowedOf;

    function setMarket(uint256 _price, uint256 _lif) external { price = _price; lifWad = _lif; }
    function setPosition(address borrower, uint256 collateral, uint256 borrowed) external { collateralOf[borrower] = collateral; borrowedOf[borrower] = borrowed; }

    function liquidate(MarketParams memory mp, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes memory)
        external
        returns (uint256 seized, uint256 repaid)
    {
        require(repaidShares == 0 && seizedAssets > 0, "seized only");
        require(seizedAssets <= collateralOf[borrower], "too much");
        seized = seizedAssets;
        // repaid = seized · price / LIF  (redondeo hacia arriba como Morpho)
        uint256 quoted = seized * price / 1e36;
        repaid = (quoted * 1e18 + lifWad - 1) / lifWad;
        collateralOf[borrower] -= seized;
        borrowedOf[borrower] = borrowedOf[borrower] > repaid ? borrowedOf[borrower] - repaid : 0;
        MockERC20(mp.collateralToken).transfer(msg.sender, seized);
        MockERC20(mp.loanToken).transferFrom(msg.sender, address(this), repaid);
    }
}

/// Morpho completo para pruebas locales: flashloan + liquidate en la misma dirección (como el real).
contract MockMorphoFull is MockMorpho, MockMorphoBlue {}

/// WETH con deposit/withdraw reales (para pools v4 con ETH nativo).
contract MockWETH is MockERC20 {
    constructor() MockERC20("WETH") {}
    function deposit() external payable { balanceOf[msg.sender] += msg.value; emit Transfer(address(0), msg.sender, msg.value); }
    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        emit Transfer(msg.sender, address(0), a);
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "withdraw");
    }
}
