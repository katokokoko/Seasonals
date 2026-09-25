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

### A3 — `cb8f27d` (push 済み)

### A4–A7 — AppShell / Home lobby / Calendar・Timeline workspace / Explore / Agent・Dashboard・Settings + e2e
- 実装済み:
  - `GlobalFloatingNav`: 5 link + More (1100–1439px で Agent / Dashboard を畳む) + `SUPPORTED_CHAINS` の chain icon (非操作、tooltip) + Settings gear (`aria-label`) + `WalletControl` (injected EIP-1193 接続 / watch address)
  - `HomeLobby`: portal card 4 枚 (カード全体が 1 Link、説明 1 行のみ、±2.5° / 1100–1439px で ±1° / <1100px で 2×2)、中央 `HomeCalendarCard` (Calendar ⇄ Timeline をその場で切替、header 高さ固定、expand のみ遷移、Timeline は月送り無し 30 日 window、未接続 note、empty state)
  - `EventDetailCard`: portal / `role=dialog` / focus trap / Esc・外側 click・Close / focus 復帰 / anchor 配置 / wallet gating / 日付クリックは day list、event はクリックで詳細
  - `/calendar`: tier-2 toolbar (前後 / Today / Month・Week・List / Filters / Calendar⇄Timeline は `?view=` を replace)、右パネルに選択日、`TimelineWorkspace` (range、Needs attention first、Today divider、network / type 列)
  - `/explore`: diner menu (実 BFF `/menu-listings`、APY は必ず label、availability は実データの deposit_open 等から、sponsored は出さない)
  - `/agent` `/dashboard` `/settings`: 未接続を明記した最小画面 (Dashboard は timeline 件数のみ、残高は出さない)
  - work screen は `.workspace` 全体を 1 quiet rect、`waterCalm` preset
- 未実装: Ethereum の実イベント (Stage B)、提案、tx preview、Ladder 表示 (既存実装が無いため入れない)、mobile 幅 (<1100 は 2×2 まで)
- 検証 (`node e2e/run.mjs`、system Chrome headless、1440×900 / 1280×800): 43/43 pass
  - nav 到達性 (1280 は More 内)、Settings href、chain icon 2 個、backdrop-filter 0 個
  - toggle 前後で中央カード box と header 高さが一致、Home に留まる、Timeline に月送り無し、expand の href
  - 日付 click で dialog (URL 不変、aria-labelledby)、Tab 6 回で dialog 内に留まる、Esc で閉じて日付 cell に focus 復帰、外側 click で閉じる
  - Agent portal card に focus → Enter で `/agent`、tier-2 switch で `?view=timeline`
  - reduced motion で `still`、既定で `animating`、`--disable-webgl` で `fallback`、page error 0
  - screenshot 14 枚 + 3 枚を `.screenshots/` に保存し目視 (中央カードの文字は quiet zone 上で可読、work screen 下部の caustic は calm)

### A4–A7 — `d6e8ffe` (push 済み)

### B1–B4 — BFF: Ethereum 読み取り client + Pendle / Ethena / Lido adapter + /eth/* route
- 公式資料で確認した仕様 (2026-09-26):
  - Pendle API (api-v2.pendle.finance/core/docs 埋め込み OpenAPI): `GET /v2/markets/all?chainId=1&isActive=`、`GET /v1/dashboard/positions/database/{user}` (PT 残高は wei string、valuation は USD number)、`POST /v3/sdk/{chainId}/convert`
  - Ethena sUSDe `cooldownDuration()` = 86400 秒 (実測、動的なので毎回読む)、`cooldowns(address)` = (cooldownEnd uint104, underlyingAmount uint152)
  - Lido WithdrawalQueueERC721 `0x889edC2e…F9B1` (docs.lido.fi/deployed-contracts)、`getWithdrawalRequests` / `getWithdrawalStatus`
  - Uniswap CCA (github.com/Uniswap/continuous-clearing-auction、tag v1.1.0〜v2.1.0): `AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)`、`BidSubmitted(uint256 indexed id, address indexed owner, uint256 priceQ96, uint128 amount)` — **v3 記載の `uint128 amount, bytes parameters` とは型が異なる** (公式を採用)。AuctionParameters は全 version 同一
