// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {IMoolaLendingPool} from "../src/interfaces/IMoolaLendingPool.sol";
import {IMentoRouter} from "../src/interfaces/IMentoRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Integration tests against the REAL Celo mainnet contracts (forked).
///         Run explicitly: RUN_FORK=true forge test --match-contract Fork -vv
contract YieldVaultForkTest is Test {
    // Celo mainnet, verified on-chain 2026-07.
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant USDM = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant AAVE_POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address constant A_USDT = 0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df;
    address constant A_USDC = 0xFF8309b9e99bfd2D4021bc71a362aBD93dBd4785;
    address constant A_USDM = 0xBba98352628B0B0c4b40583F593fFCb630935a45;
    address constant MOOLA_POOL = 0x970b12522CA9b4054807a2c5B736149a5BE6f670;
    address constant MCUSD = 0x918146359264C492BD6934071c6Bd31C854EDBc3;
    address constant MENTO_ROUTER = 0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6;
    address constant FPMM_FACTORY = 0xa849b475FE5a4B5C9C3280152c7a1945b907613b;

    bool runFork;
    YieldVault vault;
    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");
    address feeCollector = makeAddr("feeCollector");

    function setUp() public {
        runFork = vm.envOr("RUN_FORK", false);
        if (!runFork) return;
        vm.createSelectFork(vm.envOr("CELO_RPC", string("https://forno.celo.org")));

        vault = new YieldVault(
            IAaveV3Pool(AAVE_POOL),
            IMoolaLendingPool(MOOLA_POOL),
            IMentoRouter(MENTO_ROUTER),
            FPMM_FACTORY,
            USDM,
            keeper,
            feeCollector
        );
        vault.addAsset(IERC20(USDT), 6, IERC20(A_USDT), IERC20(address(0)));
        vault.addAsset(IERC20(USDC), 6, IERC20(A_USDC), IERC20(address(0)));
        vault.addAsset(IERC20(USDM), 18, IERC20(A_USDM), IERC20(MCUSD));

        deal(USDT, alice, 10_000e6);
        deal(USDM, alice, 10_000e18);
        vm.startPrank(alice);
        IERC20(USDT).approve(address(vault), type(uint256).max);
        IERC20(USDM).approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function test_Fork_DepositWithdrawUsdtRoundTrip() public {
        vm.skip(!runFork);
        vm.prank(alice);
        uint256 shares = vault.deposit(USDT, 1_000e6);
        assertEq(shares, 1_000e18);
        assertGe(IERC20(A_USDT).balanceOf(address(vault)), 1_000e6 - 1);

        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, USDT);
        assertApproxEqAbs(paid, 1_000e6, 2);
    }

    function test_Fork_RebalanceUsdtToUsdmAcrossRealMento() public {
        vm.skip(!runFork);
        vm.prank(alice);
        vault.deposit(USDT, 1_000e6);

        // Keeper quotes the real router, then rebalances Aave-USDT -> Aave-USDm.
        IMentoRouter.Route[] memory routes = new IMentoRouter.Route[](1);
        routes[0] = IMentoRouter.Route(USDT, USDM, FPMM_FACTORY);
        uint256[] memory quote = IMentoRouter(MENTO_ROUTER).getAmountsOut(1_000e6, routes);
        uint256 minOut = quote[1] * 9_990 / 10_000;

        vm.prank(keeper);
        vault.rebalance(USDT, false, USDM, false, 1_000e6, minOut, 39, 253);

        assertEq(IERC20(A_USDT).balanceOf(address(vault)), 0);
        assertGe(IERC20(A_USDM).balanceOf(address(vault)), minOut);

        // Deposited USDT, funds now in USDm — withdraw back in USDT crosses Mento again.
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, USDT);
        assertGe(paid, 995e6); // two real swap legs cost ~0.2%, well inside 0.5%
    }

    function test_Fork_MoolaLegStillFunctional() public {
        vm.skip(!runFork);
        vm.prank(alice);
        vault.deposit(USDM, 1_000e18);

        vm.prank(keeper);
        vault.rebalance(USDM, false, USDM, true, 500e18, 0, 253, 0);
        assertApproxEqAbs(IERC20(MCUSD).balanceOf(address(vault)), 500e18, 1);

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.withdraw(shares, USDM);
        assertApproxEqAbs(paid, 1_000e18, 1e12);
    }

    function test_Fork_FeeRealizationOnRealYield() public {
        vm.skip(!runFork);
        vm.prank(alice);
        vault.deposit(USDM, 10_000e18);

        // Let real Aave interest accrue.
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 1);

        vm.prank(keeper);
        uint256 fee = vault.realizeFee();
        assertGt(fee, 0); // ~2.5% APY on 10k -> ~250 yield -> ~25 fee
        vm.prank(feeCollector);
        uint256 paid = vault.claimFee(feeCollector, USDM);
        assertGt(paid, 0);
    }
}
