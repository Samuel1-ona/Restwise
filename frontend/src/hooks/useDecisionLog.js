import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import { TOKENS, VAULT_ADDRESS, VAULT_ABI, symbolFor } from "../config/contracts";

const usd = (raw, decimals, d = 2) =>
  Number(formatUnits(raw, decimals)).toLocaleString(undefined, { maximumFractionDigits: d });

/** Rebalance + fee events straight from the chain — the agent's audit trail. */
export function useDecisionLog() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["decisionLog", VAULT_ADDRESS],
    enabled: Boolean(VAULT_ADDRESS && client),
    refetchInterval: 30_000,
    queryFn: async () => {
      const latest = await client.getBlockNumber();
      const RANGE = 5_000n; // Forno rejects eth_getLogs spans above 5k blocks
      const LOOKBACK = 49_999n;
      const start = latest > LOOKBACK ? latest - LOOKBACK : 0n;
      const events = VAULT_ABI.filter((f) => f.type === "event");
      const requests = [];
      for (let from = start; from <= latest; from += RANGE) {
        const to = from + RANGE - 1n < latest ? from + RANGE - 1n : latest;
        requests.push(client.getLogs({ address: VAULT_ADDRESS, events, fromBlock: from, toBlock: to }));
      }
      const logs = (await Promise.all(requests)).flat();
      return logs
        .map((log) => {
          if (log.eventName === "Rebalanced") {
            const { fromAsset, fromMoola, toAsset, toMoola, amountIn, fromApyBps, toApyBps } = log.args;
            const fromSym = symbolFor(fromAsset);
            const toSym = symbolFor(toAsset);
            const from = `${fromMoola ? "Moola" : "Aave"}·${fromSym}`;
            const to = `${toMoola ? "Moola" : "Aave"}·${toSym}`;
            return {
              block: Number(log.blockNumber),
              action: `${from} → ${to}`,
              amount: `$${usd(amountIn, TOKENS[fromSym]?.decimals ?? 18)}`,
              why: `${Number(toApyBps) - Number(fromApyBps)}bps edge (${(Number(fromApyBps) / 100).toFixed(2)}% → ${(Number(toApyBps) / 100).toFixed(2)}%)${fromSym !== toSym ? ", swapped via Mento" : ""}`,
            };
          }
          if (log.eventName === "FeeRealized") {
            return {
              block: Number(log.blockNumber),
              action: "fee realized",
              amount: `$${usd(log.args.fee, 18, 4)}`,
              why: "10% of yield above high-water mark, settled via x402",
            };
          }
          if (log.eventName === "FeeClaimed") {
            const sym = symbolFor(log.args.asset);
            return {
              block: Number(log.blockNumber),
              action: "fee claimed",
              amount: `$${usd(log.args.amount, TOKENS[sym]?.decimals ?? 18, 4)}`,
              why: `x402 payment settled — fee released in ${sym}`,
            };
          }
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => b.block - a.block);
    },
  });
}
