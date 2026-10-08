#!/usr/bin/env bash
#
# eth-fork.sh — Ethereum mainnet の Anvil fork を起動する (実行デモ専用、docs/web/WORKLOG.md)
#
#   bash scripts/eth-fork.sh                  # 127.0.0.1:8545、chain id 1
#   FORK_REFRESH=1 bash scripts/eth-fork.sh   # 固定 block を捨てて最新 block で fork し直す
#
# - fork block は .data/fork-block に固定し、FORK_MAX_AGE_H (既定 24) 時間は同じ block を使う。
#   同じ block なら ~/.foundry/cache/rpc/mainnet/<block>/ の state cache が再起動後も効き、
#   上流 RPC (Infura) から storage slot を取り直さない。毎回 latest だと cache が効かず credit を浪費する
#   (2026-10-05 実測: 7 block 分の cache が溜まっていた)。永久固定しないのは、Uniswap Trading API の
#   quote (mainnet の現在値) と fork 状態がずれて swap が revert するのを避けるため
# - 上流 URL は .env の FORK_UPSTREAM_RPC_URL を優先 (例: Alchemy free の key で Infura の枠と分ける)。
#   無ければ ETHEREUM_RPC_URL / INFURA_API_KEY から組み立てる。
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
FORK_URL="$(get FORK_UPSTREAM_RPC_URL)"
[ -n "$FORK_URL" ] && URL="$FORK_URL"
[ -n "$URL" ] || { echo "Set FORK_UPSTREAM_RPC_URL, INFURA_API_KEY or ETHEREUM_RPC_URL in $ENV_FILE"; exit 1; }

mkdir -p "$ROOT/artifacts/seasonals-bff/.data"
LOG="$ROOT/artifacts/seasonals-bff/.data/anvil.log"
UPSTREAM_RPC_URL="$URL" node "$ROOT/scripts/rpc-proxy.mjs" >> "$LOG" 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null' EXIT
sleep 1

BLOCK_FILE="$ROOT/artifacts/seasonals-bff/.data/fork-block"
MAX_AGE_S=$(( ${FORK_MAX_AGE_H:-24} * 3600 ))
BLOCK=""
if [ -z "${FORK_REFRESH:-}" ] && [ -s "$BLOCK_FILE" ]; then
  AGE=$(perl -e 'print time - (stat shift)[9]' "$BLOCK_FILE")
  [ "$AGE" -lt "$MAX_AGE_S" ] && BLOCK="$(tr -dc 0-9 < "$BLOCK_FILE")"
fi
if [ -z "$BLOCK" ]; then
  # key 入り URL を argv に出さないよう、最新 block も proxy 経由で取る
  HEX=$(curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:8546 \
    | sed -E 's/.*"result":"(0x[0-9a-fA-F]+)".*/\1/' || true)
  case "$HEX" in 0x*) ;; *) echo "could not read the latest block from the upstream RPC"; exit 1 ;; esac
  BLOCK=$(printf '%d' "$HEX")
  echo "$BLOCK" > "$BLOCK_FILE"
  echo "fork block pinned → $BLOCK (new; reused for ${FORK_MAX_AGE_H:-24}h, FORK_REFRESH=1 to renew)"
else
  echo "fork block pinned → $BLOCK (reused; FORK_REFRESH=1 to renew)"
fi

echo "anvil fork → 127.0.0.1:8545 (log: ${LOG#$ROOT/})"
"$ANVIL" --fork-url http://127.0.0.1:8546 --fork-block-number "$BLOCK" --chain-id 1 --port 8545 --host 127.0.0.1 --compute-units-per-second 60 --retries 10 --fork-retry-backoff 1500 2>&1 \
  | REDACT_URL="$URL" REDACT_KEY="${KEY:-}" perl -pe 'BEGIN { $| = 1 } s/\Q$ENV{REDACT_URL}\E/<redacted-rpc-url>/g; s/\Q$ENV{REDACT_KEY}\E/<redacted>/g if length $ENV{REDACT_KEY}; s#https?://\S*infura\S*#<redacted-rpc-url>#g' >> "$LOG"
