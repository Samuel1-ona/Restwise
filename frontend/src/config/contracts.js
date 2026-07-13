import { parseAbi } from "viem";

// Celo mainnet addresses, verified on-chain 2026-07.
export const TOKENS = {
  USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
  USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
  USDm: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18 },
};
export const SYMBOLS = Object.keys(TOKENS);

// The four yield venues. Colors are fixed categorical slots (never cycled) shared
// between the allocation view and the chart so a venue keeps its hue everywhere.
export const VENUES = [
  { id: "aave-USDT", protocol: "aave", symbol: "USDT", label: "Aave · USDT", colorVar: "--series-2" },
  { id: "aave-USDC", protocol: "aave", symbol: "USDC", label: "Aave · USDC", colorVar: "--series-3" },
  { id: "aave-USDm", protocol: "aave", symbol: "USDm", label: "Aave · USDm", colorVar: "--series-4" },
  { id: "moola-USDm", protocol: "moola", symbol: "USDm", label: "Moola · USDm", colorVar: "--series-5" },
];

export const ADDRESSES = {
  aavePool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
  moolaPool: "0x970b12522CA9b4054807a2c5B736149a5BE6f670",
};

// Vault address resolution: URL ?vault=0x... beats env, and sticks in localStorage
// so the same static build works against any deployment.
const fromQuery = new URLSearchParams(window.location.search).get("vault");
if (fromQuery) localStorage.setItem("restwise.vault", fromQuery);
export const VAULT_ADDRESS =
  fromQuery ?? localStorage.getItem("restwise.vault") ?? import.meta.env.VITE_VAULT_ADDRESS ?? null;

export const VAULT_ABI = parseAbi([
  "function currentAllocation() view returns (address[] assets, uint256[] idle, uint256[] inAave, uint256[] inMoola, uint256 totalNormalized)",
  "function totalAssets() view returns (uint256)",
  "function accruedFees() view returns (uint256)",
  "function pricePerShare() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function deposit(address asset, uint256 amount) returns (uint256)",
  "function withdraw(uint256 shares, address asset) returns (uint256)",
  "event Rebalanced(address indexed fromAsset, bool fromMoola, address indexed toAsset, bool toMoola, uint256 amountIn, uint256 amountOut, uint256 fromApyBps, uint256 toApyBps)",
  "event FeeRealized(uint256 grossYield, uint256 fee, uint256 newHighWaterMark)",
  "event FeeClaimed(address indexed to, address indexed asset, uint256 amount)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

// Aave v3 ReserveDataLegacy / Moola (Aave v2 fork) reserve structs — only
// currentLiquidityRate matters here (supply APR in ray, 1e27).
export const AAVE_POOL_ABI = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

export const MOOLA_POOL_ABI = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))",
]);

export function rayToApyBps(rate) {
  const apr = Number(rate) / 1e27;
  const apy = (1 + apr / 31_536_000) ** 31_536_000 - 1;
  return Math.round(apy * 10_000);
}

export function symbolFor(address) {
  return SYMBOLS.find((s) => TOKENS[s].address.toLowerCase() === address?.toLowerCase()) ?? "?";
}
