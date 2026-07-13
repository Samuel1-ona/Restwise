// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {IMoolaLendingPool} from "./interfaces/IMoolaLendingPool.sol";
import {IMentoRouter} from "./interfaces/IMentoRouter.sol";

/// @title Restwise YieldVault (multi-asset)
/// @notice Non-custodial "set & forget" stablecoin vault on Celo. Accepts USDT, USDC
///         and USDm; a keeper agent consolidates capital into whichever lending venue
///         pays the best supply APY across Aave v3 (all three assets) and Moola Market
///         (USDm only), swapping between stables through Mento V3 FPMM pools.
///         Takes a 10% performance fee on realized yield only, settled via x402.
///
///         Accounting: shares are 18-decimal "vault USD". Every supported stable is
///         normalized to 18 decimals and counted at $1 — the same assumption Mento's
///         FPMM pools enforce on the swap path, where every actual conversion is
///         additionally protected by a hard min-received check (maxSlippageBps).
///         Aave aTokens and Moola mTokens rebase 1:1 with their underlying, so
///         receipt-token balanceOf() is directly denominated in the asset.
contract YieldVault is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PERFORMANCE_FEE_BPS = 1000; // 10% of yield
    uint256 private constant BPS = 10_000;
    uint256 private constant PRECISION = 1e18;

    struct AssetConfig {
        bool enabled;
        uint8 decimals;
        IERC20 aToken; // Aave v3 receipt (required — every supported asset is on Aave)
        IERC20 mToken; // Moola receipt (zero address if not listed on Moola)
    }

    IAaveV3Pool public immutable aavePool;
    IMoolaLendingPool public immutable moolaPool;
    IMentoRouter public immutable swapRouter;
    address public immutable swapFactory;
    /// @notice Hub asset for swap routing: every live Mento FPMM pool pairs against
    ///         USDm, so non-hub pairs route two hops through it.
    address public immutable routeHub;

    address[] public assetList;
    mapping(address => AssetConfig) public assetConfig;

    /// @notice Agent address allowed to rebalance and checkpoint fees.
    address public keeper;
    /// @notice x402 settlement service allowed to release accrued fees after payment settles.
    address public feeCollector;
    /// @notice Hard floor on any swap's min-received, and the tolerance a withdrawal
    ///         may lose to swap fees when it must convert between stables.
    uint256 public maxSlippageBps = 50; // 0.5%

    /// @notice High-water mark of net price-per-share (1e18-scaled). Fees only accrue
    ///         on growth above this mark, so principal is never charged.
    uint256 public highWaterMark = PRECISION;
    /// @notice Realized performance fees in normalized (18-dec USD) units.
    uint256 public accruedFees;

    event AssetAdded(address indexed asset, address aToken, address mToken);
    event Deposited(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    /// @dev The on-chain "agent thoughts" record: APYs observed at decision time ride
    ///      along so every move is auditable from the event log alone.
    event Rebalanced(
        address indexed fromAsset,
        bool fromMoola,
        address indexed toAsset,
        bool toMoola,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fromApyBps,
        uint256 toApyBps
    );
    event FeeRealized(uint256 grossYield, uint256 fee, uint256 newHighWaterMark);
    event FeeClaimed(address indexed to, address indexed asset, uint256 amount);
    event EmergencyExit();
    event KeeperUpdated(address keeper);
    event FeeCollectorUpdated(address feeCollector);
    event MaxSlippageUpdated(uint256 bps);

    error NotKeeper();
    error NotFeeCollector();
    error ZeroAmount();
    error AssetNotSupported(address asset);
    error MoolaNotAvailable(address asset);
    error MinOutTooLow(uint256 provided, uint256 floor);
    error ShortfallExceedsTolerance(uint256 assembled, uint256 requested);

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(
        IAaveV3Pool aavePool_,
        IMoolaLendingPool moolaPool_,
        IMentoRouter swapRouter_,
        address swapFactory_,
        address routeHub_,
        address keeper_,
        address feeCollector_
    ) ERC20("Restwise Vault Share", "rwUSD") Ownable(msg.sender) {
        aavePool = aavePool_;
        moolaPool = moolaPool_;
        swapRouter = swapRouter_;
        swapFactory = swapFactory_;
        routeHub = routeHub_;
        keeper = keeper_;
        feeCollector = feeCollector_;
    }

    // ---------------------------------------------------------------- asset registry

    /// @notice Register a supported stable. mToken = address(0) when the asset has no
    ///         Moola market (true for everything except USDm on Celo today).
    function addAsset(IERC20 token, uint8 decimals_, IERC20 aToken, IERC20 mToken) external onlyOwner {
        require(!assetConfig[address(token)].enabled, "already added");
        require(address(aToken) != address(0), "aToken required");
        assetConfig[address(token)] =
            AssetConfig({enabled: true, decimals: decimals_, aToken: aToken, mToken: mToken});
        assetList.push(address(token));
        token.forceApprove(address(aavePool), type(uint256).max);
        token.forceApprove(address(swapRouter), type(uint256).max);
        if (address(mToken) != address(0)) {
            token.forceApprove(address(moolaPool), type(uint256).max);
        }
        emit AssetAdded(address(token), address(aToken), address(mToken));
    }

    function supportedAssets() external view returns (address[] memory) {
        return assetList;
    }

    // ---------------------------------------------------------------- views

    function _norm(address asset, uint256 amount) internal view returns (uint256) {
        return amount * 10 ** (18 - assetConfig[asset].decimals);
    }

    function _denorm(address asset, uint256 normAmount) internal view returns (uint256) {
        return normAmount / 10 ** (18 - assetConfig[asset].decimals);
    }

    /// @notice Everything the vault controls across all assets and venues, in
    ///         normalized 18-dec USD units (fees included).
    function grossAssets() public view returns (uint256 total) {
        uint256 len = assetList.length;
        for (uint256 i; i < len; ++i) {
            address asset = assetList[i];
            AssetConfig storage cfg = assetConfig[asset];
            uint256 bal = IERC20(asset).balanceOf(address(this)) + cfg.aToken.balanceOf(address(this));
            if (address(cfg.mToken) != address(0)) bal += cfg.mToken.balanceOf(address(this));
            total += _norm(asset, bal);
        }
    }

    /// @notice Assets belonging to depositors (normalized, net of fees owed).
    function totalAssets() public view returns (uint256) {
        return grossAssets() - accruedFees;
    }

    /// @notice Full allocation snapshot for the dashboard and the agent.
    function currentAllocation()
        external
        view
        returns (address[] memory assets, uint256[] memory idle, uint256[] memory inAave, uint256[] memory inMoola, uint256 totalNormalized)
    {
        uint256 len = assetList.length;
        assets = assetList;
        idle = new uint256[](len);
        inAave = new uint256[](len);
        inMoola = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            AssetConfig storage cfg = assetConfig[assets[i]];
            idle[i] = IERC20(assets[i]).balanceOf(address(this));
            inAave[i] = cfg.aToken.balanceOf(address(this));
            if (address(cfg.mToken) != address(0)) inMoola[i] = cfg.mToken.balanceOf(address(this));
        }
        totalNormalized = grossAssets();
    }

    /// @dev A vault with no shares mints 1:1 with deposited value, regardless of any
    ///      residual dust it holds — the dust simply accrues to the first depositor.
    ///      (The previous +1/+1 virtual offset let post-exit dust, e.g. aToken
    ///      rounding remainders, inflate the share price by orders of magnitude.)
    function convertToShares(uint256 normAssets) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return normAssets;
        uint256 assets = totalAssets();
        return assets == 0 ? normAssets : normAssets * supply / assets;
    }

    function convertToAssets(uint256 shares_) public view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? shares_ : shares_ * totalAssets() / supply;
    }

    /// @notice Net price per share, 1e18-scaled.
    function pricePerShare() public view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? PRECISION : totalAssets() * PRECISION / supply;
    }

    // ---------------------------------------------------------------- user flows

    /// @notice Deposit any supported stable. Funds are supplied to Aave in the same
    ///         asset (no swap — depositors never pay conversion costs); the agent
    ///         consolidates into the best venue on its next cycle.
    function deposit(address asset, uint256 amount) external nonReentrant whenNotPaused returns (uint256 shares) {
        AssetConfig storage cfg = assetConfig[asset];
        if (!cfg.enabled) revert AssetNotSupported(asset);
        if (amount == 0) revert ZeroAmount();
        shares = convertToShares(_norm(asset, amount));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        aavePool.supply(asset, amount, address(this), 0);
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, asset, amount, shares);
    }

    /// @notice Redeem shares for any supported stable. If the vault doesn't hold
    ///         enough of the requested asset, it converts other holdings through
    ///         Mento FPMM pools; the withdrawer bears at most maxSlippageBps of
    ///         conversion cost (typically ~0.1% on the live pools).
    ///         Intentionally NOT pausable: users can always exit reachable liquidity.
    function withdraw(uint256 shares, address asset) external nonReentrant returns (uint256 paid) {
        AssetConfig storage cfg = assetConfig[asset];
        if (!cfg.enabled) revert AssetNotSupported(asset);
        if (shares == 0) revert ZeroAmount();
        uint256 amountOut = _denorm(asset, convertToAssets(shares));
        _burn(msg.sender, shares);
        uint256 assembled = _assemble(asset, amountOut);
        if (assembled < amountOut * (BPS - maxSlippageBps) / BPS) {
            revert ShortfallExceedsTolerance(assembled, amountOut);
        }
        paid = assembled < amountOut ? assembled : amountOut;
        IERC20(asset).safeTransfer(msg.sender, paid);
        emit Withdrawn(msg.sender, asset, paid, shares);
    }

    // ---------------------------------------------------------------- keeper flows

    /// @notice Move `amount` of `fromAsset` out of one venue into another, converting
    ///         through Mento when the assets differ. `minOut` comes from the keeper's
    ///         live quote but can never be below the vault's own slippage floor, so a
    ///         compromised keeper cannot grief depositors via bad swaps.
    /// @param fromApyBps / toApyBps: APYs the agent observed when it decided, recorded
    ///        on-chain for the transparency log.
    function rebalance(
        address fromAsset,
        bool fromMoola,
        address toAsset,
        bool toMoola,
        uint256 amount,
        uint256 minOut,
        uint256 fromApyBps,
        uint256 toApyBps
    ) external onlyKeeper nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        AssetConfig storage fromCfg = assetConfig[fromAsset];
        AssetConfig storage toCfg = assetConfig[toAsset];
        if (!fromCfg.enabled) revert AssetNotSupported(fromAsset);
        if (!toCfg.enabled) revert AssetNotSupported(toAsset);

        // 1. Pull out of the source venue.
        uint256 received = _withdrawVenue(fromAsset, fromMoola, amount);

        // 2. Convert if crossing assets, with a floor under the keeper's minOut.
        uint256 amountOut = received;
        if (fromAsset != toAsset) {
            uint256 floor = _denorm(toAsset, _norm(fromAsset, received)) * (BPS - maxSlippageBps) / BPS;
            if (minOut < floor) revert MinOutTooLow(minOut, floor);
            amountOut = _swap(fromAsset, toAsset, received, minOut);
        }

        // 3. Supply to the target venue.
        if (toMoola) {
            if (address(toCfg.mToken) == address(0)) revert MoolaNotAvailable(toAsset);
            moolaPool.deposit(toAsset, amountOut, address(this), 0);
        } else {
            aavePool.supply(toAsset, amountOut, address(this), 0);
        }

        emit Rebalanced(fromAsset, fromMoola, toAsset, toMoola, amount, amountOut, fromApyBps, toApyBps);
    }

    /// @notice Checkpoint yield since the high-water mark and accrue the 10% cut.
    function realizeFee() external onlyKeeper returns (uint256 fee) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        uint256 pps = totalAssets() * PRECISION / supply;
        if (pps <= highWaterMark) return 0;
        uint256 grossYield = (pps - highWaterMark) * supply / PRECISION;
        fee = grossYield * PERFORMANCE_FEE_BPS / BPS;
        accruedFees += fee;
        // Taking the fee lowers net pps; the new mark is the post-fee pps so the
        // same yield is never charged twice.
        highWaterMark = totalAssets() * PRECISION / supply;
        emit FeeRealized(grossYield, fee, highWaterMark);
    }

    /// @notice Release accrued fees in the requested asset. Called by the x402
    ///         settlement service once the corresponding x402 payment has settled —
    ///         the fee never moves as a silent internal transfer.
    function claimFee(address to, address asset) external nonReentrant returns (uint256 paid) {
        if (msg.sender != feeCollector) revert NotFeeCollector();
        if (!assetConfig[asset].enabled) revert AssetNotSupported(asset);
        uint256 normFee = accruedFees;
        if (normFee == 0) return 0;
        accruedFees = 0;
        uint256 amountOut = _denorm(asset, normFee);
        uint256 assembled = _assemble(asset, amountOut);
        paid = assembled < amountOut ? assembled : amountOut;
        IERC20(asset).safeTransfer(to, paid);
        emit FeeClaimed(to, asset, paid);
    }

    // ---------------------------------------------------------------- admin

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    function setFeeCollector(address feeCollector_) external onlyOwner {
        feeCollector = feeCollector_;
        emit FeeCollectorUpdated(feeCollector_);
    }

    function setMaxSlippageBps(uint256 bps) external onlyOwner {
        require(bps <= 200, "slippage cap 2%");
        maxSlippageBps = bps;
        emit MaxSlippageUpdated(bps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Pull everything back to idle (no swaps) and pause. Escape hatch if a
    ///         lending market or FPMM pool misbehaves.
    function emergencyExit() external onlyOwner {
        uint256 len = assetList.length;
        for (uint256 i; i < len; ++i) {
            address asset = assetList[i];
            AssetConfig storage cfg = assetConfig[asset];
            if (cfg.aToken.balanceOf(address(this)) > 0) {
                aavePool.withdraw(asset, type(uint256).max, address(this));
            }
            if (address(cfg.mToken) != address(0) && cfg.mToken.balanceOf(address(this)) > 0) {
                moolaPool.withdraw(asset, type(uint256).max, address(this));
            }
        }
        if (!paused()) _pause();
        emit EmergencyExit();
    }

    // ---------------------------------------------------------------- internal

    /// @dev Withdraw `amount` of `asset` from the named venue to idle, capped at the
    ///      live receipt balance — Aave's scaled-balance rounding can leave the
    ///      balance a wei short of the just-supplied amount, and "move everything"
    ///      keeper calls must not revert over dust.
    function _withdrawVenue(address asset, bool fromMoola, uint256 amount) internal returns (uint256) {
        if (fromMoola) {
            IERC20 mToken = assetConfig[asset].mToken;
            if (address(mToken) == address(0)) revert MoolaNotAvailable(asset);
            uint256 bal = mToken.balanceOf(address(this));
            return moolaPool.withdraw(asset, amount < bal ? amount : bal, address(this));
        }
        uint256 aBal = assetConfig[asset].aToken.balanceOf(address(this));
        return aavePool.withdraw(asset, amount < aBal ? amount : aBal, address(this));
    }

    /// @dev Drain `asset`'s venues into idle until `needed` more is available
    ///      (or the venues are empty).
    function _pullVenues(address asset, uint256 needed) internal {
        AssetConfig storage cfg = assetConfig[asset];
        uint256 inAave = cfg.aToken.balanceOf(address(this));
        if (inAave > 0) {
            uint256 take = needed < inAave ? needed : inAave;
            needed -= aavePool.withdraw(asset, take, address(this));
            if (needed == 0) return;
        }
        if (address(cfg.mToken) != address(0)) {
            uint256 inMoola = cfg.mToken.balanceOf(address(this));
            if (inMoola > 0) {
                uint256 take = needed < inMoola ? needed : inMoola;
                moolaPool.withdraw(asset, take, address(this));
            }
        }
    }

    /// @dev Make at least ~`amountOut` of `asset` sit idle: same-asset venues first,
    ///      then convert other holdings through Mento, largest-first is not attempted —
    ///      assets are drained in registry order, each swap floor-protected.
    ///      Returns the idle balance achieved (capped at amountOut).
    function _assemble(address asset, uint256 amountOut) internal returns (uint256) {
        uint256 have = IERC20(asset).balanceOf(address(this));
        if (have < amountOut) {
            _pullVenues(asset, amountOut - have);
            have = IERC20(asset).balanceOf(address(this));
        }

        uint256 len = assetList.length;
        for (uint256 i; i < len && have < amountOut; ++i) {
            address other = assetList[i];
            if (other == asset) continue;

            // Amount of `other` equivalent to the shortfall, padded so swap fees
            // don't leave us one iteration short.
            uint256 shortfall = amountOut - have;
            uint256 needOther = _denorm(other, _norm(asset, shortfall)) * (BPS + maxSlippageBps) / BPS;

            uint256 otherIdle = IERC20(other).balanceOf(address(this));
            if (otherIdle < needOther) {
                _pullVenues(other, needOther - otherIdle);
                otherIdle = IERC20(other).balanceOf(address(this));
            }
            uint256 swapIn = needOther < otherIdle ? needOther : otherIdle;
            if (swapIn == 0) continue;

            uint256 minOut = _denorm(asset, _norm(other, swapIn)) * (BPS - maxSlippageBps) / BPS;
            _swap(other, asset, swapIn, minOut);
            have = IERC20(asset).balanceOf(address(this));
        }
        return have < amountOut ? have : amountOut;
    }

    /// @dev Swap through Mento FPMM pools. Every live pool pairs against the hub
    ///      (USDm), so non-hub pairs take two hops.
    function _swap(address fromAsset, address toAsset, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256)
    {
        IMentoRouter.Route[] memory routes;
        if (fromAsset == routeHub || toAsset == routeHub) {
            routes = new IMentoRouter.Route[](1);
            routes[0] = IMentoRouter.Route(fromAsset, toAsset, swapFactory);
        } else {
            routes = new IMentoRouter.Route[](2);
            routes[0] = IMentoRouter.Route(fromAsset, routeHub, swapFactory);
            routes[1] = IMentoRouter.Route(routeHub, toAsset, swapFactory);
        }
        uint256[] memory amounts =
            swapRouter.swapExactTokensForTokens(amountIn, minOut, routes, address(this), block.timestamp);
        return amounts[amounts.length - 1];
    }
}
