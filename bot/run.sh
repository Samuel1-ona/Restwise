#!/usr/bin/env bash
# Restwise local bot runner (ops tooling — intentionally not committed).
#
# Runs the public keeper agent from ../agent at an hourly cadence with tightened
# but still net-profitable economics, alongside the x402 fee server so every
# realized fee settles through the Celo facilitator automatically.
#
# Usage:  ./run.sh            (foreground)
#         nohup ./run.sh > bot.log 2>&1 &   (detached)
set -euo pipefail
cd "$(dirname "$0")/../agent"

export INTERVAL_MS=900000       # evaluate every 15 min (skips are free — read-only)
export MIN_DELTA_BPS=10         # act on real yield edges >= 0.10%
export SAFETY_MARGIN=1.5        # expected gain must beat 1.5x (gas + swap cost)
export REBALANCE_PERIOD_DAYS=30 # stable-lending spreads persist ~weeks; evaluate moves on a 30d horizon
export MIN_FEE_TO_SETTLE=0.00005 # settle small-but-real fees as x402 payments
export X402_FEE_ENDPOINT=http://localhost:4021/realize-fee

echo "[bot] starting fee server"
node fee-server.js &
FEE_PID=$!
trap 'kill "$FEE_PID" 2>/dev/null || true' EXIT

# wait for the fee server before the first evaluation
for _ in $(seq 1 15); do
  curl -sf http://localhost:4021/health >/dev/null && break
  sleep 1
done

echo "[bot] starting hourly keeper"
node rebalance-agent.js
