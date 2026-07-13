import "dotenv/config";

// Celo mainnet addresses, verified on-chain 2026-07.
export const TOKENS = {
  USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
  USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
  USDm: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18 },
};

// The four yield venues the agent chooses between. Moola only lists USDm.
export const VENUES = [
  { id: "aave-USDT", protocol: "aave", symbol: "USDT" },
  { id: "aave-USDC", protocol: "aave", symbol: "USDC" },
  { id: "aave-USDm", protocol: "aave", symbol: "USDm" },
  { id: "moola-USDm", protocol: "moola", symbol: "USDm" },
];

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://forno.celo.org",
  chainId: Number(process.env.CHAIN_ID ?? 42220),

  vaultAddress: process.env.VAULT_ADDRESS,

  aavePool: process.env.AAVE_POOL ?? "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
  moolaPool: process.env.MOOLA_POOL ?? "0x970b12522CA9b4054807a2c5B736149a5BE6f670",
  aaveOracle: process.env.AAVE_ORACLE ?? "0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b",
  celoToken: "0x471EcE3750Da237f93B8E339c536989b8978a438",
  mentoRouter: process.env.MENTO_ROUTER ?? "0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6",
  fpmmFactory: process.env.FPMM_FACTORY ?? "0xa849b475FE5a4B5C9C3280152c7a1945b907613b",
  routeHub: "0x765DE816845861e75A25fCA122bb6898B8B1282a", // USDm — all FPMM pools pair against it

  keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY,

  // Decision parameters (all tunable without code changes)
  minDeltaBps: Number(process.env.MIN_DELTA_BPS ?? 25), // ignore APY gaps under 0.25%
  rebalancePeriodDays: Number(process.env.REBALANCE_PERIOD_DAYS ?? 1), // expected holding period of the edge
  safetyMargin: Number(process.env.SAFETY_MARGIN ?? 3), // gain must exceed gas+swap cost by this factor
  quoteSlackBps: Number(process.env.QUOTE_SLACK_BPS ?? 10), // minOut = live quote minus this
  intervalMs: Number(process.env.INTERVAL_MS ?? 6 * 60 * 60 * 1000), // 6h between checks

  // x402 fee settlement
  feeEndpoint: process.env.X402_FEE_ENDPOINT, // e.g. http://localhost:4021/realize-fee
  thirdwebClientId: process.env.THIRDWEB_CLIENT_ID,
  minFeeToSettle: Number(process.env.MIN_FEE_TO_SETTLE ?? 0.01), // dollars
  feeClaimSymbol: process.env.FEE_CLAIM_SYMBOL ?? "USDm", // asset fees are released in

  decisionsLog: process.env.DECISIONS_LOG ?? new URL("./decisions.json", import.meta.url).pathname,
};

export function requireConfig(...keys) {
  for (const key of keys) {
    if (!config[key]) throw new Error(`Missing required env for config.${key} — see .env.example`);
  }
}
