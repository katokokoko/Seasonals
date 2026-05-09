<!--
  Seasonals PR Template
  CLAUDE.md §11 / §9 と仕様書 §32.2 の整合性チェックを内蔵
-->

## 概要

<!-- なぜこの変更を行うのか / 何を変えるのか を 2-3 行で -->

## 関連仕様

<!-- 仕様書 docs/spec.md のセクション。複数あれば列挙 -->

- §

## 主要な変更点

<!-- 具体的な変更点を箇条書き。実装ファイルの path も -->

-

---

## ✅ §11 実装チェックリスト (CLAUDE.md)

該当する項目をすべてチェックしてから merge する。

- [ ] 型は `@workspace/lib/types` から import している (Mobile / BFF / MCP でローカル定義していない)
- [ ] 金融値は `@workspace/lib/utils/numeric` の helper 経由で扱っている (`Number()` / `parseInt` を金融値に使っていない)
- [ ] enum はリテラルで書かず `lib/types/enums.ts` から import している
- [ ] 色は `DS.color.*` token (`@workspace/lib/design-system`) 経由 (hex 直書きしていない)
- [ ] Pacifico は heading / body に使っていない (ロゴ専用)
- [ ] API 通信は `services/api.ts` 経由 (component から直接 fetch していない)
- [ ] server state は TanStack Query 経由
- [ ] 仕様書 §X.Y への参照をコメントで残した
- [ ] §32.2 整合性チェックの該当行を self-apply した
- [ ] 秘密鍵 / private key を Seasonals 側で扱う API を新設していない (MWA 経由のみ)
- [ ] solana.new skill が生成したコードに上記違反があれば、本書の規約に従って修正した

## ✅ §32.2 ピッチ整合性チェック (該当する範囲のみ)

PR の射程に含まれるピッチ claim にだけチェック。

- [ ] **"one tap"** → §5.7 execution flow が同一 bottom sheet で完結している
- [ ] **"same source of truth"** → `lib/types/` を Mobile / BFF / MCP すべてが import している
- [ ] **"different primitive"** → Snapshot vs Schedule の論点を維持している (§31)
- [ ] **"8 categories of time"** → `TimeEventCategory` が `lib/types/enums.ts` で 8 種、§11.4 / §25.2 / §26 で同一
- [ ] **"agent end-to-end"** → `plan_id` ベースの compare → simulate → approve → execute が一貫
- [ ] **"policy-aware execution"** → §6.4 制約と `UserPolicy` フィールドが 1:1 対応
- [ ] **"auditable agent actions"** → MCPAuditLog と AgentPlan ライフサイクルが `plan_id` でリンク
- [ ] **"fail-closed safety"** → 両 stale / >5% 乖離で execute 拒否 (§29.3)
- [ ] **"accurate amounts"** → smallest unit を `NUMERIC(38, 0)` で格納、`numeric.ts` 経由
- [ ] **"warning は素通りしない"** → 2-5% 乖離が CTA 直上に強警告 + 1 秒グレーアウト
- [ ] **"string と数値が壊れない"** → API boundary 検証 → bigint → NUMERIC、`Number()` 不使用

## ✅ テスト

- [ ] `pnpm test` 通過 (該当 artifact のみ実行でも可)
- [ ] golden test (該当する場合: `deriveTimeEvents` の 8 categories 全網羅)
- [ ] security test (該当する場合: §29.3、両 stale / 乖離 / approval_mode / max_daily / bundle_hash / partial_fill)

## スクリーンショット / 動画 (UI 変更の場合)

<!-- WarningArea / DropletMarker 等の UI 変更時は実機 / シミュレータの screenshot を添付 -->

## メモ

<!-- レビュアーへの補足、TODO、follow-up issue 等 -->
