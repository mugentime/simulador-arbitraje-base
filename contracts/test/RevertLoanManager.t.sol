// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RevertLoanManager, IRevertVault, INPM, ISwapRouter02} from "../src/RevertLoanManager.sol";

contract T20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

interface IFlashCb { function onMorphoFlashLoan(uint256, bytes calldata) external; }

contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        T20(token).transfer(msg.sender, assets);
        IFlashCb(msg.sender).onMorphoFlashLoan(assets, data);
        T20(token).transferFrom(msg.sender, address(this), assets);
    }
}

/// Router: 1 WETH = 2000 USDC (sin comisión)
contract MockRouter {
    T20 public w; T20 public u;
    constructor(T20 _w, T20 _u) { w = _w; u = _u; }
    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external returns (uint256 out) {
        T20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = p.tokenIn == address(w) ? p.amountIn * 2000 / 1e12 : p.amountIn * 1e12 / 2000;
        require(out >= p.amountOutMinimum, "minOut");
        T20(p.tokenOut).transfer(p.recipient, out);
    }
}

interface IRecv { function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4); }

/// NPM: cada posición guarda WETH/USDC "dentro"; liquidez = valor en USDC (6 dec) para simplificar.
contract MockNPM {
    T20 public w; T20 public u; uint256 public next = 100;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint256) public in0; mapping(uint256 => uint256) public in1; mapping(uint256 => uint128) public liq;
    mapping(uint256 => uint256) public owed0; mapping(uint256 => uint256) public owed1;
    constructor(T20 _w, T20 _u) { w = _w; u = _u; }
    function seed(uint256 id, address o, uint256 a0, uint256 a1) external { ownerOf[id] = o; in0[id] = a0; in1[id] = a1; liq[id] = uint128(a0 * 2000 / 1e12 + a1); w.mint(address(this), a0); u.mint(address(this), a1); }
    function positions(uint256 id) external view returns (uint96, address, address, address, uint24, int24, int24, uint128 l, uint256, uint256, uint128, uint128) {
        l = liq[id];
    }
    function decreaseLiquidity(INPM.DecreaseLiquidityParams calldata p) external returns (uint256 a0, uint256 a1) {
        a0 = in0[p.tokenId] * p.liquidity / liq[p.tokenId]; a1 = in1[p.tokenId] * p.liquidity / liq[p.tokenId];
        in0[p.tokenId] -= a0; in1[p.tokenId] -= a1; liq[p.tokenId] -= p.liquidity; owed0[p.tokenId] += a0; owed1[p.tokenId] += a1;
    }
    function collect(INPM.CollectParams calldata p) external returns (uint256 a0, uint256 a1) {
        a0 = owed0[p.tokenId]; a1 = owed1[p.tokenId]; owed0[p.tokenId] = 0; owed1[p.tokenId] = 0;
        w.transfer(p.recipient, a0); u.transfer(p.recipient, a1);
    }
    function mint(INPM.MintParams calldata p) external returns (uint256 id, uint128 l, uint256 a0, uint256 a1) {
        id = next++; a0 = p.amount0Desired; a1 = p.amount1Desired;
        w.transferFrom(msg.sender, address(this), a0); u.transferFrom(msg.sender, address(this), a1);
        in0[id] = a0; in1[id] = a1; l = uint128(a0 * 2000 / 1e12 + a1); liq[id] = l; ownerOf[id] = p.recipient;
    }
    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) public {
        require(ownerOf[id] == from && (msg.sender == from || msg.sender == to), "owner");
        ownerOf[id] = to;
        if (to.code.length > 0) IRecv(to).onERC721Received(msg.sender, from, id, data);
    }
    function valueOf(uint256 id) external view returns (uint256) { return in0[id] * 2000 / 1e12 + in1[id]; }
}

