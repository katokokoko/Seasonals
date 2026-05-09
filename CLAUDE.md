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

```
project-root/
├── lib/                            # Mobile / BFF / MCP Server 共有 (CRITICAL)
│   ├── types/
│   │   ├── enums.ts                # canonical enum 全部 (TimeEventCategory / PositionCategory 等)
│   │   ├── unified-time-event.ts   # §11.4 + ActionDescriptor + CalendarEvent
│   │   ├── agent-plan.ts           # §11.7 + ActionSpec + SimulationResult + CandidateAction
│   │   ├── approval-token.ts       # §11.8
│   │   ├── user-policy.ts          # §11.6 + USER_POLICY_DEFAULTS
│   │   ├── position.ts             # §11.1 / §11.2 / §11.3 (Wallet / Protocol / Position)
│   │   └── index.ts                # barrel export
│   └── utils/
│       └── numeric.ts              # §4.5 string ↔ bigint 変換 / 検証 / フォーマッタ
├── artifacts/
│   ├── seasonals/                  # Mobile アプリ (Expo + Expo Router)
│   ├── seasonals-bff/              # REST BFF (将来、TypeScript / NestJS or Go)
│   ├── seasonals-mcp-server/       # MCP Server (将来、TypeScript SDK)
│   ├── seasonals-adapters/         # Adapter SDK + protocol 実装 (将来)
│   └── seasonals-pricing/          # Pyth / Switchboard 統合 (将来)
├── docs/
│   ├── spec.md                     # 仕様書 v0.2.15 (フル参照用)
│   ├── design-system.md            # Cream Soda Edition、token reference
│   └── design-system.jsx           # 原典 (DS object source of truth)
└── replit.md                       # 旧 Replit Agent 用 context (historical)
```

### `lib/` からの import 規約 (CRITICAL)

すべての Mobile / BFF / MCP Server コードは:

```typescript
import {
  UnifiedTimeEvent,
  AgentPlan,
  ActionSpec,
  ApprovalToken,
  UserPolicy,
  TimeEventCategory,
  PositionCategory,
  ActionType,
  AgentPlanStatus,
  // ...
} from "@workspace/lib/types";

import {
  toBigInt,
  toHumanReadable,
  toSmallestUnit,
  formatUsd,
  assertTokenAmount,
  isValidTokenAmount,
} from "@workspace/lib/utils/numeric";
```

の形で `lib/` から型と numeric helper を取得する。**Mobile / BFF / MCP Server で型をローカル定義しない**。

### 既存プロトタイプの位置づけ
`artifacts/seasonals/` は **UX リファレンス** として機能する (画面遷移・配置・droplet marker の visual)。
本番化では仕様書 §27.1 の構成を canonical として、規約に合わない部分は遠慮なく書き換える。
プロトタイプの実装をそのまま継承することは目的ではない。

---

## 2. 命名規約 (§4.4)

### action_type
- canonical: **snake_case**
- 12 種は `lib/types/enums.ts` の `ActionType` を import して参照
- ハイフン区切り (`re-deposit`) / 区切りなし (`redeposit`) は **API / DB レベルで禁止**
- UI 表示用ラベル (`"Re-deposit (include yield)"`) は presentation layer で `display_label` として保持

### enum (canonical 値の数 / source of truth)
| enum | 種数 | source |
|---|---|---|
| `TimeEventCategory` | 8 | `lib/types/enums.ts` |
| `PositionCategory` | 10 | `lib/types/enums.ts` |
| `Urgency` | 3 | `lib/types/enums.ts` |
| `ApprovalMode` | 4 | `lib/types/enums.ts` |
| `AgentPlanStatus` | 10 | `lib/types/enums.ts` |
| `ExecutionJobStatus` | 7 | `lib/types/enums.ts` |
| `ActionType` | 12 | `lib/types/enums.ts` |
| `Objective` | 7 | `lib/types/enums.ts` |
| `TrustLevel` | 4 | `lib/types/enums.ts` |

すべての enum 変更は §32.2 整合性チェックの対象。**`lib/types/enums.ts` の値と仕様書 §X.Y の値は必ず一致させる**。

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

