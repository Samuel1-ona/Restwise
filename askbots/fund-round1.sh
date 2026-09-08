#!/bin/bash
# Fund the AskBots round-one baseline for Restwise.
#
# The track requires the funding wallet to match the registered agent wallet, which is
# the keeper (0x97b1f2F3cF96a96B0e6a6a59334d745F79463720), so the key comes from
# agent/.env. It is passed only as ASKBOTS_PRIVATE_KEY, never as an argument -- argv
# lands in shell history and in the process table.
#
# Cost: 10 responses x $0.11 = 1.10 USDT, plus gas in CELO.
# Safe to re-run: askbots logs each step to ~/.askbots/runs/<runId>.json before sending,
# so an interrupted run resumes instead of paying twice.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=$(grep '^KEEPER_PRIVATE_KEY=' agent/.env | cut -d= -f2- | tr -d '"'"'"'[:space:]')
case "$KEY" in
  0x*) ;;
  *) KEY="0x$KEY" ;;
esac

if [ ${#KEY} -ne 66 ]; then
  echo "refusing to run: KEEPER_PRIVATE_KEY is ${#KEY} chars, expected 66 (0x + 64 hex)" >&2
  exit 1
fi

echo "funding wallet should be 0x97b1f2F3cF96a96B0e6a6a59334d745F79463720"
echo "spending 1.10 USDT for 10 reviews -- ctrl-c within 5s to abort"
sleep 5

ASKBOTS_PRIVATE_KEY="$KEY" npx --yes askbots@0.2.0 submit \
  --file askbots/round1.json --execute --json
