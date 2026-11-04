// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {Quoter} from "../src/Quoter.sol";
import {IPoolManager} from "../src/interfaces/IExternal.sol";
import {
    MockERC20,
    MockV2Pair,
    MockV3Pool,
    MockMorpho,
    MockBalancerV3Vault,
    MockAavePool,
    MockV4PoolManager,
    MockWETH,
    MockMorphoBlue
} from "./mocks/Mocks.sol";

contract ArbExecutorTest is Test {
    ArbExecutor arb;
    MockERC20 weth;
    MockERC20 usdc;
    MockV2Pair cheap; // 1 WETH = 3000 USDC
    MockV2Pair rich; // 1 WETH = 3100 USDC
    MockV3Pool v3rich; // 1 WETH = 3100 USDC (precio fijo)
    MockV4PoolManager pm; // Uniswap v4: pool WETH/USDC fee 500, 1 WETH = 3100 USDC
    MockMorpho morpho;
    MockBalancerV3Vault vault;
    MockAavePool aave;

    address owner = address(0xA11CE);
    address stranger = address(0xBAD);

    function setUp() public {
        arb = new ArbExecutor(owner);
        weth = new MockERC20("WETH");
        usdc = new MockERC20("USDC");

        cheap = new MockV2Pair(address(weth), address(usdc));
        weth.mint(address(cheap), 100e18);
        usdc.mint(address(cheap), 300_000e18);
        cheap.sync();

        rich = new MockV2Pair(address(weth), address(usdc));
        weth.mint(address(rich), 100e18);
        usdc.mint(address(rich), 310_000e18);
        rich.sync();

        // precio = token1 por token0
        uint256 p = address(weth) < address(usdc) ? 3100e18 : uint256(1e36) / 3100e18;
        v3rich = new MockV3Pool(address(weth), address(usdc), p);
        weth.mint(address(v3rich), 1_000e18);
        usdc.mint(address(v3rich), 3_000_000e18);

        pm = new MockV4PoolManager();
        pm.initialize(_v4Key(), p);
        weth.mint(address(pm), 1_000e18);
        usdc.mint(address(pm), 3_000_000e18);

        morpho = new MockMorpho();
        vault = new MockBalancerV3Vault();
        aave = new MockAavePool();
        usdc.mint(address(morpho), 1_000_000e18);
        usdc.mint(address(vault), 1_000_000e18);
        usdc.mint(address(aave), 1_000_000e18);
    }

    // ---------------------------------------------------------------- helpers

    function _v4Key() internal view returns (MockV4PoolManager.PoolKey memory k) {
        (address c0, address c1) = address(weth) < address(usdc) ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        k = MockV4PoolManager.PoolKey(c0, c1, 500, 10, address(0));
    }

    function _v2Route() internal view returns (ArbExecutor.Hop[] memory hops) {
        hops = new ArbExecutor.Hop[](2);
        hops[0] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V2, address(cheap), address(usdc), address(weth), 30, 0, 0, "");
        hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V2, address(rich), address(weth), address(usdc), 30, 0, 0, "");
    }

    function _plan(ArbExecutor.Source s, address lender, uint256 amount, uint256 minProfit)
        internal
        view
        returns (ArbExecutor.Plan memory p)
    {
        p.source = s;
        p.lender = lender;
        p.token = address(usdc);
        p.amount = amount;
        p.minProfit = minProfit;
        p.hops = _v2Route();
    }

    // ---------------------------------------------------------------- casos felices

    function test_Morpho_ProfitGoesToOwner() public {
        vm.prank(owner);
        uint256 profit = arb.execute(_plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 1e18));
        assertGt(profit, 1e18);
        assertEq(usdc.balanceOf(owner), profit);
        assertEq(usdc.balanceOf(address(arb)), 0, "el contrato no guarda saldo");
        assertEq(usdc.balanceOf(address(morpho)), 1_000_000e18, "Morpho recupera el prestamo");
    }

    function test_BalancerV3_ProfitAndSettled() public {
        vm.prank(owner);
        uint256 profit = arb.execute(_plan(ArbExecutor.Source.BALANCER_V3, address(vault), 2_000e18, 1e18));
        assertGt(profit, 1e18);
        assertEq(usdc.balanceOf(address(vault)), 1_000_000e18);
    }

    function test_Aave_PremiumIsDeducted() public {
        vm.prank(owner);
        uint256 pAave = arb.execute(_plan(ArbExecutor.Source.AAVE_V3, address(aave), 2_000e18, 0));
        assertEq(usdc.balanceOf(address(aave)), 1_000_000e18 + 2_000e18 * 5 / 10_000, "Aave cobra 0.05%");
        assertGt(pAave, 0);
    }

    function test_ZeroFeeBeatsAave_SameRoute() public {
        // Mismo estado inicial para ambos: snapshot y comparación.
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        uint256 pMorpho = arb.execute(_plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 0));
        vm.revertToState(snap);
        vm.prank(owner);
        uint256 pAave = arb.execute(_plan(ArbExecutor.Source.AAVE_V3, address(aave), 2_000e18, 0));
        assertEq(pMorpho - pAave, 2_000e18 * 5 / 10_000);
    }

    function test_V3Flash_Uniswap_FeeIsPoolFee() public {
        // prestamista = pool v3 que no está en la ruta (v2 → v2); comisión 0.01 %
        MockV3Pool lenderPool = new MockV3Pool(address(weth), address(usdc), 3_000e18);
        usdc.mint(address(lenderPool), 500_000e18);
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        uint256 pMorpho = arb.execute(_plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 0));
        vm.revertToState(snap);
        vm.prank(owner);
        uint256 pFlash = arb.execute(_plan(ArbExecutor.Source.V3_FLASH, address(lenderPool), 2_000e18, 0));
        assertEq(pMorpho - pFlash, 2_000e18 / 10_000, "cuesta exactamente 1 bps");
        assertEq(usdc.balanceOf(address(lenderPool)), 500_000e18 + 2_000e18 / 10_000, "el pool cobra su comision");
        assertEq(usdc.balanceOf(address(arb)), 0);
    }

    function test_V3Flash_PancakeCallbackName() public {
        MockV3Pool lenderPool = new MockV3Pool(address(weth), address(usdc), 3_000e18);
        lenderPool.setPancake(true);
        usdc.mint(address(lenderPool), 500_000e18);
        vm.prank(owner);
        uint256 profit = arb.execute(_plan(ArbExecutor.Source.V3_FLASH, address(lenderPool), 2_000e18, 1e18));
        assertGt(profit, 1e18);
    }

    function test_V3Flash_Token1Borrow() public {
        // token prestado = el que sea token1 del pool prestamista (prueba ambos lados del flash)
        MockV3Pool lenderPool = new MockV3Pool(address(weth), address(usdc), 3_000e18);
        usdc.mint(address(lenderPool), 500_000e18);
        weth.mint(address(lenderPool), 500e18);
        vm.prank(owner);
        uint256 profit = arb.execute(_plan(ArbExecutor.Source.V3_FLASH, address(lenderPool), 2_000e18, 1e18));
        assertGt(profit, 1e18);
    }

    function test_RevertWhen_V3FlashLenderInRoute() public {
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.V3_FLASH, address(v3rich), 2_000e18, 0);
        p.hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V3, address(v3rich), address(weth), address(usdc), 0, 0, 0, "");
        usdc.mint(address(v3rich), 10_000e18);
        vm.prank(owner);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        arb.execute(p);
    }

    function test_RevertWhen_V3FlashCallbackFromStranger() public {
        vm.expectRevert(ArbExecutor.NotInFlash.selector);
        arb.pancakeV3FlashCallback(0, 0, abi.encode(_plan(ArbExecutor.Source.V3_FLASH, address(v3rich), 1, 0)));
    }

    function test_MixedRoute_V2ThenV3() public {
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 1e18);
        p.hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V3, address(v3rich), address(weth), address(usdc), 0, 0, 0, "");
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        assertGt(profit, 1e18);
    }

    function test_MixedRoute_V2ThenV4() public {
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 1e18);
        p.hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V4, address(pm), address(weth), address(usdc), 0, 500, 10, "");
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        // el mismo cálculo que el mock: salida = entrada·(1 − 0.05%)·3100
        assertGt(profit, 1e18);
        assertEq(pm.delta(address(weth)), 0);
        assertEq(pm.delta(address(usdc)), 0);
    }

    function test_V4_ExactAmounts() public {
        // USDC -> WETH en v2 barato, WETH -> USDC en v4: comparamos con la fórmula del mock al wei
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 0);
        p.hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V4, address(pm), address(weth), address(usdc), 0, 500, 10, "");
        (uint112 r0, uint112 r1,) = cheap.getReserves();
        (uint256 rIn, uint256 rOut) = address(usdc) < address(weth) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inFee = 2_000e18 * 9970;
        uint256 wethOut = inFee * rOut / (rIn * 10_000 + inFee);
        uint256 net = wethOut * (1_000_000 - 500) / 1_000_000;
        uint256 usdcOut = address(weth) < address(usdc) ? net * 3100e18 / 1e18 : net * 1e18 / (uint256(1e36) / 3100e18);
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        assertEq(profit, usdcOut - 2_000e18);
    }

    function test_V4_NativeEth_BothDirections() public {
        // Pool v4 ETH(nativo)/USDC: la ruta usa WETH; el contrato desenvuelve al pagar y envuelve al cobrar.
        MockWETH w = new MockWETH();
        vm.deal(address(w), 0);
        MockERC20 u = new MockERC20("USDC");
        MockV4PoolManager pm2 = new MockV4PoolManager();
        // currency0 = ETH nativo (address(0)), currency1 = USDC; precio = USDC por ETH
        pm2.initialize(MockV4PoolManager.PoolKey(address(0), address(u), 500, 10, address(0)), 3100e18);
        vm.deal(address(pm2), 1_000e18);
        u.mint(address(pm2), 3_000_000e18);
        // pool v2 barato WETH/USDC (3000) para cerrar el ciclo
        MockV2Pair c2 = new MockV2Pair(address(w), address(u));
        vm.deal(address(this), 100e18); w.deposit{value: 100e18}(); w.transfer(address(c2), 100e18);
        u.mint(address(c2), 300_000e18);
        c2.sync();
        MockMorpho m2 = new MockMorpho();
        u.mint(address(m2), 1_000_000e18);
        // USDC → WETH (v2 barato) → USDC (v4 nativo, ETH entra)
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V2, address(c2), address(u), address(w), 30, 0, 0, "");
        hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V4, address(pm2), address(w), address(u), 0, 500, 10, abi.encode(address(w)));
        ArbExecutor.Plan memory p = ArbExecutor.Plan(ArbExecutor.Source.MORPHO, address(m2), address(u), 2_000e18, 1e18, hops);
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        assertGt(profit, 1e18);
        assertEq(pm2.delta(address(0)), 0);
        assertEq(address(arb).balance, 0); // no queda ETH suelto
        // dirección contraria: USDC → WETH en v4 (ETH sale y se envuelve) → USDC en v2 caro
        MockV2Pair r2 = new MockV2Pair(address(w), address(u));
        vm.deal(address(this), 100e18); w.deposit{value: 100e18}(); w.transfer(address(r2), 100e18);
        u.mint(address(r2), 320_000e18);
        r2.sync();
        pm2.initialize(MockV4PoolManager.PoolKey(address(0), address(u), 500, 10, address(0)), 3000e18);
        hops[0] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V4, address(pm2), address(u), address(w), 0, 500, 10, abi.encode(address(w)));
        hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V2, address(r2), address(w), address(u), 30, 0, 0, "");
        p = ArbExecutor.Plan(ArbExecutor.Source.MORPHO, address(m2), address(u), 2_000e18, 1e18, hops);
        vm.prank(owner);
        profit = arb.execute(p);
        assertGt(profit, 1e18);
        assertEq(address(arb).balance, 0);
    }

    function test_V3_BothDirections() public {
        // USDC -> WETH por v3 (dirección contraria a la del otro test) y WETH -> USDC por v2 caro.
        uint256 pCheap = address(weth) < address(usdc) ? 3000e18 : uint256(1e36) / 3000e18;
        MockV3Pool v3cheap = new MockV3Pool(address(weth), address(usdc), pCheap);
        weth.mint(address(v3cheap), 1_000e18);
        usdc.mint(address(v3cheap), 3_000_000e18);
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 1e18);
        p.hops[0] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V3, address(v3cheap), address(usdc), address(weth), 0, 0, 0, "");
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        assertGt(profit, 1e18);
    }

    function test_RevertWhen_V4CallbackFromStranger() public {
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnexpectedCaller.selector);
        arb.unlockCallback("");
    }

    // ---------------------------------------------------------------- liquidaciones como saltos

    function test_AaveLiquidation_AsHop() public {
        // usuario con 10 WETH de colateral y 20,000 USDC de deuda; precio 1/3000 WETH por USDC; bono 5%
        address user = address(0xDEB7);
        aave.setPosition(user, address(usdc), address(weth), 20_000e18, 10e18, uint256(1e36) / 3000e18, 500);
        weth.mint(address(aave), 10e18);
        // flashloan USDC (Morpho) -> liquidar en Aave (USDC -> WETH con bono) -> vender WETH en el par rico -> devolver
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = ArbExecutor.Hop(ArbExecutor.DexKind.AAVE_LIQ, address(aave), address(usdc), address(weth), 0, 0, 0, abi.encode(user));
        hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V2, address(rich), address(weth), address(usdc), 30, 0, 0, "");
        ArbExecutor.Plan memory p = ArbExecutor.Plan(ArbExecutor.Source.MORPHO, address(morpho), address(usdc), 10_000e18, 0, hops);
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        // pagó 10,000 USDC, recibió 10000/3000·1.05 = 3.5 WETH, vendidos a ~3100 en el par rico (menos impacto y 0.3%)
        assertGt(profit, 400e18);
        assertEq(usdc.balanceOf(owner), profit);
    }

    function test_AaveLiquidation_CloseFactorLeavesDebtTokenUnused() public {
        address user = address(0xDEB7);
        aave.setPosition(user, address(usdc), address(weth), 20_000e18, 10e18, uint256(1e36) / 3000e18, 500);
        weth.mint(address(aave), 10e18);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = ArbExecutor.Hop(ArbExecutor.DexKind.AAVE_LIQ, address(aave), address(usdc), address(weth), 0, 0, 0, abi.encode(user));
        hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V2, address(rich), address(weth), address(usdc), 30, 0, 0, "");
        // pide 15,000 pero Aave solo acepta 10,000 (50%): el resto vuelve con el préstamo sin problema
        ArbExecutor.Plan memory p = ArbExecutor.Plan(ArbExecutor.Source.MORPHO, address(morpho), address(usdc), 15_000e18, 0, hops);
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        assertGt(profit, 400e18);
    }

    function test_MorphoLiquidation_AsHop() public {
        MockMorphoBlue mb = new MockMorphoBlue();
        // oráculo: precio del colateral (WETH) en préstamo (USDC) ×1e36 = 3000e18/1e18 ·1e36 => 3000e36
        mb.setMarket(3000e36, 1.05e18);
        address borrower = address(0xB0B);
        mb.setPosition(borrower, 2e18, 5_000e18);
        weth.mint(address(mb), 2e18);
        MockMorphoBlue.MarketParams memory mp = MockMorphoBlue.MarketParams(address(usdc), address(weth), address(0), address(0), 0.86e18);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = ArbExecutor.Hop(ArbExecutor.DexKind.MORPHO_LIQ, address(mb), address(usdc), address(weth), 0, 0, 0, abi.encode(mp, borrower, uint256(1e18)));
        hops[1] = ArbExecutor.Hop(ArbExecutor.DexKind.UNI_V2, address(rich), address(weth), address(usdc), 30, 0, 0, "");
        // 1 WETH incautado cuesta 3000/1.05 = 2857.14 USDC; se vende a ~3100 -> beneficio ≈ 200+
        ArbExecutor.Plan memory p = ArbExecutor.Plan(ArbExecutor.Source.MORPHO, address(morpho), address(usdc), 3_000e18, 100e18, hops);
        vm.prank(owner);
        uint256 profit = arb.execute(p);
        assertGt(profit, 200e18);
        assertEq(mb.collateralOf(borrower), 1e18);
    }

    // ---------------------------------------------------------------- cotizador

    function test_Quoter_V3AndV4() public {
        Quoter q = new Quoter();
        bool zfo = address(weth) < address(usdc);
        uint256 out = q.quoteV3(address(v3rich), zfo, 1e18);
        assertEq(out, 3100e18);
        uint256 out4 = q.quoteV4(address(pm), _v4KeyIPM(), zfo, 1e18);
        assertEq(out4, 3100e18 * (1_000_000 - 500) / 1_000_000);
    }

    function _v4KeyIPM() internal view returns (IPoolManager.PoolKey memory k) {
        (address c0, address c1) = address(weth) < address(usdc) ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        k = IPoolManager.PoolKey(c0, c1, 500, 10, address(0));
    }

    // ---------------------------------------------------------------- protecciones

    function test_RevertWhen_ProfitBelowMinimum() public {
        vm.prank(owner);
        vm.expectRevert();
        arb.execute(_plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 1_000_000e18));
    }

    function test_RevertWhen_RouteLoses() public {
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 0);
        // ruta invertida: compra caro, vende barato -> no alcanza para devolver
        p.hops[0].pool = address(rich);
        p.hops[1].pool = address(cheap);
        vm.prank(owner);
        vm.expectRevert();
        arb.execute(p);
    }

    function test_RevertWhen_NotOperator() public {
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 0);
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotOperator.selector);
        arb.execute(p);
    }

    function test_RevertWhen_CallbackCalledDirectly() public {
        bytes memory data = abi.encode(_plan(ArbExecutor.Source.MORPHO, address(morpho), 1e18, 0));
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotInFlash.selector);
        arb.onMorphoFlashLoan(1e18, data);

        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotInFlash.selector);
        arb.executeOperation(address(usdc), 1e18, 0, address(arb), data);
    }

    function test_RevertWhen_V3CallbackFromUnknownPool() public {
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnexpectedCaller.selector);
        arb.uniswapV3SwapCallback(1, 0, abi.encode(address(usdc)));
    }

    function test_RevertWhen_RouteDoesNotClose() public {
        ArbExecutor.Plan memory p = _plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 0);
        p.hops[1].tokenOut = address(weth);
        vm.prank(owner);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        arb.execute(p);
    }

    function test_OperatorCanExecute_ProfitStillGoesToOwner() public {
        vm.prank(owner);
        arb.setOperator(stranger, true);
        vm.prank(stranger);
        uint256 profit = arb.execute(_plan(ArbExecutor.Source.MORPHO, address(morpho), 2_000e18, 0));
        assertEq(usdc.balanceOf(owner), profit);
        assertEq(usdc.balanceOf(stranger), 0);
    }
}
