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
| `ETHERSCAN_API_KEY` | Dashboard の Ethereum 評価額履歴 (Etherscan API V2 の tx 差分)。無ければ `/eth/portfolio/*` は 503 `etherscan_not_configured` |
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

### B7–B8 — `8218b4e` (push 済み)

### B10 — Anvil fork 実行 (Foundry install、impersonation、executed event)
- Foundry 1.8.3 を公式 installer (foundry.paradigm.xyz、attestation 検証あり) で `~/.foundry` に install (ユーザー承認済み)
- `scripts/eth-fork.sh`: anvil は fork URL を argv でしか受けないため、key 入り URL は env 経由で `scripts/rpc-proxy.mjs` (127.0.0.1:8546 専用) にだけ渡し、anvil には proxy URL を渡す。出力は env 由来の perl で redact して `.data/anvil.log` (gitignore)。起動時の Infura 429 を避けるため `--compute-units-per-second 60 --retries 10`
  - 途中経過: 初版は redact 用 `sed` の argv に key が載り `ps` に出ていた → env 参照の perl に置換。最終確認で anvil log / `ps auxww` とも key 0 件
- BFF `POST /eth/execute`: `ETH_EXECUTION_TARGET=fork` かつ送信先が Anvil (web3_clientVersion) + chainId 1 の時だけ。`approvedBy: "user"` 必須 (MCP には実行 tool を出さない)。fork の状態で plan を再検証 + eth_call → `anvil_impersonateAccount` で owner として送信 → receipt から executed class の event を `.data/eth-executed-events.json` に記録 → timeline に合流。`POST /eth/fork/advance` (fork 専用の時間送り)
- viem の HTTP JSON-RPC batch を無効化 (Infura 429 時に batch 応答の result が欠けて `Cannot convert undefined to a BigInt` になったため)
- Web: 詳細カードの preview に「Approve and execute on local fork」(fork 稼働時のみ、impersonate であること・mainnet に触れないことを明記)、実行後は tx hash / status / block を表示し timeline を再取得、nav に FORK badge
- 検証 (実 mainnet の request / cooldown を fork 上で実行):
  - Lido `claimWithdrawal(#136731)` owner `0x0cA8…c2b5`: receipt success、fork 上で `isClaimed=true`、WithdrawalClaimed event (cast で確認)
  - Ethena `unstake` owner `0xA7a7…0ef8`: fork 時間を +1h 進めて cooldown 終了後に実行、187,456.58 USDe、`cooldowns()` が 0 に
  - ブラウザで Lido #136732 (`0xc601…4AC7`) を preview → 承認 → fork 実行 → Timeline に `Executed` (completed) の行が mainnet の claimable と別 class で並ぶことを screenshot で確認
  - BFF 411 tests (実行の承認必須 403 / mainnet target 拒否 409 / 非 Anvil 拒否 502)、e2e 43/43、web build
- 未実装: Pendle redeem / enter の fork 実行 (満期済み PT の実保有者を未特定)、browser wallet での署名 (mainnet 送信は意図的に無し)

### B10 — `729122f` (push 済み)

### B6 — Uniswap CCA indexer / auction event / bid の exit・claim
- 公式確認: 4 factory の mainnet deploy block を getCode の二分探索で実測 (v1.0.0 23,780,787 / v1.1.0 24,321,671 / v2.0.0 25,331,230 / v2.1.0 25,503,447)。**Infura の eth_getLogs は 1 回 10,000 block まで** (実測 `range … exceeds limit of 10000`)
- 実装済み:
  - `src/ethereum/cca.ts`: AuctionCreated を 10k block 分割で index。最新側を先に scan し、続けて過去へ遡る。範囲超過は分割幅を半分に、失敗は指数 backoff で再試行、chunk ごとに `.data/cca-index.json` へ進捗保存 (BFF 再起動で続きから再開することを確認)。`GET /eth/cca/status` で進捗
  - `AuctionParameters` を decode、token / currency の symbol・decimals と `isGraduated()` を multicall (失敗時は未設定のまま残して再取得)
  - 公開 feed: 開催中 / 予定 / 終了後 2 日以内、~2h 未満の極短 auction は除外、終了が近い順に 12 件。時刻は 12 秒/block の推定で「≈」表示。token symbol は作成者が自由に付けるため contract と注意書きを併記
  - address 別: 全 relevant auction をまとめた raw `eth_getLogs` (topic0 = BidSubmitted / BidExited / TokensClaimed、topic2 = owner) を 10k 分割で → bid ごとに exit / claim / refund event と `cca_exit_bid` / `cca_claim` の plan
  - Infura 429 対策: client 全体の `throttledFetch` (同時 4 本、eth_getLogs 同士は 700ms 以上空け、軽い read は待機中の getLogs を追い越す)、viem retry 4 回、部分失敗の結果は 10 秒だけ cache、エラーに HTTP status を付加 (秘密は含めない)
