#!/usr/bin/env bash
#
# ts-guard.sh — PostToolUse (Edit|Write) typecheck guard for the Seasonals monorepo.
#
# Runs `tsc --noEmit` for the workspace of the edited file and surfaces ONLY
# newly-introduced TypeScript errors — pre-existing errors are recorded in a
# baseline and ignored, so the hook never cries wolf over library/config
# type-def mismatches that predate the current work.
#
# Non-blocking: emits new errors back to Claude as additionalContext (exit 0).
# This respects multi-file editing — intermediate states that don't typecheck
# yet won't hard-block; Claude sees the new errors and resolves them by the end.
#
# Baseline refresh (run after intentionally changing the known-error set):
#   for ws in lib bff mobile; do
#     case $ws in
#       lib)    dir=lib ;;
#       bff)    dir=artifacts/seasonals-bff ;;
#       mobile) dir=artifacts/seasonals ;;
#     esac
#     ( cd "$dir" && pnpm exec tsc --noEmit 2>&1 ) | grep "error TS" \
#       | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u \
#       > ".claude/ts-baseline/$ws.txt"
#   done

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$ROOT" ] && exit 0
cd "$ROOT" 2>/dev/null || exit 0

# Read the edited file path from the PostToolUse JSON payload on stdin.
payload="$(cat)"
file="$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -z "$file" ] && exit 0

# Only react to TypeScript sources.
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Map the edited file to a workspace (name, dir, baseline key).
rel="${file#"$ROOT"/}"
case "$rel" in
  lib/*)                    name="lib";    dir="lib" ;;
  artifacts/seasonals-bff/*) name="bff";   dir="artifacts/seasonals-bff" ;;
  artifacts/seasonals/*)    name="mobile"; dir="artifacts/seasonals" ;;
  *) exit 0 ;;
esac

baseline=".claude/ts-baseline/$name.txt"
[ -f "$baseline" ] || : > "$baseline"

# Current errors, normalized (drop (line,col) so line shifts don't read as new).
current="$( ( cd "$dir" && pnpm exec tsc --noEmit 2>&1 ) \
  | grep "error TS" | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u )"

[ -z "$current" ] && exit 0

# New = present now but not in baseline.
new="$(comm -23 <(printf '%s\n' "$current") <(sort -u "$baseline"))"
[ -z "$new" ] && exit 0

count="$(printf '%s\n' "$new" | grep -c .)"
msg="⚠️  ts-guard: $count new TypeScript error(s) in $name workspace (introduced this turn):
$(printf '%s\n' "$new" | head -20)

These are NEW vs the recorded baseline. Fix before declaring the phase done, or refresh the baseline if intentional (see .claude/hooks/ts-guard.sh header)."

# Feed back to Claude as non-blocking context.
printf '%s' "$payload" >/dev/null
esc="$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$esc"
exit 0
