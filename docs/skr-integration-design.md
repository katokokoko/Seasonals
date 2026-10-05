# Seasonals × SKR 連携設計 — 入口

バージョン0.4 / 2026-09-20。ハッカソンではR0を実装する。

- **実装者は [R0実装指示書](skr-r0-implementation.md) を読む。** 読取・Calendar・fresh eventのMCP公開・端末確認通知が対象。
- [ロードマップと調査記録](skr-integration-roadmap.md)：R1以降、FND案件、Oracle調査。R0の完了条件には含めない。
- [RFC-001](rfc-oracle-exit-operations.md)：ハッカソン期間中は凍結、未採用。
- [変更履歴](skr-integration-changelog.md)：過去レビューと変更理由。実装規範ではない。

snapshot/eventのrevisionはR0から除外し、通知に必要なschedule_revisionだけを使う。MCPはeventだけを公開し、SKR position・実行は後続へ回す。認証・DB・通知workerの新設はR0に含めない。

次のP0は利用者による手動unstakeの準備とread fixture確保。設計の追加レビューを実装開始の条件にしない。
