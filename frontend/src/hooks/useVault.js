import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import {
  ADDRESSES, TOKENS, VENUES, VAULT_ADDRESS, VAULT_ABI,
  AAVE_POOL_ABI, MOOLA_POOL_ABI, rayToApyBps,
} from "../config/contracts";

const LIVE = { refetchInterval: 15_000 }; // dashboard stays live without reloads

/** Supply APY of all four venues, straight from on-chain reserve data. */
export function useVenueApys() {
  const { data, isLoading } = useReadContracts({
    contracts: VENUES.map((v) => ({
      address: v.protocol === "aave" ? ADDRESSES.aavePool : ADDRESSES.moolaPool,
      abi: v.protocol === "aave" ? AAVE_POOL_ABI : MOOLA_POOL_ABI,
      functionName: "getReserveData",
      args: [TOKENS[v.symbol].address],
    })),
    query: LIVE,
  });
  return {
    isLoading,
    venues: VENUES.map((v, i) => ({
      ...v,
      apyBps: data?.[i]?.result ? rayToApyBps(data[i].result.currentLiquidityRate) : null,
    })),
  };
}

/** Vault-level state: per-venue balances (in USD), totals, price per share. */
export function useVault() {
  const enabled = Boolean(VAULT_ADDRESS);
  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "currentAllocation" },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "totalAssets" },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "pricePerShare" },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "accruedFees" },
    ],
    query: { ...LIVE, enabled },
  });
  const [allocation, totalAssets, pps, accruedFees] = (data ?? []).map((d) => d?.result);

  // Map on-chain (assets[], idle[], inAave[], inMoola[]) onto the venue list, in USD.
  let venueUsd = null;
  let idleUsd = 0;
  if (allocation) {
    const [assets, idle, inAave, inMoola] = allocation;
    const indexOf = (symbol) =>
      assets.findIndex((a) => a.toLowerCase() === TOKENS[symbol].address.toLowerCase());
    venueUsd = Object.fromEntries(
      VENUES.map((v) => {
        const i = indexOf(v.symbol);
        const raw = i < 0 ? 0n : v.protocol === "aave" ? inAave[i] : inMoola[i];
        return [v.id, Number(formatUnits(raw, TOKENS[v.symbol].decimals))];
      })
    );
    idleUsd = assets.reduce(
      (sum, a, i) =>
        sum +
        Number(formatUnits(idle[i], TOKENS[Object.keys(TOKENS).find((s) => TOKENS[s].address.toLowerCase() === a.toLowerCase())]?.decimals ?? 18)),
      0
    );
  }

  return {
    hasVault: enabled,
    isLoading,
    refetch,
    venueUsd,
    idleUsd,
    totalUsd: totalAssets != null ? Number(formatUnits(totalAssets, 18)) : null,
    pps,
    accruedFees,
  };
}

/** The connected user's share balance and its current USD value. */
export function usePosition() {
  const { address } = useAccount();
  const { data: shares, refetch: refetchShares } = useReadContract({
    address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "balanceOf", args: [address],
    query: { ...LIVE, enabled: Boolean(VAULT_ADDRESS && address) },
  });
  const { data: normAssets } = useReadContract({
    address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "convertToAssets", args: [shares ?? 0n],
    query: { ...LIVE, enabled: Boolean(VAULT_ADDRESS && shares != null) },
  });
  return {
    shares,
    usd: normAssets != null ? Number(formatUnits(normAssets, 18)) : null,
    refetchShares,
  };
}
