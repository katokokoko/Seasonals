# Seasonals — Claude Code Project Context

> 本書は Claude Code が Seasonals リポジトリで作業する際の **常時参照ドキュメント** である。
> 仕様書 v0.2.15 (`docs/spec.md`、3300+ 行) の中でも、実装中に毎回参照される規約だけを圧縮して埋め込んでいる。
> 詳細が必要な場合は `docs/spec.md` の §X.Y を引くこと。

---

## 0. プロダクト概要

**Seasonals** は Solana DeFi の time primitive。
- 8 種の時間イベント (maturity / epoch / claim / health / vesting_cliff / vote_deadline / lockup_end / forecast_marker) をカレンダー中心 UI で管理
- 1 画面で simulate → approve → execute まで完結 (tab-hopping ゼロ)
- MCP-native architecture: 人間は Calendar UI を、AI Agent は MCP endpoint を読む。**Same source of truth**

差別化キラーフレーズ:
- "Snapshot vs Schedule" (Jupiter Portfolio との別カテゴリ宣言)
- "One tap. Rebalanced. No new tab."
- "Humans read the calendar. Agents read the API. Same source of truth."

---

## 1. リポジトリ構成

pnpm workspace monorepo。`lib/` の共通型を Mobile / BFF / MCP Server すべてが import することで、TypeScript レベルで "same source of truth" を担保する。

構成は `ls` / `find` で確認する (`lib/` = 共有型、`artifacts/` = 各 workspace、`docs/` = 設計文書)。

### `lib/` からの import 規約 (CRITICAL)

すべての Mobile / BFF / MCP Server コードは、型を `@workspace/lib/types` (barrel export `lib/types/index.ts` から全部取れる)、金融値 helper を `@workspace/lib/utils/numeric` から import する。**Mobile / BFF / MCP Server で型をローカル定義しない**。

```typescript
import { UnifiedTimeEvent, ActionType /* ... */ } from "@workspace/lib/types";
import { toBigInt, assertTokenAmount /* ... */ } from "@workspace/lib/utils/numeric";
```

### 既存プロトタイプの位置づけ
`artifacts/seasonals/` は **UX リファレンス** として機能する (画面遷移・配置・droplet marker の visual)。
本番化では仕様書 §27.1 の構成を canonical として、規約に合わない部分は遠慮なく書き換える。
プロトタイプの実装をそのまま継承することは目的ではない。

### Backend core pipeline
wallet transaction / account indexing から `Position`、`UnifiedTimeEvent`、Menu / Calendar action execution へ接続する本番化設計は `docs/backend-core-pipeline.md` を参照する。
この文書は、認証 wallet の tx 追跡、trusted protocol parser、deposit / withdraw / maturity / lockup derivation、`deposit` / `withdraw` / `re_deposit` / `rotate` 実行フローの canonical plan である。

---

## 2. 命名規約 (§4.4)

### action_type
- canonical: **snake_case**
- 12 種は `lib/types/enums.ts` の `ActionType` を import して参照
- ハイフン区切り (`re-deposit`) / 区切りなし (`redeposit`) は **API / DB レベルで禁止**
- UI 表示用ラベル (`"Re-deposit (include yield)"`) は presentation layer で `display_label` として保持

### enum
canonical enum (`TimeEventCategory` / `PositionCategory` / `ActionType` 等 9 種) の source of truth は **`lib/types/enums.ts`**。値はリテラルで書かず import して参照する。すべての enum 変更は §32.2 整合性チェックの対象で、**`lib/types/enums.ts` の値と仕様書 §X.Y の値は必ず一致させる**。

### 用語表記
| 用語 | canonical | 補足 |
|---|---|---|
| `MCP Server` | 大文字 S | コンポーネント名 |
| `Agent` | 大文字 A | 主体・名詞 |
| `agent` | 小文字 | 複合語 (`agent-native` / `agent runtime`) |
| `Wallet` | 大文字 | エンティティ / 画面名 |
| `wallet` | 小文字 | 英文中の一般名詞 |
| `ウォレット` | カタカナ | 日本語文章中 |

---

## 3. 数値表現規約 (§4.5) — CRITICAL

JavaScript / TypeScript の `Number` は IEEE 754 倍精度浮動小数点で、金融値には精度不足。

### 金融値 (token amount / USD / 価格 / fee / TVL)

#### API / DB
- token amount は **smallest unit を string** で保持
  - 1.5 USDC (decimals=6) → `"1500000"`
  - 0.5 SOL (lamports) → `"500000000"`
