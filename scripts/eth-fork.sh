#!/usr/bin/env bash
#
# eth-fork.sh — Ethereum mainnet の Anvil fork を起動する (実行デモ専用、docs/web/WORKLOG.md)
#
#   bash scripts/eth-fork.sh            # 127.0.0.1:8545、chain id 1
#
# - RPC URL は artifacts/seasonals-bff/.env の ETHEREUM_RPC_URL / INFURA_API_KEY から組み立てる。
#   anvil は fork URL を argv でしか受けないので、key 入り URL は env 経由で
#   scripts/rpc-proxy.mjs (127.0.0.1:8546) にだけ渡し、anvil には proxy の URL を渡す
#   (process 一覧に key を出さない)
# - anvil の出力は key / URL を伏せて artifacts/seasonals-bff/.data/anvil.log (gitignore) に書く
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
ENV_FILE="$ROOT/artifacts/seasonals-bff/.env"
ANVIL="${ANVIL:-$HOME/.foundry/bin/anvil}"
[ -x "$ANVIL" ] || { echo "anvil not found (install Foundry: https://getfoundry.sh)"; exit 1; }

get() { { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | tr -d '"'; }
URL="$(get ETHEREUM_RPC_URL)"
KEY="$(get INFURA_API_KEY)"
[ -z "$URL" ] && [ -n "$KEY" ] && URL="https://mainnet.infura.io/v3/$KEY"
[ -n "$URL" ] || { echo "Set INFURA_API_KEY or ETHEREUM_RPC_URL in $ENV_FILE"; exit 1; }

mkdir -p "$ROOT/artifacts/seasonals-bff/.data"
LOG="$ROOT/artifacts/seasonals-bff/.data/anvil.log"
UPSTREAM_RPC_URL="$URL" node "$ROOT/scripts/rpc-proxy.mjs" >> "$LOG" 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null' EXIT
sleep 1
echo "anvil fork → 127.0.0.1:8545 (log: ${LOG#$ROOT/})"
"$ANVIL" --fork-url http://127.0.0.1:8546 --chain-id 1 --port 8545 --host 127.0.0.1 --compute-units-per-second 60 --retries 10 --fork-retry-backoff 1500 2>&1 \
  | REDACT_URL="$URL" REDACT_KEY="${KEY:-}" perl -pe 'BEGIN { $| = 1 } s/\Q$ENV{REDACT_URL}\E/<redacted-rpc-url>/g; s/\Q$ENV{REDACT_KEY}\E/<redacted>/g if length $ENV{REDACT_KEY}; s#https?://\S*infura\S*#<redacted-rpc-url>#g' >> "$LOG"
