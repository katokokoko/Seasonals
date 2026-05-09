---
description: §32.2 整合性チェックを現在の作業ツリーに self-apply する
---

直近のコード変更 (`git diff` または直前のメッセージで議論されている変更) に対して、CLAUDE.md §9 の整合性チェックを **すべて** self-apply してください。

## 手順

1. 直近の変更内容を確認 (`git status` + `git diff`、または会話 context から)
2. 以下の各項目について該当の有無を判定し、該当する場合は **コードレベルで担保されているか** 確認:

### CLAUDE.md §11 実装チェックリスト

- [ ] 型は `@workspace/lib/types` から import している?
- [ ] 金融値は `@workspace/lib/utils/numeric` 経由で扱っている?(`Number()` / `parseInt` を使っていない?)
- [ ] enum はリテラルで書かず `lib/types/enums.ts` から import している?
- [ ] 色は `DS.color.*` token 経由?(hex 直書きしていない?)
- [ ] Pacifico を heading/body に使っていない?
- [ ] API 通信は `services/api.ts` 経由?
- [ ] server state は TanStack Query 経由?
- [ ] 仕様書 §X.Y への参照をコメントで残した?
- [ ] 秘密鍵 / private key を扱う API を新設していない?
- [ ] solana.new skill が生成したコードに上記違反があれば修正した?

### CLAUDE.md §9 ピッチ整合性 (該当する PR の範囲で)

- [ ] "one tap" → 同一 bottom sheet で完結
- [ ] "same source of truth" → `lib/types/` を import
- [ ] "8 categories of time" → `TimeEventCategory` 8 種で一貫
- [ ] "agent end-to-end" → `plan_id` ベース
- [ ] "policy-aware execution" → `UserPolicy` フィールドが §6.4 と 1:1
- [ ] "auditable agent actions" → MCPAuditLog と AgentPlan が `plan_id` でリンク
- [ ] "fail-closed safety" → 両 stale / >5% 乖離で execute 拒否
- [ ] "accurate amounts" → smallest unit を `NUMERIC(38, 0)` で格納
- [ ] "warning は素通りしない" → 2-5% 乖離が CTA 直上 + 1 秒グレーアウト
- [ ] "string と数値が壊れない" → API boundary 検証 → bigint → NUMERIC

3. 違反が見つかった場合:
   - 違反箇所を `<path>:<line>` 形式で指摘
   - 推奨される修正方針を 1-3 行で提示
   - 修正のための concrete code edit を提案

4. 違反なしの場合: ✅ で各チェック項目を済ませた旨を報告

## 出力形式

```
## §32.2 整合性チェック結果

✅ 通過: <件数>
❌ 違反: <件数>

### 違反詳細
<path>:<line>
  違反: <type>
  推奨修正: <fix>
```