- USD 換算 (`max_tx_amount` 等) は **8 decimals の string** (`"1234.56789012"`)
- DB 型:
  - token amount → `NUMERIC(38, 0)` (整数のみ)
  - USD 換算 → `NUMERIC(38, 8)`
  - パーセンテージ (APY / risk_score、0..1) → `NUMERIC(18, 8)`

#### 必ず `lib/utils/numeric.ts` を経由

```typescript
import {
  assertTokenAmount,    // API boundary 検証 (throw on invalid)
  isValidTokenAmount,   // boolean 判定
  toBigInt,             // string → bigint (Core Service 内)
  fromBigInt,           // bigint → string (response 直前)
  toSmallestUnit,       // human "1.5" → smallest "1500000"
  toHumanReadable,      // smallest "1500000" → human "1.5"
  formatTokenAmount,    // 表示用 ("1,500.00")
  formatUsd,            // 表示用 ("$1,234.56")
} from "@workspace/lib/utils/numeric";
```

#### レイヤー別変換責務

```
[Client] → string
   ↓
[API boundary] ← assertTokenAmount() / regex 検証 (parse はしない)
   ↓ string (検証済み)
[Core Service] ← toBigInt() で bigint 変換、内部演算
   ↓ bigint
[ORM] ← NUMERIC(38, 0) にマッピング (Prisma BigInt / TypeORM Decimal)
   ↓
[Postgres]
```

API boundary の regex (`numeric.ts` の `TOKEN_AMOUNT_REGEX` / `USD_AMOUNT_REGEX`):
- token amount: `^[0-9]+$` (不一致 → REST `400 invalid_amount` / MCP `invalid_argument`)
- USD: `^[0-9]+(\.[0-9]{1,8})?$`

### 禁止事項 (金融値のみ)
- API boundary で `parseInt` / `Number()` を使う (精度落ち)
- Core Service で string のまま算術演算
- DB 書き込み時に文字列結合で SQL を組み立てる (ORM 経由必須)
- 金融値を `lib/utils/numeric.ts` を経由せず変換する

### 適用外 (通常の整数として扱ってよい)
- UI pagination の `pageSize` / `pageIndex`
- 配列 index、loop counter
- HTTP status code
- `decimals` / `slippage_bps` / `lock_days` 等の小整数フィールド
- APY / risk_score (0..1 のパーセンテージ、Number 精度で十分)

**判断基準**: 精度が落ちると **会計的・金融的に意味のある誤差** が出るか?
出るなら金融値、出ないなら通常通り扱ってよい。

---

## 4. Oracle 規約 (§4.6) — fail-closed

oracle 異常時は **常に止める方を選ぶ**。warning だけで素通りさせない。

- primary: **Pyth Network**
- fallback: **Switchboard**
- staleness 閾値: 60 秒

### staleness による block

| 状態 | simulate | execute |
|---|---|---|
| Pyth fresh | 通す | 通す |
| Pyth stale + Switchboard fresh | Switchboard を使う + warning | Switchboard を使う + warning |
| 両 stale | **拒否** (`oracle_both_stale`) | **拒否** (`oracle_both_stale`) |
| 両 未取得 | **拒否** (`oracle_unavailable`) | **拒否** (`oracle_unavailable`) |

### oracle 間乖離による block

| 乖離 (中央値からの ±%) | simulate | execute |
|---|---|---|
| ≤ 2% | 通す | 通す |
| 2-5% | 通す + warning (`oracle_divergence_warning`) | 通す + warning |
| > 5% | 通す + warning | **拒否** (`oracle_divergence_too_large`) |

設計意図: simulate は情報提供 tool (警告付きで見せる)、execute は実資金が動く (>5% 乖離 = flash crash / oracle attack の可能性として拒否)。閾値は trusted protocol registry で override 可 (§13.2)、全 block / warning は §17.1 でイベント記録。

---

## 5. クライアント実装スタック (§4.2)

使用ライブラリは `artifacts/seasonals/package.json` を見る。**選択の理由**だけここに残す:

- **server state は TanStack Query** — fetch 直叩き禁止 (cache / 再取得の一元化)
- **global state は Zustand** (Jotai 可)、local UI state は React hooks
- **秘密鍵は保持しない** — Solana Seed Vault に MWA 経由で署名委譲
- Charts は web/native で実装分離 (`Charts.tsx` / `Charts.web.tsx`)
- TypeScript strict mode

