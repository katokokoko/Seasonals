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
5. 通知: 終了予定に「SKRの引き出し状況を確認してください」が届く。tap で app が開き BFF を再取得する
   - 短く確認するなら `SKR_DEMO_UNLOCK_IN_SECONDS=120` で BFF を再起動する (同じ event id のまま予定が動き、旧予約は置換される)
6. 通知 permission を拒否しても Calendar は表示される
7. app を終了した状態で通知を tap (cold start) → 起動後に再取得する
8. MCP の `seasonals://events/<wallet>` に同じ id / triggerAt の event がある。BFF を止めると SKR event は 0 件になり、補足文が付く
9. logcat にエラーが無い

## 4. 追加解除の録画 (live、P0)

利用者が公式ポータルで量を決めて操作する。アシスタントは資金操作を代行しない。

1. 1 回目の unstake 後、live で Calendar と MCP に予定が出ることを録る
2. 終了予定の **前に** 追加の unstake を行う (ready 後は WithdrawRequired で追加解除できない)
3. 再取得すると同じ event id のまま triggerAt が延び、確認通知が置換されることを録る
4. 前後の raw batch を `lib/__fixtures__/skr-staking/` に保存する (LIVE-01)。API key 付き URL・秘密鍵は保存しない

## 5. 既知の制約

- OS 通知の配送時刻は保証しない (Android の exact alarm 制限)。実機での遅延は結果表に記録する
- app 停止中の外部変更は追跡しない。古い確認通知が届き得るが、tap で最新 read に解決する
- 任意の wallet を読める read 口は本人認証ではない (R0 は既存のデモ / 開発環境で使う)
