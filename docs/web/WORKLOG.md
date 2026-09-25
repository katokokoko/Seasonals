# Seasonals Web (desktop) + Ethereum — 作業ログ

Branch: `ethglobal-tokyo-web` (main から分岐)。ETHGlobal Tokyo 2026 期間中の作業記録。

## 入力資料

| 資料 | 置き場 | 役割 |
|---|---|---|
| UI v2 (`Seasonals_UI_implementation_spec_for_Claude_Code_v2.md`) | `docs/web/ui-spec-v2.md` | 画面構成と操作の主仕様 |
| Water background spec + `water.frag.glsl` | `docs/web/water-background-spec.md`, `artifacts/seasonals-web/src/background/water.frag.glsl` | 背景の主仕様 (shader は byte-identical) |
| Ethereum v3 implementation plan | local-only (commit しない) | Ethereum のイベント・提案・実行・MCP の製品/技術計画 |
| 参照 PNG 12 枚 | local-only | 構図の参考のみ。文字・日付・残高・APY・対応状況は実データの根拠にしない |

## ETHGlobal 参加区分について

このブランチは既存の Seasonals (Solana) monorepo に追加実装している。`lib/` の型・数値 helper・デザイントークン、BFF、MCP Server を再利用しているため、提出時は既存コード再利用を正直に申告する。Classic ("From Scratch") の適格性は主張しない。

## 衝突の判断

優先順位: 今回のユーザー指示 → repo の安全・数値・秘密規約 (CLAUDE.md) → UI v2 / shader spec → Ethereum v3。

| # | 衝突 | 判断 |
|---|---|---|
| 1 | v3「新規 repo / Classic From Scratch」 | 不適用。既存 repo に追加、再利用を申告 |
| 2 | UI v2 §18「計画を報告して承認待ち」 | 今回の依頼で承認済み |
| 3 | v3 の Next.js | 不採用。Vite + React (shader spec の `?raw` 前提) と既存 BFF (Fastify) の server route |
| 4 | UI v2 は nav / toolbar / detail card に `backdrop-filter` を許可、shader spec は禁止 | shader spec を採用 (毎フレーム再合成の性能根拠)。blur は 0、near-opaque cream surface。CLAUDE.md §6 の GlassCard blur は Web では使わない |
| 5 | カード fill: CLAUDE.md 35%+blur / shader spec 80% / UI v2 90–95% | `bgPrimary` 由来の派生 token (lobby 0.92, work 0.88, nav 0.85) を `lib/design-system.ts` に追加 |
| 6 | shader fallback 色 `#CDEEE3` が DS に無い | 派生 token `waterFallback` として追加 (melonLight / sodaLight 由来とコメント) |
| 7 | quiet zone は最大 4、UI v2 は nav + portal 4 + 中央カード | shader は不変。Home は 中央カード / 左列外接矩形 / 右列外接矩形 / nav の 4 rect |
| 8 | work screen の calm preset が shader spec に無い | `waterDefaults.ts` に `waterCalm` を追加 (uniform 値のみ) |
| 9 | v3 の `amountUsd: number` / `z.number()` | CLAUDE.md §3 優先: 金額は smallest-unit string + decimals、USD は 8 桁 string |
| 10 | v3 enum が SCREAMING_CASE | lib の canonical は snake_case |
| 11 | v3「価格は実行経路に入れない」 vs CLAUDE.md §4 fail-closed | 時刻のみの action (claim / redeem / unstake) は価格非依存。価格依存 action (swap / pegged LP) は Chainlink stale・欠損・乖離で拒否 |
| 12 | v3 は CCA factory 3 つ、公式 repo は v2.1.0 `0x000000001F26a0044BaA66024e7b6599c61963F8` を含む 4 つ | 公式に従い 4 つを index |
| 13 | UI v2 status 5 種 vs v3 EventStatus 5 種 | 表示層で対応: upcoming/due→upcoming (due は today cue)、overdue→warning、done→completed、user_plan→planned、失敗 receipt→failed |
| 14 | CI は Node 20、最新 vitest/jsdom/react-router は Node 22+ | vite 7 / vitest 3.2 / jsdom 26 / react-router 7 を採用 |

## 必要な環境変数 (すべて server 側、BFF の `.env`)

| 変数 | 用途 |
|---|---|
| `INFURA_API_KEY` | Ethereum mainnet RPC (Infura)。`ETHEREUM_RPC_URL` で上書き可 |
| `UNISWAP_API_KEY` | Uniswap Trading API proxy |
| `ETH_EXECUTION_TARGET` | `fork` (既定) / `mainnet` (送信拒否、plan のみ) |
| `ETH_FORK_RPC_URL` | Anvil fork (既定 `http://127.0.0.1:8545`) |
| `ANTHROPIC_API_KEY` | 任意。無ければ提案は rule-based |

Web 側 (`artifacts/seasonals-web`) は `BFF_URL` (Vite dev proxy 先、node 側のみ) 以外の env を持たない。`VITE_` prefix の env は使わない。

## 進捗ログ

各 push 後に commit hash と「実装済み / 未実装 / 実際に検証したこと」を追記する。

### A1 — `c5f3c65` web scaffold
- 実装済み: `artifacts/seasonals-web` (Vite 7 / React 19.2.3 / react-router 7 / vitest 3.2)、`/api` → BFF proxy、secret / typecheck script、ts-guard 追加
- 未実装: 画面すべて
- 検証: web typecheck / test / build green。`pnpm -r test` (lib 150, bff 394, mcp 11, mobile 475) green、全 workspace 新規 TS エラー 0。root の react 19.2.3 は不変 (web は react-dom 19.2.3 を nested install)。check-no-secrets が planted key を検出することを確認

### A2 — lib: web 派生 token / chains / TimelineEvent / timeline derive
- 実装済み: `FONT_WEB` / `SURFACE_WEB` / `SHADOW_WEB` / `mixHex` (docs/design-system.md に表を追加)、`lib/config/chains.ts` (`SUPPORTED_CHAINS`)、`lib/types/timeline.ts` (3 event class を型で区別)、`lib/derive/timeline.ts` (status 導出 / 表示 status / 安定 sort / window / 日付 group / 42 日 grid / block→時刻 / Solana 射影 / merge)
- 検証: lib 173 tests green (新規 23)、`pnpm -r test` / 全 workspace 新規 TS エラー 0

### A2 — `a59c3b9` (push 済み)

### A3 — WebGL water background
- 実装済み: `water.frag.glsl` (sha256 `23df542f…` を test で固定)、`WaterBackground` (WebGL1 / 全画面三角形 / DPR cap / hidden・paused で draw skip / reduced motion は uTime=12 の静止画で loop 停止、変化時のみ 1 frame 再描画 / context lost・restored / 失敗時 fallback)、`useQuietZones` (RO + MO + passive scroll/resize + rAF throttle、group union、最大 4 rect、変化時のみ uniform upload)、`waterDefaults` + `waterCalm`、DS token → CSS 変数注入、hex 直書き禁止 test
- 修正: StrictMode の二重 mount で loseContext 済み context を再利用し compile 失敗 → mount ごとに canvas を新規作成
- 検証 (system Chrome headless): 1440×900 で `data-water-state=animating`、reduced motion で `still`、`--disable-webgl` で `fallback` (背景色表示)。screenshot 目視で caustic セル・mint・泡を確認