### Mobile 実装規約
- 型は **`lib/` から import** (Mobile 内で型をローカル定義しない、§1 参照)
- API 通信は **`services/api.ts` 経由** に集約
- token amount は string で受け渡し、**UI 直前** で `toHumanReadable` / `formatTokenAmount` 経由
- `WarningArea` component が oracle warning 表示の **唯一の入口** (CTA 1 秒グレーアウトを内包)
- 秘密鍵 / private key を Seasonals 側で扱う API は禁止 (MWA 経由のみ)

---

## 6. デザインシステム規約

詳細は `docs/design-system.md` 参照。以下は最頻参照のみ。

### 色
- **必ず `DS.color.*` token 経由** で参照する。hex 直書き禁止
- 主要 token: `sodaText` (#00ACC1), `melonText` (#2E9968), `caramel` (#C4956A), `cherryDark` (#D32F2F), `textSubtitle` (#5D4E47), `textMuted` (#8D7E76)
- primary gradient: `linear-gradient(135deg, sodaText, melonText)`

### Typography
- **Pacifico** = ロゴ・ブランド表示専用 (script)
- **Quicksand** = heading / body / UI 全般 (geometric sans)
- **JetBrains Mono** = code / hex / data
- Pacifico を heading や body に使うのは **禁止**

### Surface
- 標準カードは `GlassCard` component 経由
- React Native では `expo-blur` の `BlurView` で代替
- bg: `rgba(255, 255, 255, 0.35)` + `blur(16px)`
- border: `1px solid rgba(255, 255, 255, 0.5)`
- radius: `DS.radius.lg` (16px)

### 数値表示
- portfolio value / APY / earned 等は `DS.fontSize.displaySM` 以上 + `DS.weight.bold`
- 正の値は `melonText` (成長・利回り)、負/警告は `cherryDark`

### Time Event Marker (droplet)
- 8 カテゴリ × urgency 3 段階の visual marker
- 詳細: `docs/design-system.md` §7 / `docs/spec.md` §9.3

---

## 7. skill 利用時のルール

> [solana.new](https://www.solana.new/) の 32 skill は 2026-08-03 に `~/.claude/settings.json` の `skillOverrides` で無効化済 (10 か月間ほぼ未使用。`"off"` を消せば復帰)。使える skill は毎セッションの skill 一覧に出る。

- **Seasonals 固有の規約は本 CLAUDE.md が優先**。skill が異なる推奨をしてきた場合、本書の規約に従う (例: 数値型、命名、`lib/` 経由 import)
- skill のコード生成結果は §32.2 整合性チェックを self-apply してから commit
- skill が `Number()` / `parseInt` を金融値に使うコードを生成したら、必ず `numeric.ts` 経由に書き換える (§4.5)

---

## 8. テスト規約

- Mobile: **jest-expo** + `@testing-library/react-native`
- Backend: jest + supertest
- golden test: `deriveTimeEvents` の 8 categories 全網羅 (§29.1)
- security test (§29.3):
  - 両 oracle stale で execute 拒否
  - 乖離 >5% で execute 拒否
  - `approval_mode = manual_only` 違反
  - `max_daily_executions` 超過
  - `bundle_hash` 不一致
  - partial_fill ケースの approval_token 再利用拒否
  - `approval_mode = auto` の feature flag 検証

### 8.1 Phase 完了ゲート (CRITICAL)

multi-file 変更や §21 phase を「完了」と宣言する **前に**、必ず以下を green にすること。ツーリングを実際に走らせる前に done と言わない:

```bash
pnpm -r test        # 全 workspace の jest (現状: 150 mobile / 67 lib / 22 BFF)
pnpm -r typecheck   # 全 workspace の tsc --noEmit
```

- 個別 workspace のみ変えた時は該当 workspace の `pnpm test` / `pnpm typecheck` でよいが、`lib/` を触ったら 3 workspace 全部に波及するので `-r` で回す
- mobile の実機確認が要る変更 (UI / MWA / tx) は Seeker onchain APK で JS reload して logcat エラーなしまで見る (§5)

### 8.2 ts-guard hook (自動 typecheck)

`.claude/settings.json` の PostToolUse hook (`.claude/hooks/ts-guard.sh`) が Edit/Write 毎に **編集した workspace の `tsc --noEmit`** を走らせ、**baseline に無い新規 TS error だけ** を非ブロッキングで通知する (pre-existing の library / config 型エラーは `.claude/ts-baseline/*.txt` に記録済で無視)。

- 新規エラーが出たら phase 完了前に直す
- 既知エラーを意図的に増減させた時は baseline を refresh (手順は `ts-guard.sh` 冒頭コメント)

### 8.3 jest / metro config の既知パターン (regression 禁止)

`artifacts/seasonals/jest.config.js` と `metro.config.js` は過去の試行錯誤で確定した設定で、**論拠は各 config 自身のコメントに書いてある。変更する前に必ずコメントを読むこと** (transformIgnorePatterns / .mjs transform / forceExit / monorepo symlink 解決など、消すと壊れる)。

- TanStack Query: `gcTime` を過度に短くしない (cache GC で server state が消える)

---

## 9. 整合性チェック (§32.2) — PR 前 self-check

PR / コードレビュー前の pitch claim ↔ 実装の対応表は
**`.claude/skills/consistency-check/`** に移した (PR 前にだけ使うので遅延読み込み)。
規約そのもの (§3 数値表現 / §4 Oracle fail-closed / 秘密鍵禁止) は本書に常駐。

---

## 10. 直近の実装タスク (§21、優先順位順)

完了済みタスクは git log を参照。**未着手の要約だけ**を以下に残す。
詳細 (経緯 / program ID / バージョン実測) は `docs/backlog.md` §E (local-only) が canonical。

- **依存リフレッシュ** (残り 1 種): major 跨ぎ (`@types/node` / `date-fns` / `@fastify/cors` / **TypeScript 6.0** — SDK 57 期待、`expo.install.exclude` で保留中)。
  ✅ Expo SDK 57 + newArch + native module 群 + MWA 2.2.9 は Phase 8.87 で完了 (経緯は docs/expo57-upgrade.md)
  - SDK 更新時は §8.1 完了ゲートに加えて **`pnpm --filter @seasonals/bff verify:tx`** (全 23 経路 mainnet simulate、署名なし) を必ず通す
  - root pnpm override 3 点 (`rpc-websockets` / `utf-8-validate` / skia の `onlyBuiltDependencies`) は **load-bearing、外さない** (経緯は package.json `//overrides` と backlog.md §E)
  - `@solendprotocol/solend-sdk` の global fetch 上書き問題 → orca-tx.ts / meteora-tx.ts の undici 明示利用は**継続が必要**
- **Exponent PT 売買 (buy)** (優先度中): 着手条件は Jupiter が PT mint を route し始めるか Exponent TS SDK の npm 公開。それまで menu は `display_only` で agent 候補からも除外 (fail-closed)
- **Velocity spot-lend adapter** (旧 Drift 後継、優先度中): 着手条件は公開 relaunch + SDK 安定 + spot market 構成の実 SDK 再調査

---

## 11. Claude Code が新規ファイルを作る/編集する時のチェックリスト

- [ ] 型は `@workspace/lib/types` から import したか?(Mobile 内ローカル定義になっていないか)
- [ ] 金融値を扱うなら `@workspace/lib/utils/numeric` の helper を使ったか?(`Number()` / `parseInt` を金融値に使っていないか)
- [ ] enum の値はリテラルで書かず `lib/types/enums.ts` から import したか?
- [ ] 色は `DS.color.*` token 経由か?(hex 直書きしていないか)
- [ ] Pacifico を heading/body に使っていないか?(ロゴ専用)
- [ ] API 通信は `services/api.ts` 経由か?(コンポーネントから直接 fetch していないか)
- [ ] server state は TanStack Query 経由か?
- [ ] 仕様書 §X.Y への参照をコメントで残したか?
- [ ] §32.2 整合性チェックの該当行があれば self-check したか?
- [ ] 秘密鍵 / private key を扱う API を新設していないか?
- [ ] solana.new skill が生成したコードに上記違反があれば、本 CLAUDE.md に従って修正したか?

---

## 12. 参考資料

### 内部
- `docs/spec.md` — 仕様書 v0.2.15 (Development Master、フル)
- `docs/design-system.md` — デザインシステム human-readable 抜粋
- `docs/design-system.jsx` — デザインシステム原典 (DS object source of truth)
- `lib/types/index.ts` — 共通型 barrel export (ここから全部取れる)
- `lib/utils/numeric.ts` — 金融値の string ↔ bigint 変換 helper

### 外部
- **MWA**: [solana-mobile/mobile-wallet-adapter](https://github.com/solana-mobile/mobile-wallet-adapter) (公式 monorepo、`mobile-wallet-adapter-protocol-web3js` を採用。examples/ に RN 参照実装) + [RN docs](https://docs.solanamobile.com/react-native/setup)

### 既存
- `artifacts/seasonals/` — 既存プロトタイプ (UX リファレンスとしてのみ参照)
- `replit.md` — 旧 Replit Agent 用 context (historical、本番化フェーズでは参照優先度低)

---

**End of CLAUDE.md — Seasonals Project Context (synced with spec v0.2.15)**
