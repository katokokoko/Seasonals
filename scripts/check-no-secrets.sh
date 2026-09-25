#!/usr/bin/env bash
#
# check-no-secrets.sh — commit / push 前の秘密値漏洩チェック (docs/web/WORKLOG.md)
#
# BFF の .env から秘密値 (*_KEY / *_SECRET / RPC URL) を読み、以下に含まれないことを確認する:
#   1. staged diff (git diff --cached)
#   2. Web build 出力 (artifacts/seasonals-web/dist)
#   3. スクリーンショット / e2e 出力 (artifacts/seasonals-web/.screenshots, e2e/.out)
# 値そのものは絶対に出力しない (変数名だけを報告する)。
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
ENV_FILE="artifacts/seasonals-bff/.env"
[ -f "$ENV_FILE" ] || { echo "check-no-secrets: $ENV_FILE なし (skip)"; exit 0; }

fail=0
while IFS='=' read -r name value; do
  case "$name" in
    *KEY|*SECRET|*TOKEN|*RPC_URL) ;;
    *) continue ;;
  esac
  value="${value%\"}"; value="${value#\"}"
  [ ${#value} -lt 8 ] && continue
  if git diff --cached | grep -qF -- "$value"; then
    echo "LEAK: $name が staged diff に含まれる"; fail=1
  fi
  for dir in artifacts/seasonals-web/dist artifacts/seasonals-web/.screenshots artifacts/seasonals-web/e2e/.out; do
    [ -d "$dir" ] || continue
    if grep -rqF -- "$value" "$dir"; then
      echo "LEAK: $name が $dir に含まれる"; fail=1
    fi
  done
done < <(grep -E '^[A-Z_]+=' "$ENV_FILE")

if [ -d artifacts/seasonals-web/dist ] && grep -rqiE 'infura\.io|trade-api\.gateway\.uniswap' artifacts/seasonals-web/dist; then
  echo "LEAK: client bundle に RPC / Trading API の URL が含まれる"; fail=1
fi
[ $fail -eq 0 ] && echo "check-no-secrets: OK"
exit $fail
