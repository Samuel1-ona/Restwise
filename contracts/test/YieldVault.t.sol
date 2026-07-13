// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {IMoolaLendingPool} from "../src/interfaces/IMoolaLendingPool.sol";
import {IMentoRouter} from "../src/interfaces/IMentoRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockToken, MockLendingPool, MockMentoRouter, MockReceiptToken} from "./mocks/Mocks.sol";

contract YieldVaultTest is Test {
    MockToken usdt; // 6 decimals
    MockToken usdc; // 6 decimals
    MockToken usdm; // 18 decimals — the swap-route hub
    MockLendingPool aave;
    MockLendingPool moola;
    MockMentoRouter router;
    YieldVault vault;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address feeCollector = makeAddr("feeCollector");
    address treasury = makeAddr("treasury");

    function setUp() public {
        usdt = new MockToken("Tether USD", "USDT", 6);
        usdc = new MockToken("USD Coin", "USDC", 6);
        usdm = new MockToken("Mento USD", "USDm", 18);
        aave = new MockLendingPool();
        moola = new MockLendingPool();
        router = new MockMentoRouter();

        MockReceiptToken aUsdt = aave.addReserve(usdt);
        MockReceiptToken aUsdc = aave.addReserve(usdc);
        MockReceiptToken aUsdm = aave.addReserve(usdm);
        MockReceiptToken mUsdm = moola.addReserve(usdm);

        vault = new YieldVault(
            IAaveV3Pool(address(aave)),
            IMoolaLendingPool(address(moola)),
            IMentoRouter(address(router)),
            address(0xFAC),
            address(usdm),
            keeper,
            feeCollector
        );
        vault.addAsset(IERC20(address(usdt)), 6, IERC20(address(aUsdt)), IERC20(address(0)));
        vault.addAsset(IERC20(address(usdc)), 6, IERC20(address(aUsdc)), IERC20(address(0)));
        vault.addAsset(IERC20(address(usdm)), 18, IERC20(address(aUsdm)), IERC20(address(mUsdm)));

        for (uint256 i; i < 2; ++i) {
            address user = i == 0 ? alice : bob;
            usdt.mint(user, 1_000e6);
            usdc.mint(user, 1_000e6);
            usdm.mint(user, 1_000e18);
            vm.startPrank(user);
            usdt.approve(address(vault), type(uint256).max);
            usdc.approve(address(vault), type(uint256).max);
            usdm.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _deposit(address who, address asset, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return vault.deposit(asset, amount);
    }

    function _aaveBal(MockToken asset) internal view returns (uint256) {
        return aave.receipts(address(asset)).balanceOf(address(vault));
    }

    function _moolaBal(MockToken asset) internal view returns (uint256) {
        return moola.receipts(address(asset)).balanceOf(address(vault));
    }

    // ---------------------------------------------------------------- deposits

    function test_DepositNormalizesDecimalsIntoShares() public {
        assertEq(_deposit(alice, address(usdt), 100e6), 100e18); // 6-dec asset, 18-dec shares
        assertEq(_deposit(bob, address(usdm), 100e18), 100e18);
        assertEq(vault.totalAssets(), 200e18);
        assertEq(_aaveBal(usdt), 100e6);
        assertEq(_aaveBal(usdm), 100e18);
    }

    function test_DepositUnsupportedAssetReverts() public {
        MockToken rogue = new MockToken("Rogue", "RGE", 18);
        rogue.mint(alice, 1e18);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.AssetNotSupported.selector, address(rogue)));
        vm.prank(alice);
        vault.deposit(address(rogue), 1e18);
    }

    // ---------------------------------------------------------------- withdrawals

    function test_WithdrawSameAssetReturnsPrincipal() public {
        uint256 shares = _deposit(alice, address(usdt), 100e6);
        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, address(usdt));
        assertApproxEqAbs(paid, 100e6, 1);
        assertApproxEqAbs(usdt.balanceOf(alice), 1_000e6, 1);
    }

    function test_WithdrawCrossAssetSwapsViaMento() public {
        uint256 shares = _deposit(alice, address(usdt), 100e6);
        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, address(usdm)); // USDT -> USDm is one hop
        // one 0.1% router hop; never worse than the vault's 0.5% tolerance
        assertGe(paid, 99.5e18);
        assertLe(paid, 100e18);
    }

    function test_WithdrawTwoHopSwap() public {
        uint256 shares = _deposit(alice, address(usdt), 100e6);
        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, address(usdc)); // USDT -> hub -> USDC
        assertGe(paid, 99.5e6);
        assertLe(paid, 100e6);
    }

    function test_WithdrawRevertsWhenSwapCostExceedsTolerance() public {
        router.setFeePerHopBps(100); // 1% per hop > 0.5% tolerance
        uint256 shares = _deposit(alice, address(usdt), 100e6);
        vm.prank(alice);
        vm.expectRevert(); // mock router reverts on minOut; either way the user is protected
        vault.withdraw(shares, address(usdm));
    }

    function test_WithdrawIncludesYield() public {
        uint256 shares = _deposit(alice, address(usdm), 100e18);
        aave.accrueYield(address(usdm), address(vault), 10e18);
        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, address(usdm));
        assertApproxEqAbs(paid, 110e18, 2);
    }

    /// Regression: after a full exit, withdrawal rounding can leave dust in the
    /// vault while totalSupply is 0. The next deposit must mint 1:1 with value
    /// (dust accrues to the depositor) instead of dividing by the dust and
    /// inflating pricePerShare by orders of magnitude (seen live on mainnet).
    function test_RedepositAfterFullExitWithDustMintsSaneShares() public {
        uint256 aliceShares = _deposit(alice, address(usdt), 100e6);
        vm.prank(alice);
        vault.withdraw(aliceShares, address(usdt));
        assertEq(vault.totalSupply(), 0);

        usdt.mint(address(vault), 66); // simulate aToken rounding dust ($0.000066)
        assertGt(vault.totalAssets(), 0);

        uint256 bobShares = _deposit(bob, address(usdt), 900e6);
        assertEq(bobShares, 900e18); // 1:1 with normalized value, not divided by dust
        assertApproxEqRel(vault.pricePerShare(), 1e18, 1e12);

        vm.prank(bob);
        uint256 paid = vault.withdraw(bobShares, address(usdt));
        assertApproxEqAbs(paid, 900e6 + 66, 2); // principal + the dust he absorbed
    }

    function test_SecondDepositorDoesNotDiluteFirst() public {
        _deposit(alice, address(usdm), 100e18);
        aave.accrueYield(address(usdm), address(vault), 100e18); // pps doubles
        uint256 bobShares = _deposit(bob, address(usdt), 100e6);
        assertApproxEqRel(bobShares, 50e18, 1e12); // bob pays double per share
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.withdraw(aliceShares, address(usdm));
        assertApproxEqRel(paid, 200e18, 1e12);
    }

    // ---------------------------------------------------------------- rebalance

    function test_RebalanceSameAssetAcrossProtocols() public {
        _deposit(alice, address(usdm), 100e18);
        vm.prank(keeper);
        vault.rebalance(address(usdm), false, address(usdm), true, 60e18, 0, 250, 400);
        assertEq(_aaveBal(usdm), 40e18);
        assertEq(_moolaBal(usdm), 60e18);
    }

    function test_RebalanceCrossAssetSwaps() public {
        _deposit(alice, address(usdt), 100e6);
        uint256 minOut = 99.8e18; // keeper's live quote (one hop, 0.1% fee -> 99.9)
        vm.expectEmit(true, false, true, false);
        emit YieldVault.Rebalanced(address(usdt), false, address(usdm), false, 100e6, 99.9e18, 39, 253);
        vm.prank(keeper);
        vault.rebalance(address(usdt), false, address(usdm), false, 100e6, minOut, 39, 253);
        assertEq(_aaveBal(usdt), 0);
        assertEq(_aaveBal(usdm), 99.9e18);
    }

    function test_RebalanceRejectsMinOutBelowFloor() public {
        _deposit(alice, address(usdt), 100e6);
        // floor is 99.5e18 (0.5% tolerance); a keeper quoting less must be rejected
        vm.expectRevert(abi.encodeWithSelector(YieldVault.MinOutTooLow.selector, 90e18, 99.5e18));
        vm.prank(keeper);
        vault.rebalance(address(usdt), false, address(usdm), false, 100e6, 90e18, 0, 0);
    }

    function test_RebalanceToMoolaOnlyForListedAssets() public {
        _deposit(alice, address(usdt), 100e6);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.MoolaNotAvailable.selector, address(usdt)));
        vm.prank(keeper);
        vault.rebalance(address(usdt), false, address(usdt), true, 100e6, 0, 0, 0);
    }

    function test_RebalanceOnlyKeeper() public {
        _deposit(alice, address(usdm), 100e18);
        vm.expectRevert(YieldVault.NotKeeper.selector);
        vm.prank(alice);
        vault.rebalance(address(usdm), false, address(usdm), true, 10e18, 0, 0, 0);
    }

    // ---------------------------------------------------------------- fees

    function test_FeeIsTenPercentOfYieldOnly() public {
        _deposit(alice, address(usdm), 100e18);
        aave.accrueYield(address(usdm), address(vault), 20e18);
        vm.prank(keeper);
        uint256 fee = vault.realizeFee();
        assertApproxEqAbs(fee, 2e18, 1e6);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.withdraw(aliceShares, address(usdm));
        assertApproxEqAbs(paid, 118e18, 1e6); // principal + 90% of yield
    }

    function test_NoDoubleChargeAndNoFeeOnDeposits() public {
        _deposit(alice, address(usdm), 100e18);
        aave.accrueYield(address(usdm), address(vault), 20e18);
        vm.startPrank(keeper);
        vault.realizeFee();
        assertEq(vault.realizeFee(), 0); // high-water mark advanced
        vm.stopPrank();
        _deposit(bob, address(usdt), 500e6); // principal inflow must not look like yield
        vm.prank(keeper);
        assertEq(vault.realizeFee(), 0);
    }

    function test_ClaimFeePaysInRequestedAsset() public {
        _deposit(alice, address(usdm), 100e18);
        aave.accrueYield(address(usdm), address(vault), 20e18);
        vm.prank(keeper);
        vault.realizeFee();

        vm.expectRevert(YieldVault.NotFeeCollector.selector);
        vm.prank(alice);
        vault.claimFee(treasury, address(usdc));

        vm.prank(feeCollector);
        uint256 paid = vault.claimFee(treasury, address(usdc)); // yield sits in USDm -> swap
        assertGe(paid, 1.9e6); // ~2 USDC minus swap fee
        assertEq(usdc.balanceOf(treasury), paid);
        assertEq(vault.accruedFees(), 0);
    }

    function testFuzz_FeeNeverTouchesPrincipal(uint96 principal, uint96 yield_) public {
        uint256 p = bound(uint256(principal), 1e6, 1_000_000e6); // USDT units
        uint256 y = bound(uint256(yield_), 0, 1_000_000e6);
        usdt.mint(alice, p);
        _deposit(alice, address(usdt), p);
        aave.accrueYield(address(usdt), address(vault), y);
        vm.prank(keeper);
        uint256 fee = vault.realizeFee(); // fee in normalized 18-dec units
        assertLe(fee, uint256(y) * 1e12 / 10 + 1e12);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.withdraw(aliceShares, address(usdt));
        assertGe(paid + 2, p); // principal intact modulo rounding dust
    }

    // ---------------------------------------------------------------- safety controls

    function test_PauseBlocksDepositAndRebalanceButNotWithdraw() public {
        uint256 shares = _deposit(alice, address(usdm), 100e18);
        vault.pause();
        vm.expectRevert();
        vm.prank(bob);
        vault.deposit(address(usdm), 10e18);
        vm.expectRevert();
        vm.prank(keeper);
        vault.rebalance(address(usdm), false, address(usdm), true, 10e18, 0, 0, 0);
        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, address(usdm));
        assertApproxEqAbs(paid, 100e18, 1);
    }

    function test_EmergencyExitDrainsAllVenuesAndPauses() public {
        _deposit(alice, address(usdt), 100e6);
        _deposit(alice, address(usdm), 100e18);
        vm.prank(keeper);
        vault.rebalance(address(usdm), false, address(usdm), true, 50e18, 0, 0, 0);
        vault.emergencyExit();
        assertEq(_aaveBal(usdt), 0);
        assertEq(_aaveBal(usdm), 0);
        assertEq(_moolaBal(usdm), 0);
        assertEq(usdt.balanceOf(address(vault)), 100e6);
        assertEq(usdm.balanceOf(address(vault)), 100e18);
        assertTrue(vault.paused());
    }

    function test_AdminSettersOnlyOwner() public {
        vm.expectRevert();
        vm.prank(alice);
        vault.setKeeper(alice);
        vault.setKeeper(bob);
        assertEq(vault.keeper(), bob);
        vault.setMaxSlippageBps(100);
        assertEq(vault.maxSlippageBps(), 100);
        vm.expectRevert("slippage cap 2%");
        vault.setMaxSlippageBps(500);
    }
}
