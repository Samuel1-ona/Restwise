// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {IMoolaLendingPool} from "../src/interfaces/IMoolaLendingPool.sol";
import {IMentoRouter} from "../src/interfaces/IMentoRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAaveDataProvider {
    function getReserveTokensAddresses(address asset)
        external
        view
        returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress);
}

/// @notice Deploys the multi-asset Restwise YieldVault on Celo mainnet.
///
/// Assets: USDT + USDC (Aave v3 only) and USDm/cUSD (Aave v3 + Moola).
/// Cross-stable rebalancing routes through Mento V3 FPMM pools (USDT/USDm and
/// USDC/USDm verified live). aTokens are resolved from Aave's PoolDataProvider at
/// deploy time so a wrong pairing cannot ship.
contract DeployScript is Script {
    // Celo mainnet, verified on-chain 2026-07.
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant USDM = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant AAVE_POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address constant AAVE_DATA_PROVIDER = 0x2e0f8D3B1631296cC7c56538D6Eb6032601E15ED;
    address constant MOOLA_POOL = 0x970b12522CA9b4054807a2c5B736149a5BE6f670;
    address constant MCUSD = 0x918146359264C492BD6934071c6Bd31C854EDBc3;
    address constant MENTO_ROUTER = 0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6;
    address constant FPMM_FACTORY = 0xa849b475FE5a4B5C9C3280152c7a1945b907613b;

    function run() public {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);
        address feeCollector = vm.envOr("FEE_COLLECTOR_ADDRESS", deployer);

        IAaveDataProvider dataProvider = IAaveDataProvider(AAVE_DATA_PROVIDER);
        (address aUsdt,,) = dataProvider.getReserveTokensAddresses(USDT);
        (address aUsdc,,) = dataProvider.getReserveTokensAddresses(USDC);
        (address aUsdm,,) = dataProvider.getReserveTokensAddresses(USDM);
        require(aUsdt != address(0) && aUsdc != address(0) && aUsdm != address(0), "asset missing on Aave v3");

        vm.startBroadcast(deployerKey);
        YieldVault vault = new YieldVault(
            IAaveV3Pool(AAVE_POOL),
            IMoolaLendingPool(MOOLA_POOL),
            IMentoRouter(MENTO_ROUTER),
            FPMM_FACTORY,
            USDM,
            keeper,
            feeCollector
        );
        vault.addAsset(IERC20(USDT), 6, IERC20(aUsdt), IERC20(address(0)));
        vault.addAsset(IERC20(USDC), 6, IERC20(aUsdc), IERC20(address(0)));
        vault.addAsset(IERC20(USDM), 18, IERC20(aUsdm), IERC20(MCUSD));
        vm.stopBroadcast();

        console.log("YieldVault deployed:", address(vault));
        console.log("  aUSDT:        ", aUsdt);
        console.log("  aUSDC:        ", aUsdc);
        console.log("  aUSDm:        ", aUsdm);
        console.log("  keeper:       ", keeper);
        console.log("  feeCollector: ", feeCollector);
    }
}
