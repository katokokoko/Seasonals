# SKR R0 デモ / 実機確認 runbook

2026-10-05。[R0指示書](skr-r0-implementation.md) の R0-10 (Seeker 実機) と録画のための起動手順。
すべてのコマンドに `PATH=/opt/homebrew/bin:$PATH` を前置する。

## 1. source を決める

| 目的 | BFF | Metro | 表示 |
|---|---|---|---|
| live (実 mainnet) | `HELIUS_API_KEY` のみ | `SKR_SOURCE` を付けない | source=live |
| demo (録画用 fixture) | `SKR_DEMO_FIXTURE=true` | `SKR_SOURCE=demo` | Staking row / Calendar 詳細に **Demo** pill |

- demo は取得済み mainnet batch (config / pool / vault / mint) を replay し、UserStake と Clock だけを合成する。live の失敗を demo に差し替えることは無い。
- demo の終了予定は **BFF 起動時刻 + `SKR_DEMO_UNLOCK_IN_SECONDS`** (既定 1800 秒)。poll しても予定キーは変わらない。
- `SKR_DEMO_SCENARIO` で `cooling_down` (既定) / `ready` / `none` / `absent` / `unsupported` を切り替える。

## 2. 起動

```sh
# BFF (demo の例。live なら SKR_DEMO_* を外す)
cd artifacts/seasonals-bff
SKR_DEMO_FIXTURE=true SKR_DEMO_UNLOCK_IN_SECONDS=300 pnpm dev

# Metro (APP_VARIANT=onchain 必須。無いと devnet に落ちる)
cd artifacts/seasonals
APP_VARIANT=onchain EXPO_PUBLIC_USE_ONCHAIN=true SKR_SOURCE=demo pnpm exec expo start --dev-client --port 8081

adb reverse tcp:3030 tcp:3030
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d "seasonals://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" app.seasonals.onchain
```

`expo-notifications` は既に APK に入っているので native の再ビルドは不要 (JS reload で足りる)。

### 2.1 別ポートで並走する (main 側の BFF / Metro を止めずに確認する時)

別セッションが `:3030` / `:8081` を使っている時は、worktree 側を別ポートで立て、app の BFF URL だけを差し替える。`adb reverse` の 3030 / 8081 は触らない。

```sh
# BFF (worktree) :3031
cd artifacts/seasonals-bff
PORT=3031 SKR_DEMO_FIXTURE=true SKR_DEMO_UNLOCK_IN_SECONDS=1200 pnpm dev

# Metro (worktree) :8082。BFF_BASE_URL は app.config.ts が extra.bffBaseUrl に入れる (services/config.ts が参照)
cd artifacts/seasonals
APP_VARIANT=onchain EXPO_PUBLIC_USE_ONCHAIN=true SKR_SOURCE=demo BFF_BASE_URL=http://localhost:3031 \
  pnpm exec expo start --dev-client --port 8082

adb reverse tcp:3031 tcp:3031
adb reverse tcp:8082 tcp:8082
adb shell am start -a android.intent.action.VIEW -d "seasonals://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082" app.seasonals.onchain
```

終了したら `adb reverse --remove tcp:3031` / `--remove tcp:8082` で戻し、元の Metro が生きていれば deep link を `localhost:8081` で再投入して app の bundle を戻す。

BFF の応答を直接見る:

```sh
curl -i 'http://127.0.0.1:3030/protocols/skr-staking/state?wallet=<公開 wallet>&source=demo'
```

MCP (Agent 側) で同じ event を読む: repo root の `.mcp.json` の env に `"SKR_SOURCE": "demo"` を足して Claude Code を起動し、resource `seasonals://events/<公開 wallet>` を読む。live なら何も足さない。

## 3. 確認項目 (R0-10 / LIVE-02)

1. wallet を接続 (onchain APK)。Calendar の終了予定日に lockup_end の droplet が出る
2. その日を tap → 詳細に「SKR staking cooldown」、状態、Unstaking 量、Refresh、公式ポータル link。ActionModal は開かない
3. 下部シートを上げる → 「Staking」section に SKR staking row、Demo pill (demo 時)、Not in totals。portfolio 合計は変わらない
4. 機内モードで Refresh → 観測時刻と awaiting update (stale)。引き出し可能とは言わない
   - adb で代替するなら `adb reverse --remove tcp:<BFF port>`。既存の keep-alive 接続は Fastify の keepAliveTimeout (約 72 秒) まで生きるので、**70 秒以上待ってから** Refresh する