- 検証 (mainnet 実データ):
  - index 完了: 2,275,781 block、330 auction
  - 公開 feed に実 auction (BGD / SCRT / SIKKA …) が並ぶことを screenshot で確認
  - bidder `0x840b0Dea…51b5` (BFX bid #196/#200/#218) と `0x26ad2CEb…450F` (FLUX) で exit / claim event
  - bidder `0x3c3F2f22…BE26` の UNO (非 graduate) bid #0: refund の `exitBid` plan が **mainnet eth_call 成功** → **fork で実行 (receipt success)**。BVM の bid は on-chain で exit 済みとして settled 表示
  - BFF 416 tests (CCA decode / 公開 event / bid lifecycle / throttle)
- 未実装: `exitPartiallyFilledBid` (checkpoint hint が必要。説明文で manual と明記)、fork 上で数万 block 進める lifecycle 再生 (anvil_mine が block ごとに beacon roots storage を上流から取るため Infura 429 で失敗。代わりに mainnet で既に終了した実 auction で exit を実証)
- 事故記録: debug 中に viem のエラー object をそのまま print し、RPC URL (key 入り) が **この作業の端末出力** に出た。ファイル / repo / commit には出ていない。以後の debug script は redact 関数経由のみ

### B6 — `d5b2999` (push 済み)

### B9 — Uniswap Trading API proxy (quote のみ) + Explore の Ethereum 商品 + FEEDBACK.md
- 公式確認: Trading API OpenAPI (`https://trade-api.gateway.uniswap.org/v1/api.json`)。`/check_approval` required = walletAddress, token, amount, chainId、`/quote` required = type, amount, tokenInChainId, tokenOutChainId, tokenIn, tokenOut, swapper。routing で /swap か /order に分岐
- 実装済み:
  - BFF `POST /eth/uniswap/quote`: server 側で `x-api-key` (UNISWAP_API_KEY) を付けて `/check_approval` → `/quote`。amount は smallest unit の整数 string のみ受ける。**swap / order の実行経路は作っていない** (価格依存の実行は fail-closed の価格ガードが前提、WORKLOG #11)
  - BFF `GET /eth/menu`: Lido 7 日 SMA APR、Ethena 30 日平均、Pendle 流動性上位 8 market の implied APY / 満期 / 流動性 (取れない利率は null)
  - `lib/types/menu-product.ts` (`MenuProduct`: 利率は必ず label + source)
  - Web Explore: chain 切替 (All / Ethereum / Solana)、Ethereum 商品カード (label 付き利率、出所、満期、公式 app への link)、Ethena カードに「Route from USDC」(Uniswap quote preview、実行不可と明記)
  - `FEEDBACK.md` (repo root): CCA と Trading API について、実装で実際に当たった点のみ
- 検証:
  - 実 Trading API: 1,000 USDC → 約 999.94〜1,000.01 USDe (CLASSIC、approval + Permit2 署名が必要と返る) を curl とブラウザで確認
  - Explore の Ethereum / Solana 混在表示と chain 切替を screenshot で確認
  - BFF 420 tests (quote 要約 / UniswapX・CHAINED は実行不可 / 小数 amount を 400 / key 無しは外部を呼ばず 502)、`pnpm -r test` green、新規 TS エラー 0、e2e 43/43 (公開 CCA event で calendar に "+3 more" が出たため e2e の More selector を exact に修正)
- 未実装: Uniswap `/swap`・`/order` の実行、Chainlink 価格ガード、Aqua、Aave

### B9 — `2931077` (push 済み)

### 追加検証 — Pendle redeem の実経路 + README
- `find` の getLogs 範囲を Infura 上限 (10k) に合わせて再探索し、満期済み PT を持つ実 EOA `0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11` を特定。13 本の満期済み未 redeem PT が **overdue** として並ぶ
- `pendle_redeem` (PT-wstETH, 2026-08-27 満期): Pendle Hosted SDK Convert が `redeem-py` route + approve 2 件を返し、step 1 の eth_call が mainnet で成功 → **fork で approve ×2 + redeem 実行、receipt 3 件とも success**。fork 上の PT 残高 0、mainnet は 0.0134 PT のまま (cast で確認)
- これで Pendle / Ethena / Lido / Uniswap CCA の 4 経路すべてで「実 mainnet 状態 → unsigned plan → fork 実行」を確認
- `README.md` (repo root): 概要、ETHGlobal の申告 (既存コード再利用、Classic 適格性は主張しない)、起動方法、env、実 address の例、protocol 呼び出し箇所、未実装、AI 利用表記。MultiBaas は不使用と明記、Team 欄は提出者が記入

### sweep 修正 — `2d4c01b` (push 済み)

### Chainlink 価格 + fail-closed peg guard + Uniswap swap (fork 実行)
- 公式確認: Chainlink Feed Registry `0x47Fb2585…eeeDf` の `getFeed(base, USD)` が USDC / USDe / stETH / ETH の feed を返し、`description()` が "USDC / USD" / "USDe / USD" / "ETH / USD" であることを on-chain で確認。feed address は adapter に直書きせず、registry の `latestRoundData(base, USD)` を読む
- 実装済み:
  - `pricing.ts`: answer + decimals のまま保持し bigint で比較、feed ごとの heartbeat で stale 判定。`evaluatePeg` は欠損・stale・非正・乖離超過で必ず refuse (CLAUDE.md §4 の fail-closed を Ethereum 側に適用)。`GET /eth/prices`、`GET /eth/peg`
  - Uniswap `buildUniswapSwapPlan`: **USDC ⇄ USDe のみ** (peg guard があるペア)。peg guard ±50 bps → `/check_approval` → `/quote` (`generatePermitAsTransaction: true` で Permit2 も通常 tx に) → `/swap`。CLASSIC 系以外と off-chain permit 署名が必要な quote は拒否
  - `POST /eth/uniswap/execute`: fork 専用、`approvedBy: "user"` 必須。fork 実行は汎用化した `sendStepsOnFork` / `recordExecuted` を使い、receipt から executed event を記録
  - Web: Ethena カードの route preview に「Approve and swap on local fork」(peg guard の結果と tx ごとの status を表示)
- 検証:
  - peg guard (実 Chainlink): USDe 0.99981676 / USDC 0.99987434 → 1 bps で pass
  - fork で USDC 保有の実 EOA `0x283Ac701…383b` として 100 USDC → **99.9986 USDe**、approve / Permit2 / swap の receipt 3 件 success (cast で USDe 残高を確認)。ブラウザからも 50 USDC で同じ流れを確認
  - 途中経過: fork の時計を Ethena の検証で +1h 進めていたため swap が `TransactionDeadlinePassed()` で revert (cast run で特定)。`/swap` に fork 時刻基準の `deadline` を渡しても変わらず → fork を作り直すと成功。README に「時間送り後は fork を再起動」と明記
  - BFF 426 tests (peg の境界・stale・欠損・decimals 差、swap は非対応ペアと guard 失敗で Trading API を呼ばずに拒否)

### Chainlink / Uniswap swap — `558e1c4` (push 済み)

### 1inch Aqua + SwapVM (LP sleeve、fork)
- 公式確認: `@1inch/aqua-sdk` 0.3.4 / `@1inch/swap-vm-sdk` 0.4.4 (npm)。Aqua `0x1111113c…6a90a` と AquaSwapVMRouter `0x11111133…ac0de` の mainnet bytecode を確認 (SDK の定数と一致)。SDK README の通り、現在の router は `aquaInstructions` の subset のみ実行可能
- SDK の ESM build は内部 import (`@1inch/byte-utils/dist/constants`) が解決できず失敗 → CJS (`require`) で読む
- 実装済み (`aqua.ts`):
  - template は **PEGGED_STABLE のみ** (`AquaPeggedAmmStrategy` + `withFeeTokenIn` + `withSalt`)。任意の SwapVM program は作らない。parameter はアプリが検証 (帯域 10–200 bps、fee 1–30 bps、金額 > 0 と maker 残高以内、review 日は 180 日以内の未来)
  - ship の前に Chainlink USDe/USDC peg guard (±50 bps、fail-closed)
  - `POST /eth/aqua/ship-plan` (unsigned、MCP の `ship_lp_strategy` もこれ)、`/eth/aqua/ship` と `/eth/aqua/fill` (fork 専用、approvedBy=user)
  - ship 成功で「strategy review」(user_plan class) を review 日に作り、`aqua_dock` action を持たせる。dock は既存の `/eth/execute` 経路 (fork) で実行し settled に
  - Web: Agent 画面に「LP sleeve (1inch Aqua)」(mainnet 状態の plan、fork で ship、taker address を入れて 1 回 fill)
- 検証 (fork、実 mainnet 状態から):
  - spike → 製品コードで ship → fill (Binance の公開 EOA `0x28C6…1d60` を taker として impersonate、10 USDC → 9.9886 USDe、5 bps fee 込み) → Timeline に review (Your plan / Planned) → dock → Completed
  - 途中で見つけて直した不具合:
    - `linearWidth` を helper から取れず仮値で動いていた (10 USDC → 9.23 USDe) → `instructions.peggedSwap.linearWidthFromSymmetricRangePercent(0.5)` に修正
    - 同じ parameter の戦略は hash が同じで、dock 後の再 ship が revert → ship ごとに salt を付与
    - **UI が revert した ship を「Shipped」と表示していた** → ship / fill / 汎用 fork 実行 (`ActionPreview`) すべてで tx の status を見て、失敗は失敗として表示
  - mainnet 状態の plan は、maker が mainnet で USDe を持たないため正しく refuse されることも確認
  - BFF 429 tests (template / 金額 / 帯域 / fee / review 日の検証、review event の class と dock action)、MCP 15 tests (tool 一覧に ship_lp_strategy)、`pnpm -r test` green、新規 TS エラー 0、e2e 43/43
- 未実装: Aqua の mainnet 実行 (taker が KYB 済み resolver 限定)、Aqua REST の analytics、Aave

### Aqua — `d7ef3cd` (push 済み)

### Aave V4 (context のみ)
- 公式確認: `@aave/client` 6.6.0 (AaveKit、`api.aave.com/graphql`、key 不要) が V4 の `hubs` / `spokes` / `userPositions` を持ち、Spoke の id・名前を返すことを確認 (v3 の open item「AaveKit が V4 Hub/Spoke を扱えるか」は解消)。mainnet の spoke 例: Bluechip / Ethena Correlated / Ethena Ecosystem / Etherfi / Forex
- 実装済み: `aave.ts` (`userPositions` → spoke ごとの supplied / debt / net の USD、health factor、net APY)。AaveKit は decimal を BigDecimal object で返し `Number()` が throw するため `toString()` で文字列化し、8 桁 USD string に正規化 (float 計算なし)。`GET /eth/aave?address=`。Dashboard に「Aave V4 (context)」表。v3 の通り calendar event は作らない
- 検証: `reserveHolders` で見つけた実 V4 利用者 `0x59cCC403…F2A7` → Bluechip spoke、supplied $5,112,220.98 / debt $1,371,270.60 / HF 3.15 / net APY -1.53% を Dashboard で確認
- 途中経過: `tsx watch` が CCA indexer の background loop を抱えたまま再起動せず、新しい route が 404 になっていた → BFF を手動で再起動 (README の起動手順は変わらない)
- 未実装: Aave への supply / borrow action、hidden concentration warning

### Aave — `84e6b74` (push 済み)

### Dashboard Portfolio — 資産推移グラフ + category 別 Allocation
- 実装済み: `lib/derive/portfolio.ts` (mobile から chain 非依存 helper を移設 + 複数 address 合算)、BFF の履歴 engine を chain 非依存化 (`portfolio/engine.ts`)、`/portfolio/holdings`、Ethereum source (`/eth/portfolio/history` / `holdings`、Etherscan V2 + RPC + Chainlink + DeFiLlama)、web Dashboard の Portfolio (推移 / donut / 保有一覧 / address chip / Total・Deposited)
- 判断: indexer は Etherscan (gas・internal tx まで厳密)。stETH は approximated、Aave V4 は履歴から除外して現在値のみ。取れなかった address は合算から外し理由を表示 (0 / $0.00 と見せない)。設計と新チェーン手順は `docs/portfolio-history-design.md`
- 検証: `pnpm -r test` (lib 196 / mobile 475 / BFF 460 / web 41 / mcp 15) と `pnpm -r typecheck` green、e2e 失敗 0。fixture で 1440 / 1280 を screenshot 目視、実 BFF で key 未設定時の表示を確認
- 未検証: `ETHERSCAN_API_KEY` を入れた実 address での Ethereum 履歴 (key 未設定のため)
- 既知: category 色 (Seeker と共有) は dataviz の CVD / contrast 検査を満たさない組み合わせがあるため、凡例に名前・割合・金額を併記し、保有表を table view にしている

### Agent rebalance proposals (MCP → BFF → web / chat approval → fork)
- 実装済み: `lib/types/eth-agent-proposal.ts` (step は symbol + decimal、proposal / preview / execution の wire 型)、`lib/types/eth-plan.ts` (`ActionPlan` / `ForkExecution` を web のローカル定義から lib へ)、BFF `ethereum/agent-proposals.ts` (submit で全 step を既存 builder で組み guard を fail-closed で通す、後続 step の `insufficient_balance` だけ「fork 実行時に検証」として保留、`bundleHash = sha256({id, owner, steps})`、24h 期限、fork 実行は既存 executor を順に呼び最初の失敗で停止、`.data/eth-agent-proposals.json` に永続化、pending は `user_plan` / `agent_proposal` event としてカレンダーに出す)、routes `/eth/agent-proposals` (submit / preview / list / get / execute / reject)、MCP 6 tools (`list_yield_menu` / `get_holdings` / `preview_rebalance_step` / `propose_rebalance` / `wait_for_rebalance_decision` / `execute_rebalance`)、web `/agent` の ProposalInbox (ワンタップ承認 = fork 実行、reject、step 毎の tx 結果、pending がある間 5 秒 poll)
- 判断: 承認は approval token ではなく `bundleHash` + status + 期限 + per-id lock (web と chat の両経路が同じ execute に収束、表示したものと違う内容は 409)。LLM は MCP client 側 (BFF は決定的のまま)。Lido queue / Ethena cooldown は流動化しないので proposal は「withdraw 要求」で終え、claim は既存のカレンダーイベント → `get_proposal` / `build_action` に任せる。`amount:"max"` は未対応 (swap preview の `amountOut` から Agent が決める)
- §32.2 enum 変更: `USER_EVENT_KINDS` に `agent_proposal` 追加 (web `labels.ts` の KIND_LABEL / shapeForKind も更新)
- 検証: unit (BFF `agent-proposals.test.ts` 10 件、route 4xx、MCP 19 件、web ProposalInbox 3 件)。**実 fork で e2e (シナリオ A、2026-09-26)**: stdio の MCP から `get_holdings` → `list_yield_menu` → `preview_rebalance_step` (amountOut 100.03 USDe) → `propose_rebalance` (100 USDC → USDe swap、99 USDe → sUSDe) → web `/agent` のカードで承認 → fork で 5 tx すべて success (approve Permit2 / permit / swap / approve sUSDe / stake 99 USDe ≈ 79.2 sUSDe) → `wait_for_rebalance_decision` が `executed` を返し、カレンダーに Executed イベント 2 件。owner は Binance 14 (`0x28C6…1d60`) を impersonate
- e2e で直したもの: `wait_for_rebalance_decision` が `executing` で即返っていた (終端状態まで待つように)。web の proposal 一覧は pending / executing が無くても 15 秒ごとに再取得 (Agent の新しい提出が触らずに出るように)
- 既知: 起動直後の fork では最初の実行が upstream の state 取得待ちで viem の 10 秒 timeout に当たり `failed` になることがある (2 回目以降は state がキャッシュされ数十秒で完走)。認証なし (既存 `/eth/execute` と同水準)。holdings / events は mainnet を読むので fork 実行後も保有表示は変わらない (tx 結果と executed event で見せる)
- **シナリオ B (chat 承認、2026-09-26)**: owner `0x1121…0a11` で `propose_rebalance` (0.1 PT-apyUSD を売る、TWAP 0.03% 乖離で通過) → Agent が id / steps / bundleHash を人に提示して yes をもらう → `execute_rebalance(user_confirmed: true)` → fork で 2 tx success (router approve / sell 0.1 PT → 0.0688 apyUSD)、`execution.via: "chat"`。同時に oracle 未準備の PT-USDx を売る提案は提出時点で `oracle_unavailable` として拒否 (fail-closed は提案段階で効く)。実行済み proposal の再実行 / 誤 bundleHash / approvedBy 無しは live BFF でも 409 / 409 / 403
- Pendle の「PT 売り → 別 PT 買い」は market ごとに underlying が違う (apyUSD / USDx / reUSD …) ため、同じ underlying の後続 market が無いと組めない。デモでは単発の売りにした

### Strategy Brief (Agent の戦略を英語で提示する枠組み)
- 実装済み: `lib/types/eth-agent-proposal.ts` に `EthStrategyBrief` (before / after の `EthPortfolioSnapshot`、USD 加重 `blendedApy`、`aqua` sleeve、`horizon`、`unpriced` / `warnings`、英語 `markdown`)、step kind `aqua_ship`、`title` → `name` (絵文字 + 短い英語名 ≤ 40 code point、文字必須) + `tagline`。`lib/types/eth-plan.ts` に `EthPlanEffects` (`ActionPlan.effects?`)。BFF `ethereum/prices.ts` (現在単価: Chainlink → on-chain 換算 wstETH / sUSDe → DefiLlama、history.ts と共有)、`menu-actions.ts` の全 plan に `effects` (Lido 1:1 / previewDeposit / convertToAssets / Pendle Convert の outAmount、pending は queue / cooldown)、`ethereum/strategy-brief.ts` (`composeStrategyBrief` は純関数、`buildStrategyBrief` が I/O。Pendle 単価は dashboard 評価額 → step の反対側からの暗黙単価 (approx) → unpriced)、`agent-proposals.ts` に `aqua_ship` (preview = `buildAquaShipPlan`、実行 = `shipAquaOnFork`)、`prepareProposal` / `previewProposal` (dry run) と `POST /eth/agent-proposals/brief`、holdings の `spendable` に USDC。MCP `propose_rebalance` に `name` / `tagline` / `dryRun` / `aqua_ship`、prompt `design_rebalance`。web `/agent` の `StrategyBrief` 表 (before / after / APY、Blended APY の delta を melon / cherry 色、Aqua sleeve、horizon、unpriced)
- 判断: 数字は BFF が決定的に計算し LLM は名前と説明だけ (数字を創作できない)。加重 APY は 2 つ: `moved` (この提案が動かす資金、減る側 → 増える側、見出し) と `deployed` (DeFi で運用中の資金だけ)。**wallet の idle 資産はどちらの分母にも入れない** — 初版は全 line を分母にしていて、$295M の idle ETH / USDe を持つ whale では $180 の効果が 0.00% → 0.00% に埋もれた (レビュー指摘で修正)。表は量の変わる line だけ出し、変わらない line は "Unchanged: … (N positions, $X)" にまとめる。APY 不明は 0 扱いで `excluded` に列挙 (未知の利回りで数字を膨らませない)。brief は proposal を止めない (取得失敗は warnings)。`bundleHash` は `{id, owner, steps}` のまま。aqua.ts の残高不足は `insufficient_balance` に変更 (後続 step で保留できるように)。brief 無しの旧 proposal は load 時に捨てる
- 検証: unit (BFF `strategy-brief.test.ts` 11 件 / `prices.test.ts` 5 件 / agent-proposals 追加 4 件、MCP 20 件、web ProposalInbox 4 件)。**fork e2e (2026-09-26、🍋 Lemon Ladder、owner `0x28C6…1d60`)**: `POST /eth/agent-proposals` で 3 step (100 USDC → USDe swap / 99 USDe → sUSDe / Aqua PEGGED_STABLE 40 + 40 ship) を提出 → brief は "This rebalance moves $178.94: 0.00% → 2.67% (+2.67% pts)" / "Deployed capital (DeFi only): $924.80 → $1,103.77 · 2.25% → 2.32%"、表は 4 行 + Unchanged 2 件 → web `/agent` のカードで承認 → 36 秒で `executed` (`via: "web"`)、**8 tx すべて success** (Permit2 approve / permit / swap、sUSDe approve / deposit → 79.2001 sUSDe、Aqua USDC approve / USDe approve / ship)。カレンダーに Executed 3 件 + `strategy_review` (2026-10-10) が出て、brief の horizon で予告した予定がそのまま乗った
- 既知: Pendle の暗黙単価は 8 桁に丸めるため 1e-6 USD 程度ずれる (approx 表示)。YT は Llama に無いことが多く dashboard 評価額が無ければ unpriced

## 最終状態 (2026-09-26 05:30 JST 時点)

| 領域 | 状態 | 実際に確認したこと |
|---|---|---|
| desktop Web (Home lobby / 共通 nav / Explore / Calendar・Timeline workspace / Agent / Dashboard / Settings) | 実装済み | e2e 43/43 (1440×900・1280×800)。screenshot 54 枚 (`artifacts/seasonals-web/.screenshots/`、gitignore) |
| WebGL water 背景 (quiet zone / calm preset / reduced motion / fallback) | 実装済み | `animating` / `still` / `fallback` を e2e で確認。backdrop-filter 0 |
| Pendle / Ethena / Lido の実イベント | 実装済み | 実 mainnet address で表示。overdue (満期済み PT 13 本) も表示 |
| 提案 | rule-based で実装済み | 実データ (Lido SMA APR / Ethena 30 日平均 / Pendle implied APY)。LLM は key 無しのため未使用 |
| 署名前 preview | 実装済み | mainnet eth_call: Lido claim / Pendle Convert redeem (step 1) / CCA exitBid が成功 |
| MCP | 実装済み | stdio で list_events → get_proposal → build_action → iCal resource を実 BFF に対して実行。ship_lp_strategy 追加。rebalance proposal 6 tools + `design_rebalance` prompt + Strategy Brief (fork でシナリオ A / B を完走) |
| fork 実行 | 実装済み (fork のみ) | Lido claim / Ethena unstake / Pendle redeem / CCA refund exit / Uniswap USDC→USDe swap / Aqua ship・fill・dock の receipt success |
| Uniswap CCA | 実装済み | 330 auction を index、実 bidder の exit / claim / refund |
| Uniswap Trading API | quote・swap plan・fork 実行 | 実 API 応答、peg guard 付き |
| 1inch Aqua | fork のみ | ship → fill → review event → dock |
| Aave V4 | context のみ | 実 V4 利用者の health factor 等 |
| Chainlink peg guard | 実装済み | 実 feed で 1 bps、stale / 欠損 / 乖離は unit test で refuse |

未実装 / 未検証:
- mainnet への送信 (意図的に経路なし)、browser wallet 署名
- CCA `exitPartiallyFilledBid`
- Uniswap の UniswapX `/order`
- Aqua の mainnet 実行
- Aave action
- LLM 提案、hidden concentration warning
- mobile 幅 (<1100px は 2×2 まで)
- Menu (旧 Explore) の「Add to calendar」。自分の予定 (絵文字 + 内容) は日付から手入力できるが、このブラウザの localStorage のみ (BFF / MCP には未同期)
