# SKR連携設計 変更履歴

履歴資料。実装規範は [R0指示書](skr-r0-implementation.md)、後続判断は [ロードマップ](skr-integration-roadmap.md)。

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