### 設計意図
- simulate は情報提供 tool → 警告付きで結果を見せる方が情報量が大きい
- execute は実資金が動く → >5% 乖離は **flash crash / oracle attack の可能性** として fail-closed で拒否
- 閾値は trusted protocol registry で override 可能 (§13.2、`Protocol.metadata.oracle_divergence_*_threshold`)
- すべての block / warning は §17.1 で `oracle_block` / `oracle_warning` イベントとして記録

---

## 5. クライアント実装スタック (§4.2)

| レイヤー | 技術 |
|---|---|
| Framework | Expo (React Native) |
| Routing | Expo Router (file-based) |
| Wallet | `@solana-mobile/mobile-wallet-adapter-protocol-web3js` |
| local UI state | React hooks (`useState` / `useReducer`) |
| global state | **Zustand** (Jotai 可) |
| server state | **TanStack Query** (fetch 直叩き禁止) |
| 永続化 (non-secret) | AsyncStorage |
| 秘密鍵 | **保持しない** (Solana Seed Vault に MWA 経由で署名委譲) |
| Charts | recharts (web) + native fallback (`Charts.tsx` / `Charts.web.tsx`) |
| Animation | React Native Reanimated 3 |
| Gesture | React Native Gesture Handler |
| Haptics | expo-haptics |
| Blur | expo-blur (`BlurView` で glassmorphism 代替) |
| Test | jest-expo + `@testing-library/react-native` |
| Build | EAS Build |
| 言語 | TypeScript (strict mode) |

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

## 7. solana.new skills 連携