- 実装済み: `src/ethereum/client.ts` (RPC URL は env からのみ、`sanitizeError` で key / URL を除去、undici fetch)、adapter 3 種 (pure derive + fetch)、`/eth/status` (boolean のみ)、`/eth/public-events` (Pendle 流動性上位 12 market の満期)、`/eth/events?address=` (adapter ごとに allSettled で隔離、id merge、cache)
- 検証 (mainnet 実データ、Infura):
  - `/eth/status` → chainId 1、latestBlock 取得、rpc / uniswap configured
  - `scripts/find-eth-demo-addresses.mjs` で getLogs から実在 address を抽出し、`/eth/events` で確認:
    - `0xA7a71E78128F6e3f6dB404ec47806E472F280ef8`: Ethena cooldown_end + Pendle PT maturity
    - `0x1B7a4C3797236A1C37f8741c0Be35c2c72736fFf`: Lido withdrawal_pending ×4
    - `0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5`: Lido withdrawal_claimable
  - BFF dev log に `infura` / key 文字列が 0 件
  - BFF 402 tests (新規 8: sanitize / env 優先順位 / 3 adapter の derive / 400 / status に URL を含まない)、`pnpm -r test` green、全 workspace 新規 TS エラー 0
- 未実装: CCA indexer (B6)、提案 (B7)、unsigned plan / MCP (B8)、Uniswap (B9)、fork 実行 (B10)、USD 価格 (Ethena / Lido は価格を出さない。Pendle のみ API の indicative valuation)

### B1–B4 — `8c4e8db` (push 済み)

### B5 — Web を Ethereum 実データに接続
- 実装済み: watchlist を複数 address 化 (最大 6、Solana / Ethereum 混在、接続 wallet を先頭に重複排除)、`useTimeline` が公開イベント + address ごとの `/eth/events` / `/time-events/wallet` を並列取得して id merge、source ごとの状態を card footer に表示、`useNow` (データ更新 + 30s で現在時刻を更新し status を再導出)、status 文言の具体化 (Claimable now / Pending / Overdue)、詳細カードは owner と一致する address を閲覧中の時だけ action を出す、nav に被らない配置
- 検証: 実 address 3 件を watch した状態で Home Timeline / 詳細カード (Lido claimable = Claim ETH が available、Ethena cooldown = Claim USDe は not_yet と理由表示) を screenshot で確認。e2e 43/43 pass

### B5 — `f6f1f24` (push 済み)

### B7–B8 — 提案 (rule-based) / unsigned transaction plan / MCP tools
- 実装済み:
  - BFF `POST /eth/build-action`: event を同じ source (`getUserEvents`) から id で引き直し、on-chain 状態を再検証してから calldata を組む (Lido `claimWithdrawal`、Ethena `unstake`、Pendle は Hosted SDK Convert + 必要な approve)。mainnet に eth_call して結果を返す。`broadcast: false` 固定、zod で plan を検証
  - BFF `GET /eth/proposal`: rule-based 提案 (facts / assumptions / options / risks / recommendation、zod 検証)。利回りは Lido eth-api SMA APR と Ethena 30 日平均 (いずれも trailing と明記)
  - `/eth/*` を独立 scope にし、想定外の例外も `sanitizeError` 経由でのみ log / response
  - Web: 詳細カードに Proposal panel と Transaction preview (FORK / MAINNET badge、step ごとの説明、eth_call の結果、「未署名・未送信」を明示)、Agent 画面に期日の近い event の提案
  - MCP Server: `list_events` (status を導出、範囲 / status で絞り込み)、`get_proposal`、`build_action` (unsigned のみ)、resource `seasonals://calendar/{address}` (iCal)
- 検証:
  - 実 address `0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5` の Lido request #136731 で build-action → `claimWithdrawal` calldata、**mainnet eth_call 成功** (送信なし)。提案も実データ (Lido SMA APR 2.25%)
  - MCP を stdio で起動し実 BFF に対して `list_events(status=due)` → `get_proposal` → `build_action` → calendar resource を実行 (same source で同じ event)
  - BFF 409 / MCP 15 / web 12 / lib 173 / mobile 475 tests green、新規 TS エラー 0、e2e 43/43、web build
- 未検証: Pendle redeem plan (満期済み PT を持つ実 address を Infura の rate limit (429) で探しきれず)、Ethena unstake plan (実 address の cooldown が未終了)。いずれも derive / 可否判定は unit test のみ
- 事故記録: `find-eth-demo-addresses.mjs` の深掘り中に Infura 429 の未捕捉例外が viem のエラー object (request URL = key を含む) を **repo 外の一時ファイル** (`/tmp`) に出力した。即削除し、script に redact 付きの global handler と throttle を追加、`/eth/*` にも sanitize 済みの error handler を追加。repo / commit / push には含まれていない (check-no-secrets で確認)
