#!/usr/bin/env bash
#
# typecheck-baseline.sh — 全 workspace の tsc --noEmit を回し、
# .claude/ts-baseline/*.txt に無い「新規」TS エラーだけを報告する (CLAUDE.md §8.1 / §8.2)。
# 新規エラーが 1 件でもあれば exit 1。
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
status=0
for pair in lib:lib bff:artifacts/seasonals-bff mobile:artifacts/seasonals mcp:artifacts/seasonals-mcp-server web:artifacts/seasonals-web; do
  name="${pair%%:*}"; dir="${pair#*:}"
  current="$( (cd "$dir" && pnpm exec tsc --noEmit 2>&1) | grep "error TS" | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u)"
  baseline=""
  [ -f ".claude/ts-baseline/$name.txt" ] && baseline="$(cat ".claude/ts-baseline/$name.txt")"
  new="$(comm -23 <(printf '%s\n' "$current" | sed '/^$/d') <(printf '%s\n' "$baseline" | sed '/^$/d'))"
  total="$(printf '%s\n' "$current" | grep -c 'error TS')"
  added="$(printf '%s\n' "$new" | grep -c 'error TS')"
  echo "$name: errors=$total new=$added"
  if [ "$added" -gt 0 ]; then printf '%s\n' "$new"; status=1; fi
done
exit $status