5. 通知: 終了予定に「SKRの引き出し状況を確認してください」が届く。tap で app が開き BFF を再取得する
   - 短く確認するなら `SKR_DEMO_UNLOCK_IN_SECONDS=120` で BFF を再起動する (同じ event id のまま予定が動き、旧予約は置換される)
6. 通知 permission を拒否しても Calendar は表示される
7. app を終了した状態で通知を tap (cold start) → 起動後に再取得する
   - adb で再現する時は `am force-stop` を使わない (Android は force-stop で app の alarm ごと取り消すので通知が来ない)。HOME → `adb shell am kill app.seasonals.onchain` か、最近のアプリから swipe で終了する
8. MCP の `seasonals://events/<wallet>` に同じ id / triggerAt の event がある。SKR の read 口だけが失敗した時 (unavailable / unsupported / `demo_source_disabled` 等) は SKR event 0 件 + contents[1] に `#skr_staking` の補足文。BFF 全体が止まると base の `/time-events/wallet` が先に失敗するので、resource read 自体が error になる (従来どおり)
9. logcat にエラーが無い

### 3.1 無人 (adb だけ) で確認する時のメモ

- RN の `testID` は `adb exec-out uiautomator dump /dev/tty` に `resource-id` として出る (例 `home-calendar-grid-day-2026-10-08`、`home-portfolio-staking-skr-status`)。`bounds` の中心を `adb shell input tap X Y` する。アニメ中は dump が失敗するので 1–2 秒待って再試行
- 通知 permission は `adb shell pm grant app.seasonals.onchain android.permission.POST_NOTIFICATIONS` (拒否側は `pm revoke`)。予約は `adb shell dumpsys alarm | grep -A8 app.seasonals.onchain`、配送済みは `adb shell dumpsys notification --noredact | grep -A14 app.seasonals.onchain`
- 通知 shade は `adb shell cmd statusbar expand-notifications` / `collapse`。tap は shade の uiautomator dump から "SKR staking" の bounds を取る
- 機内モードの代わりに `adb reverse --remove tcp:<BFF port>` で BFF だけを切ると stale を再現できる (Metro は生きたまま)。keep-alive 接続が切れるまで約 72 秒かかるので 70 秒以上待つ。戻すのは `adb reverse tcp:<port> tcp:<port>`
- day modal が開かない時は gorhom の status が `DISMISSING` に固まっている可能性 (PR #36 で `EventDayModal` を修正)。固まった status は Fast Refresh では直らないので、Metro 再起動 + cold start で確認する
- cold start は HOME → `adb shell am kill app.seasonals.onchain` → 通知 tap (`am force-stop` は alarm ごと消すので使わない)。実測では dev-client は launcher を経由せず最後の bundle を直接読んだ。launcher 画面で止まった場合は "Recently opened" の Metro URL を tap して bundle を載せる

## 4. 追加解除の録画 (live、P0)

利用者が公式ポータルで量を決めて操作する。アシスタントは資金操作を代行しない。

1. 1 回目の unstake 後、live で Calendar と MCP に予定が出ることを録る
2. 終了予定の **前に** 追加の unstake を行う (ready 後は WithdrawRequired で追加解除できない)
3. 再取得すると同じ event id のまま triggerAt が延び、確認通知が置換されることを録る
4. 前後の raw batch を `lib/__fixtures__/skr-staking/` に保存する (LIVE-01)。API key 付き URL・秘密鍵は保存しない

## 5. 既知の制約

- OS 通知の配送時刻は保証しない (Android の exact alarm 制限)。**実測 (2026-10-08、Seeker Android 16)**: expo-notifications の DATE trigger は inexact alarm (`window=+…`) で登録され、3 回とも window の末尾で配送された (予定 +385 / +87.5 / +74.4 秒)。window は「予約から予定までの時間 × 約 0.75」なので、48 時間 cooldown を unstake 直後に予約すると数十時間遅れ得る (上限は OS 依存で未確認)。exact alarm 化か予定間際の再予約は R1 で検討 (roadmap §2)
- app 停止中の外部変更は追跡しない。古い確認通知が届き得るが、tap で最新 read に解決する
- 任意の wallet を読める read 口は本人認証ではない (R0 は既存のデモ / 開発環境で使う)
