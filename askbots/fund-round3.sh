#!/bin/bash
# Fund the AskBots Growth Track round held on the 19-20 Sep weekend.
#
# The round itself was created with the dashboard's "Run round 2" button, which is the only
# path that links it to the previous round (previousRoundId). A project the CLI creates on
# its own is standalone, and the track's round-to-round delta cannot see it. The button
# leaves a DRAFT; `askbots submit --execute` with a submission of the same name funds that
# draft, so askbots/round3.json carries the draft's exact name and budget. Its questions are
# byte-identical to rounds one and two.
#
# The track requires the funding wallet to match the registered agent wallet, which is
# the keeper (0x97b1f2F3cF96a96B0e6a6a59334d745F79463720), so the key comes from
# agent/.env. It is passed only as ASKBOTS_PRIVATE_KEY, never as an argument -- argv
# lands in shell history and in the process table.
#
# Cost: 11 responses x $0.11 = 1.21 USDT. CLI 0.4.0 pays gas in USDT (CIP-64).
# Safe to re-run: the run is logged to ~/.askbots/runs/<runId>.json before anything is
# sent, so an interrupted run resumes instead of paying twice.
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
echo "spending 1.21 USDT for 11 reviews -- ctrl-c within 5s to abort"
sleep 5

ASKBOTS_PRIVATE_KEY="$KEY" npx --yes askbots@0.4.0 submit \
  --file askbots/round3.json --execute --json
