# Restwise local bot (not committed)

Local ops runner for the public keeper in `../agent`. No product logic lives here —
it only sets a faster cadence and tighter (still net-profitable) thresholds, and
keeps the x402 fee server alive next to the agent.

| Override | Value | Meaning |
|---|---|---|
| `INTERVAL_MS` | 3600000 | evaluate hourly instead of every 6h |
| `MIN_DELTA_BPS` | 10 | act on APY edges ≥ 0.10% |
| `SAFETY_MARGIN` | 1.5 | gain must beat 1.5× (gas + swap) — every tx stays profitable |
| `MIN_FEE_TO_SETTLE` | 0.001 | settle small real fees via api.x402.celo.org |

Start: `nohup ./run.sh > bot.log 2>&1 &`
Stop:  `pkill -f rebalance-agent && pkill -f fee-server`
Logs:  `tail -f bot.log` and `../agent/decisions.json`

Note: the GitHub Actions cron (every 6h) still runs as a backup heartbeat with
conservative defaults. Both use the same keeper wallet; a rare simultaneous
rebalance attempt would just fail one nonce harmlessly.
