#!/usr/bin/env bash
#
# adb-reverse-keepalive.sh — Seeker 実機開発中に `adb reverse` を維持し続ける。
#
# なぜ必要か:
#   Seeker からは BFF (:3030) と Metro (:8081) に `adb reverse` 経由で届いている
#   (仕組みは artifacts/seasonals/services/config.ts のヘッダ参照)。この転送は
#   adb の USB セッションに紐づくため、端末スリープ / USB 抜き差し / adb サーバ
#   再起動で **黙って消える**。しかも消えた時の見え方が紛らわしい:
#     - 8.93 で onFail:"throw" にした経路 (positions / earn / prices /
#       portfolio-history) は cache を保持したまま固まる
#       → 画面は生きているのに数字が古いまま
#     - fixture fallback 側の経路は SHOULD_FALLBACK_TO_FIXTURES が効いて
#       fixture 表示に化ける → 一見動いているように見える
#   どちらもエラー画面が出ないので adb を疑うまでに時間がかかる (2026-09-21 実観測)。
#   張り直せばアプリ側は 8.93 の自己回復 (error 状態の 30 秒リトライ) が自力で
#   拾うため、張り直しさえ自動化すればこの事象は消える。
#
# 何をするか:
#   - 端末がオンラインの間、reverse tcp:3030 / tcp:8081 が生きているか監視し、
#     欠けたものだけ張り直す
#   - 端末が切断されたら待機し、再接続を検知したら自動で張り直す
#   - ログは「状態が変わった時だけ」出す (常駐しても画面が流れない)
#
# 何をしないか:
#   BFF / Metro の死活は見ない。アプリの起動・再起動もしない。
#
# 前提:
#   - `adb` が PATH にあること
#   - Seeker が USB 接続済みで USB デバッグ有効
#   - 複数端末を繋いでいる場合は ANDROID_SERIAL で対象を指定する
#
# 使い方:
#   pnpm dev:device          # BFF / Metro とは別ターミナルで常駐、Ctrl-C で終了
#   ADB_KEEPALIVE_POLL_SEC=2 pnpm dev:device   # 監視間隔を変える (既定 5 秒)
#
# 終了コード: 0 = 正常終了 (Ctrl-C 含む) / 1 = adb が見つからない
#
# 注: macOS 標準の bash は 3.2 なので、空配列 + `set -u` で壊れないよう配列は
#     使わずスペース区切り文字列を回している。

set -uo pipefail

PORTS="3030 8081"
POLL_SEC="${ADB_KEEPALIVE_POLL_SEC:-5}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb-reverse-keepalive: adb が PATH にありません。" >&2
  echo "  Android SDK platform-tools を PATH に通すか、brew install android-platform-tools" >&2
  exit 1
fi

log() {
  printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"
}

# 対象端末が "device" 状態か (unauthorized / offline は対象外)。
# ANDROID_SERIAL が設定されていれば adb はその端末を対象に動くので、判定側も
# 同じ端末だけを見る (未設定なら「どれか 1 台でもオンラインか」)。
device_online() {
  adb devices 2>/dev/null | awk -v want="${ANDROID_SERIAL:-}" '
    NR > 1 && $2 == "device" && (want == "" || $1 == want) { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

# 欠けている reverse だけを張り直す。張り直した時だけログを出す。
ensure_reverse() {
  local list port
  list="$(adb reverse --list 2>/dev/null)" || list=""

  for port in $PORTS; do
    case "$list" in
      *"tcp:$port tcp:$port"*) continue ;;
    esac

    if adb reverse "tcp:$port" "tcp:$port" >/dev/null 2>&1; then
      log "✓ reverse tcp:$port を張り直しました"
    else
      log "✗ reverse tcp:$port に失敗 (端末を確認してください)"
    fi
  done
}

trap 'printf "\n"; log "停止しました"; exit 0' INT TERM

log "adb reverse keepalive 開始 (ports: $PORTS / ${POLL_SEC}s 間隔)"

# "" = 未確定 / online = 接続中 / offline = 切断中
state=""

while true; do
  if device_online; then
    if [ "$state" != "online" ]; then
      log "✓ 端末を検出しました"
      state="online"
    fi
    ensure_reverse
  else
    if [ "$state" != "offline" ]; then
      log "⚠ 端末が見つかりません — 再接続を待機中"
      state="offline"
    fi
  fi

  sleep "$POLL_SEC"
done
