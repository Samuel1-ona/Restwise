// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Mento V3 FPMM Router (Velodrome-style interface).
///         Celo mainnet: 0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6, paired with
///         FPMMFactory 0xa849b475FE5a4B5C9C3280152c7a1945b907613b.
///         Live FPMM pools pair each stable against USDm (USDC/USDm, USDT/USDm),
///         so non-USDm pairs route two hops through USDm.
///         ABI verified from the on-chain contract via Blockscout, and quotes
///         exercised live 2026-07 (1000 USDT -> 998.94 USDm -> 998.91 USDC).
interface IMentoRouter {
    struct Route {
        address from;
        address to;
        address factory;
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