リポジトリは [solana.new](https://www.solana.new/) (sendaifun/solana-new) でセットアップした **25 journey skills + 77 ecosystem skills + 53 MCPs** を併用する前提で動く。

インストール:
```bash
curl -fsSL https://www.solana.new/setup.sh | bash
```

skill は `~/.claude/skills/` に展開される。Seasonals リポジトリ固有の規約は本 CLAUDE.md、Solana エコシステム全般の知識は solana.new skill が担う **分業構造**。

### Seasonals に強く効く skill

| skill | 使う場面 | 関連セクション |
|---|---|---|
| `build-mobile` | Mobile (Expo + RN + MWA) 実装全般 | §27 (Mobile 構成) |
| `build-defi-protocol` | Adapter SDK 実装 / token math / CPIs | §13 / §26 (Adapter Pattern) |
| `build-data-pipeline` | Portfolio Indexer 実装 (account / tx 追跡) | §10.2 Portfolio Indexer |
| `defillama-research` | Tier S protocol 候補の TVL 調査 | §28 MVP プロトコル選定 |
| `competitive-landscape` | Jupiter Portfolio との差別化整理 | §31 競合認識 |
| `scaffold-project` | 新規 artifact 立ち上げ時 (seasonals-bff 等) | §27.1 |
| `review-and-iterate` | PR 前のコードレビュー | §32.2 整合性チェックと併用 |
| `cso` | セキュリティ監査前の self-check | §11.6 approval_mode auto 解放条件 |
| `roast-my-product` | pitch 前のレビュー | §22 / §32 |

### ecosystem skill (77種から Seasonals 関連)

- **Kamino skill** — Tier S protocol、§28.2 名指し (lending / vault adapter 実装)
- **Jupiter skill** — 競合認識 (§31) + 価格情報 fallback として参照可能
- **Helius skill** — RPC / DAS API、Portfolio Indexer (§10.2) の wallet position 取得
- **Marinade / Sanctum / Jito skill** — LST / Restaking 系 protocol adapter 実装
- **Privy / Phantom skill** — wallet 連携の参考 (Seasonals は MWA 中心だが知識として)
- **Streamflow skill** — vesting protocol、Tier S protocol の 1 つ

### MCP (53種から Seasonals 関連)

`.mcp.json` でリポジトリ単位で接続するもの:
- **Helius MCP** — wallet positions / transactions の取得 (Portfolio Indexer 実装時)
- **Jupiter MCP** — token price / swap routing
- **Solscan MCP** — transaction 履歴 / address 解析
- **DexScreener MCP** — token / pool metrics

### skill 利用時のルール

- **Seasonals 固有の規約は本 CLAUDE.md が優先**。solana.new skill が異なる推奨をしてきた場合、本書の規約に従う (例: 数値型、命名、`lib/` 経由 import)
- skill のコード生成結果は §32.2 整合性チェックを self-apply してから commit
- skill が `Number()` / `parseInt` を金融値に使うコードを生成したら、必ず `numeric.ts` 経由に書き換える (§4.5)
- `.superstack/` 配下の context ファイル (skill 間 handoff) は `.gitignore` 入りでもよいが、`.superstack/idea-context.md` だけは pitch 文脈との整合性確認用に commit する判断もあり

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

---

## 9. 整合性チェック (§32.2) — PR 前 self-check

PR を出す前 / コードレビューを依頼する前に、関連する行を self-check すること。

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

---

## 10. 直近の実装タスク (§21、優先順位順)

既存プロトタイプを起点とした **本番化フェーズの差分タスク**。依存関係が小さい順:

1. ✅ **`lib/` 共通型整備** — `lib/types/*.ts` + `lib/utils/numeric.ts` 完了
2. ✅ **TanStack Query 導入** — `services/{queryClient,api,queries}.ts`、6 query hook + 4 mutation hook、fixture path / HTTP path を `IS_TEST_ENV` で切替
3. ✅ **`WarningArea` component** — §8.5 / §8.7、oracle warning + CTA 1 秒グレーアウト、test 18 ケース
4. ✅ **MWA 実接続** — `@solana-mobile/mobile-wallet-adapter-protocol-web3js` v2.2.8、Zustand walletStore + expo-secure-store persist、Seeker での Phantom Devnet round-trip 確認済 (#8 と一体)
5. ✅ **AsyncStorage mock → BFF API 接続** — `artifacts/seasonals-bff/` (Fastify + zod) 11 endpoint、Mobile `services/api.ts` を fetch 経由に書換、BFF integration test 18 ケース
6. ✅ **MCPClientApprovalCard / MCPApprovalPushCard** — §8.6 / §8.7、PushCard は WarningArea + expires_at counter 内蔵、test 16 ケース
7. ✅ **MCP approval push handler** — Expo Push Notifications + `seasonals://approval/<planId>?token=<tokenId>` deep link、`app/approval/[planId].tsx` route + `services/push.ts`、test 14 ケース
8. ✅ **Seed Vault 連携確認** — code grep で `Keypair` / `secretKey` / `mnemonic` 等 0 件、Seeker 実機で MWA round-trip (Phantom 経由) 確認済。Seed Vault path も device 設定で同 probe screen から到達可能
9. ✅ **EAS Build pipeline** — `eas.json` 3 profiles (dev / preview / production)、Android-only / apk / `appVersionSource: remote`、`pnpm build:{dev,preview,prod}` script、`.easignore` 整備

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
- [solana.new](https://www.solana.new/) — SendAI + Superteam の curated skills (§7)
- [GitHub: sendaifun/solana-new](https://github.com/sendaifun/solana-new)
- **Solana Mobile Wallet Adapter (MWA)**:
  - [GitHub: solana-mobile/mobile-wallet-adapter](https://github.com/solana-mobile/mobile-wallet-adapter) — 公式 monorepo (`js/packages/mobile-wallet-adapter-protocol-web3js` を Seasonals が採用)
  - [RN setup](https://docs.solanamobile.com/react-native/setup) / [RN quickstart](https://docs.solanamobile.com/react-native/quickstart)
  - [example-react-native-app](https://github.com/solana-mobile/mobile-wallet-adapter/tree/main/examples/example-react-native-app) — RN 統合の参照実装。`services/mwa.ts` 実装時の primary reference
  - [プロトコル仕様](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html)
- [Solana Mobile Stack](https://github.com/solana-mobile/solana-mobile-stack-sdk) — Seed Vault / dApp Store 含む全体
- [Expo Router](https://expo.github.io/router/) — file-based routing
- [TanStack Query](https://tanstack.com/query) — server state management

### 既存
- `artifacts/seasonals/` — 既存プロトタイプ (UX リファレンスとしてのみ参照)
- `replit.md` — 旧 Replit Agent 用 context (historical、本番化フェーズでは参照優先度低)

---

**End of CLAUDE.md — Seasonals Project Context (synced with spec v0.2.15)**
