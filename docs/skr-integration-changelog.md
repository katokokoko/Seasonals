# SKR連携設計 変更履歴

履歴資料。実装規範は [R0指示書](skr-r0-implementation.md)、後続判断は [ロードマップ](skr-integration-roadmap.md)。

## 0.4.2 — 2026-10-08 (実機確認)

- R0-10 を Seeker 実機 (Android 16) で demo source を使い無人実行し、全 9 項目 + ready 遷移が pass → **R0-DEMO 合格**。結果と観測値は [R0指示書 §7](skr-r0-implementation.md)。LIVE-01/02 は未実施 (手動 unstake 待ち)
- Calendar の day modal (`EventDayModal`) が実機で開かない既存不具合を発見 (gorhom v5 で未 present の sheet に `dismiss()` を呼ぶと `DISMISSING` に固まる。SDK 57 更新由来、SKR 起因でない)。fix + 回帰 test は別 PR #36
- dev の BFF URL を env `BFF_BASE_URL` で差し替え可能に (別ポート並走、runbook §2.1)。無人確認の手順を runbook §3.1 に追加
- 実機で分かった制約を runbook §3 / §5 と roadmap §2 に反映: inexact alarm による配送遅延 (予定までの約 75%)、MCP は BFF 全体停止で resource error、adb の cold start 再現は `am kill`

## 0.4.1 — 2026-10-05 (実装)

- R0 を実装 (lib 共有型 / BFF read 口 / MCP 投影 / mobile row・Calendar 詳細・確認通知・境界 retry)。結果表は [R0指示書 §7](skr-r0-implementation.md)
- 指示書の規範は変えていない。実装で確定した解釈 (pending は token 量、unknown の意味、非 active pool は unsupported、MCP 補足は contents[1]、Staking section の置き場) を §7 に記録
- roadmap §6 に Oracle 前提の更新を追記 (Hermes / Switchboard → Solana push feed。R0 には影響なし)

## 0.4 — 2026-09-20

- R0のsnapshot_revisionとevent revision、position.state_hashを削除。共有vault/pool等のraw dataが他人の操作で変わる問題と、R0にconsumerがない計算を除いた。
- schedule_revisionだけを本人のtimestampと適用cooldownの文字列キーで生成。SHA-256/正規化JSONの仕組みを削除。
- retry予算永続化、時計変更対策、通知response二重処理抑止、batch内競合fixtureをSHOULDへ。MUSTテストは10件に整理し、実機/fixture準備込みの計画を6–9人日へ変更。
- MCPはfreshなeventのみ公開。position非公開・actions空を維持し、両consumerのpositionRefをnullに統一。Mobileの詳細はread responseへ直接解決する。
- 手動unstakeとlive fixture確保をP0化。利用者が量を決定して操作し、readを実装と並行する。第2protocolはSHOULD。
- R0、後続ロードマップ、履歴に分割。設計の追加レビューを実装開始ゲートにしない。
- Oracleをsandbox外の通常curlで再検証。稼働中BFF環境の未確認と開発ホストでの再現を区別。
- RFCをハッカソン期間中凍結。再開時は手動自己withdrawの数量上限/移行画面を除き、fee/rent・非価格policyを中心に簡素化する。

## 0.3 — 2026-09-19

- RFCのaccount owner/token authority/UserStakeの権利を分離し、正常vaultを拒否しない検査へ修正。
- 共有wrapper・3種revisionと通知payloadを具体化（3種revisionは0.4で廃止）。
- 単一account batch、表示期限、失敗時表示、デモ/liveの別ゲートを追加。

## 0.2 — 2026-09-19

- R0を読取・Calendar・端末確認通知に限定し、認証/DB/outbox/実行をFND案件へ分離。
- spec実ファイルを照合し、「spec不在を実装ゲートに残す」を撤回。
- ゼロplaceholderをnullable専用共有型へ変更し、既存consumerへの混入を防止。
- cycleをobserved_onlyの汎用cooldown_cyclesへ。取引系譜復元を削除。
- cancelを出口から除外、Oracle例外を独立RFC化。wallet message改変の拒否方針と互換性検証を追加。
- 監視頻度を粗くし境界retryを限定。公式通知の有無と価格feedの登録/可用性を分けて記録。

## 0.1

初稿。状態導出・金融値・実行安全性を設計したが、SKR固有機能と基盤再構築の境界が広すぎた。
