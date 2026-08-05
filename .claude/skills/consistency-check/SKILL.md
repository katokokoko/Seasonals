---
name: consistency-check
description: PR を出す前 / コードレビューを依頼する前の §32.2 整合性 self-check。pitch の主張 (one tap / same source of truth / fail-closed safety / 秘密鍵を保持しない 等) が実装で担保されているかを対応表で確認する。
---

# 整合性チェック (§32.2) — PR 前 self-check

PR を出す前 / コードレビューを依頼する前に、変更が触れた行を self-check すること。

| pitch claim | 実装での担保 |
|---|---|
| "one tap" | §5.7 execution flow が同一 bottom sheet で完結 |
| "same source of truth" | `lib/types/` を Mobile / BFF / MCP すべてが import |
| "different primitive" | Snapshot vs Schedule の論点維持 (§31) |
| "8 categories of time" | `TimeEventCategory` が `lib/types/enums.ts` で 8 種、§11.4 / §25.2 / §26 で同一 |
| "agent end-to-end" | `plan_id` ベースの compare → simulate → approve → execute |
| "policy-aware execution" | §6.4 制約と `UserPolicy` フィールドが 1:1 対応 |
| "auditable agent actions" | MCPAuditLog と AgentPlan ライフサイクルが `plan_id` でリンク |
| "fail-closed safety" | 両 stale / >5% 乖離で execute 拒否 (§29.3) |
| "accurate amounts" | smallest unit を `NUMERIC(38, 0)` で格納、`numeric.ts` 経由 |
| "warning は素通りしない" | 2-5% 乖離が CTA 直上に強警告 + 1 秒グレーアウト |
| "string と数値が壊れない" | API boundary 検証 → bigint → NUMERIC、`Number()` 不使用 |
| "秘密鍵を保持しない" | Mobile / lib コードに `Keypair` / `secretKey` / `mnemonic` 等 0 件 (grep)、署名は MWA `transact()` 経由で Seed Vault / Phantom に完全委譲、authToken は expo-secure-store (Android Keystore) に暗号保存 |

## 注意

上記のうち **安全側の規約そのもの** (数値表現 §4.5 / Oracle fail-closed §4.6 /
秘密鍵を扱う API の禁止) は CLAUDE.md に常駐している。この表は
「主張と実装が食い違っていないか」の確認手順であって、規約の出典ではない。
