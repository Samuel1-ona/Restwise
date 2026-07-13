// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal Aave v3 Pool interface (Celo mainnet: 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402)
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
