// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Moola Market is an Aave v2 fork, so it uses the v2 LendingPool interface
///         (Celo mainnet: 0x970b12522CA9b4054807a2c5B736149a5BE6f670).
///         Verified on-chain 2026-07: `deposit(address,uint256,address,uint16)` reverts
///         with Aave v2 error "1" (VL_INVALID_AMOUNT) on zero amount, confirming the v2 ABI.
interface IMoolaLendingPool {
    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
