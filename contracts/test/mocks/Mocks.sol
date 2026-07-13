// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Receipt token whose balance the mock pool controls directly, mimicking
///         the 1:1 rebasing behaviour of Aave aTokens / Moola mTokens.
contract MockReceiptToken is ERC20 {
    address public immutable pool;
    uint8 private immutable _dec;

    constructor(uint8 dec_) ERC20("Mock Receipt", "mRCPT") {
        pool = msg.sender;
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == pool, "only pool");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == pool, "only pool");
        _burn(from, amount);
    }
}

/// @notice Multi-reserve lending pool serving as both the Aave v3 pool (supply/withdraw)
///         and the Moola v2 pool (deposit/withdraw) — the ABIs only differ in the
///         entry function name.
contract MockLendingPool {
    mapping(address => MockReceiptToken) public receipts;

    function addReserve(MockToken asset) external returns (MockReceiptToken receipt) {
        receipt = new MockReceiptToken(asset.decimals());
        receipts[address(asset)] = receipt;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        MockToken(asset).transferFrom(msg.sender, address(this), amount);
        receipts[asset].mint(onBehalfOf, amount);
    }

    function deposit(address asset, uint256 amount, address onBehalfOf, uint16) external {
        MockToken(asset).transferFrom(msg.sender, address(this), amount);
        receipts[asset].mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        if (amount == type(uint256).max) amount = receipts[asset].balanceOf(msg.sender);
        receipts[asset].burn(msg.sender, amount);
        MockToken(asset).transfer(to, amount);
        return amount;
    }

    /// @dev Simulate interest: rebase the holder's receipt balance up and back the
    ///      claim with freshly minted underlying so withdrawals stay solvent.
    function accrueYield(address asset, address holder, uint256 amount) external {
        receipts[asset].mint(holder, amount);
        MockToken(asset).mint(address(this), amount);
    }
}

/// @notice Mento FPMM router stand-in: converts across decimals at $1 parity minus a
///         per-hop fee, minting the output token.
contract MockMentoRouter {
    struct Route {
        address from;
        address to;
        address factory;
    }

    uint256 public feePerHopBps = 10; // 0.1% per hop, like the live USDT/USDm pool

    function setFeePerHopBps(uint256 bps) external {
        feePerHopBps = bps;
    }

    function _convert(uint256 amountIn, address from, address to, uint256 hops) internal view returns (uint256) {
        uint256 normIn = amountIn * 10 ** (18 - MockToken(from).decimals());
        uint256 normOut = normIn;
        for (uint256 i; i < hops; ++i) {
            normOut = normOut * (10_000 - feePerHopBps) / 10_000;
        }
        return normOut / 10 ** (18 - MockToken(to).decimals());
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](routes.length + 1);
        amounts[0] = amountIn;
        amounts[routes.length] = _convert(amountIn, routes[0].from, routes[routes.length - 1].to, routes.length);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        address tokenIn = routes[0].from;
        address tokenOut = routes[routes.length - 1].to;
        uint256 out = _convert(amountIn, tokenIn, tokenOut, routes.length);
        require(out >= amountOutMin, "router: insufficient output");
        MockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockToken(tokenOut).mint(to, out);
        amounts = new uint256[](routes.length + 1);
        amounts[0] = amountIn;
        amounts[routes.length] = out;
    }
}
