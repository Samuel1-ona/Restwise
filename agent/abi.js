export const VAULT_ABI = [
  "function currentAllocation() view returns (address[] assets, uint256[] idle, uint256[] inAave, uint256[] inMoola, uint256 totalNormalized)",
  "function totalAssets() view returns (uint256)",
  "function accruedFees() view returns (uint256)",
  "function highWaterMark() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function pricePerShare() view returns (uint256)",
  "function supportedAssets() view returns (address[])",
  "function rebalance(address fromAsset, bool fromMoola, address toAsset, bool toMoola, uint256 amount, uint256 minOut, uint256 fromApyBps, uint256 toApyBps)",
  "function realizeFee() returns (uint256)",
  "function claimFee(address to, address asset) returns (uint256)",
  "event Rebalanced(address indexed fromAsset, bool fromMoola, address indexed toAsset, bool toMoola, uint256 amountIn, uint256 amountOut, uint256 fromApyBps, uint256 toApyBps)",
  "event FeeRealized(uint256 grossYield, uint256 fee, uint256 newHighWaterMark)",
  "event FeeClaimed(address indexed to, address indexed asset, uint256 amount)",
];

// Aave v3 ReserveDataLegacy — currentLiquidityRate is the supply APR in ray (1e27).
export const AAVE_V3_POOL_ABI = [
  "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
];

// Moola = Aave v2 fork — same ray-scaled currentLiquidityRate, different struct layout.
export const MOOLA_POOL_ABI = [
  "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))",
];

// Mento V3 FPMM router (Velodrome-style; ABI verified from the on-chain contract).
export const MENTO_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, (address from, address to, address factory)[] routes) view returns (uint256[])",
];

export const AAVE_ORACLE_ABI = [
  "function getAssetPrice(address asset) view returns (uint256)", // USD, 8 decimals
];