/// Vault: deuda en USDC 1:1 con participaciones; colateral = 77.5 % del valor; borrow/decrease exigen deuda ≤ 95 % del colateral.
contract MockVault {
    T20 public u; MockNPM public npm;
    mapping(uint256 => uint256) public loans; mapping(uint256 => address) public tokenOwner;
    constructor(T20 _u, MockNPM _n) { u = _u; npm = _n; }
    function onERC721Received(address, address from, uint256 id, bytes calldata data) external returns (bytes4) {
        tokenOwner[id] = data.length > 0 ? abi.decode(data, (address)) : from; return this.onERC721Received.selector;
    }
    function _healthy(uint256 id) internal view { require(loans[id] * 100 <= npm.valueOf(id) * 775 / 1000 * 95, "unhealthy"); }
    function borrow(uint256 id, uint256 a) external { require(tokenOwner[id] == msg.sender, "auth"); loans[id] += a; _healthy(id); u.transfer(msg.sender, a); }
    function repay(uint256 id, uint256 a, bool) external returns (uint256, uint256) { if (a > loans[id]) a = loans[id]; require(a > 0, "NoShares"); u.transferFrom(msg.sender, address(this), a); loans[id] -= a; return (a, a); }
    function decreaseLiquidityAndCollect(IRevertVault.DecreaseLiquidityAndCollectParams calldata p) external returns (uint256 a0, uint256 a1) {
        require(tokenOwner[p.tokenId] == msg.sender, "auth");
        npm.decreaseLiquidity(INPM.DecreaseLiquidityParams(p.tokenId, p.liquidity, 0, 0, p.deadline));
        (a0, a1) = npm.collect(INPM.CollectParams(p.tokenId, p.recipient, type(uint128).max, type(uint128).max));
        _healthy(p.tokenId);
    }
    function remove(uint256 id, address to, bytes calldata) external { require(tokenOwner[id] == msg.sender && loans[id] == 0, "remove"); tokenOwner[id] = address(0); npm.safeTransferFrom(address(this), to, id, ""); }
}

contract RevertLoanManagerTest is Test {
    T20 w; T20 u; MockMorpho m; MockRouter r; MockNPM n; MockVault v; RevertLoanManager mgr;
    address me = address(0xBEEF);

    function setUp() public {
        w = new T20(); u = new T20(); m = new MockMorpho(); r = new MockRouter(w, u); n = new MockNPM(w, u); v = new MockVault(u, n);
        u.mint(address(m), 1_000_000e6); u.mint(address(r), 1_000_000e6); w.mint(address(r), 1_000e18); u.mint(address(v), 1_000_000e6);
        mgr = new RevertLoanManager(me, address(v), address(n), address(m), address(r), address(w), address(u), 3000, 500);
        // posición $30: 0.0075 WETH ($15) + 15 USDC, del dueño → vault con dueño = manager
        n.seed(1, me, 0.0075e18, 15e6);
        vm.prank(me); n.safeTransferFrom(me, address(v), 1, abi.encode(address(mgr)));
        assertEq(v.tokenOwner(1), address(mgr));
        vm.prank(me); mgr.borrow(1, 22e6, me); // 73.3 % del valor
        assertEq(u.balanceOf(me), 22e6);
    }

    function test_onlyOwner() public {
        vm.expectRevert(RevertLoanManager.Unauthorized.selector); mgr.borrow(1, 1, address(this));
        vm.expectRevert(RevertLoanManager.BadCallback.selector); mgr.onMorphoFlashLoan(1, "");
    }

    function test_deleverage_flash() public {
        // el precio no cambia en el mock; se repagan $3 retirando ~$3.1 de valor
        uint128 l = uint128(uint256(n.liq(1)) * 31 / 300);
        vm.prank(me);
        mgr.deleverage(RevertLoanManager.DeleverageArgs({tokenId: 1, liquidity: l, minUsdcOut: 0, deadline: block.timestamp}), 3e6);
        assertLt(v.loans(1), 19e6 + 1); // 22 − 3 − sobrante
        assertEq(u.balanceOf(address(m)), 1_000_000e6); // flash devuelto completo
        assertEq(u.balanceOf(address(mgr)), 0);
        assertEq(u.balanceOf(me), 22e6); // el USDC del dueño no se tocó
    }

    function test_deleverage_reverts_if_cannot_repay_flash() public {
        vm.prank(me);
        vm.expectRevert();
        mgr.deleverage(RevertLoanManager.DeleverageArgs({tokenId: 1, liquidity: 1, minUsdcOut: 0, deadline: block.timestamp}), 3e6);
    }

    function test_recenter_flash() public {
        // primero desapalanca un poco (la posición nueva vale lo mismo en el mock, pero así hay margen)
        uint128 l = uint128(uint256(n.liq(1)) * 21 / 300);
        vm.prank(me);
        mgr.deleverage(RevertLoanManager.DeleverageArgs({tokenId: 1, liquidity: l, minUsdcOut: 0, deadline: block.timestamp}), 2e6);
        uint256 debt = v.loans(1);
        vm.prank(me);
        mgr.recenter(RevertLoanManager.RecenterArgs({tokenId: 1, tickLower: -600, tickUpper: 600, sellToken0: true, swapAmountIn: 0.0005e18, swapMinOut: 0, deadline: block.timestamp}), debt);
        uint256 id = mgr.lastTokenId();
        assertEq(id, 100);
        assertEq(v.tokenOwner(id), address(mgr));
        assertEq(v.loans(1), 0);
        assertApproxEqAbs(v.loans(id), debt, 2); // misma deuda, ahora en la posición nueva
        assertEq(u.balanceOf(address(m)), 1_000_000e6);
        assertEq(u.balanceOf(me), 22e6);
    }
}
