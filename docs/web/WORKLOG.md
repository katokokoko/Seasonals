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

### Infura credit 削減 (2026-10-05)
- 背景: Infura free (3M credit/日) を 9 割近く消費。主因は CCA bid scan (address ごとに 24.33M → head を 10k block 分割 `eth_getLogs` ≈ 180 call ≈ 46k credit、cache 5 分・永続化なし)、それを初回必ず `ok:false` にして web が 15 秒 polling で回す連鎖、Anvil fork が毎回 latest を fork して `~/.foundry/cache/rpc` が効かないこと
- 実装:
  - bid scan は `ETHERSCAN_API_KEY` があれば Etherscan V2 `module=logs` (block 範囲制限なし、address 無し topic0 AND topic2=owner の検索が可能なことを実測) で event ごと 1 call。key 無しは従来の Infura 経路に fallback。`userCache` 10 分
  - `events.ts` は source 単位の cache。失敗した source だけ 10 秒で再試行し、成功 source (Ethena / Lido 等) の RPC read は通常 TTL まで再利用
  - web Timeline の部分失敗時 refetch は 15 → 30 → 60 … 秒、上限 5 分の backoff
  - CCA `head()` 12 秒 cache、`enrich` の個別 revert は 24h 再試行しない、`/eth/status` は block 12 秒 cache + chainId 保持
  - `GET /eth/rpc-usage`: BFF 起動後に Infura へ出た request の method 別件数と credit 目安。`rpc-proxy.mjs` も上流 request 数を 60 秒ごとに log
  - `eth-fork.sh`: `--fork-block-number` を `.data/fork-block` に固定 (`FORK_MAX_AGE_H` 既定 24h、`FORK_REFRESH=1` で更新)。上流は `FORK_UPSTREAM_RPC_URL` (例: Alchemy free) を優先できる
  - Settings に Etherscan API 規約の表記 ("Powered by Etherscan.io APIs")
- 実測: bid のある実 address で `/eth/events` が初回から全 source ok・1.4 秒・Infura 4 request (≈495 credit、うち getLogs は CCA factory index の差分 1 回)。2 回目は 0 request。`/eth/status` 4 回で blockNumber 1 + chainId 1
- 実測 (fork、2026-10-09): block 26148842 を固定して 2 回起動、上流 request は 1 回目 50 → 2 回目 6 (`~/.foundry/cache/rpc/mainnet/26148842/` を再利用、reachable まで 12 秒 → 3 秒)。同じ fork で Lemon Ladder 相当 (100 USDC → USDe swap → 99 USDe → sUSDe) を REST で提出 → 実行: 5 tx すべて success、31 秒、`FORK_REFRESH` 不要。e2e 中の上流 request は +99 (tx が触る storage slot 48 件など、以後は cache)、BFF 側の Infura は +9 request (≈720 credit)。execute は `approvedBy` / `bundleHash` に加えて `via: "web"` が必須。残る気づき: proxy 経由で `anvil_nodeInfo` と fork tx の `eth_getTransactionReceipt` (10 件) が上流に出ている (次の削減候補)
- 不採用: HyperSync (新依存 + token、free は fair-use のみ)、Alchemy free の getLogs (10 block 制限)、JSON-RPC batch (課金は減らず、429 時に結果欠落した過去あり)

### Home portal card を水の blob に (droplet glass、2026-10-05)
- 経緯: 水面に独立した blob を浮かべる案 (`web-liquid-blobs-attempt1`) は想定と違ったため取り消し、4 隅の portal card 自体を blob の質感にした
- `data-water-glass="droplet"` (`GLASS_VARIANTS.droplet`、lens 1.2 / frost 0) + `uGlassShape` (輪郭の揺らぎ 4 CSS px、seed)。shader は透明な「水への窓」(quiet × 0.6 で線の間を沈める、縁だけ薄い水色)、光の側の細い光の線、光に向いた角の 4 点星、水面 layer (`uGlassLens = 0`) にカードの外の集光。CSS は WebGL 中だけ tint / rim / 影を外し、文字の後ろに薄い vanilla の楕円と白い縁取り。WebGL 不可 / reduced transparency は従来の glass
- 計測: drawArrays + readPixels で水面 layer 7.60 → 7.97 ms、glass layer 4.58 → 4.29 ms (droplet は bevel の色分散を省く)。`e2e/run.mjs` 全 pass (droplet の 2 check 追加)

### droplet カードのきらめきの位置 (2026-10-05)
- きらめきは光の向きの符号で 4 隅のどれかに置いていたため、ポインターが画面の中心線をまたぐと隅から隅へ飛んでいた。中心から光の方向 (カードの縦横比で引き伸ばす) へ伸ばした線が角丸の輪郭と交わる点の少し内側に置き、`uLight` の追従に合わせて縁に沿ってなめらかに動くようにした。既定の左上の光では左上の隅の近くに止まる
- カードの下のキャラを glass layer で描く案 (texture) と top bar の droplet 版 (`?nav=droplet`) は試したが、どちらも不要と決めて外した

### 水面を浅い海の写真に寄せる (/goal、2026-10-05)
- 参照は浅い海を真上から撮った写真 (local-only、`docs/web/reference/water-ref.png`)。膨らみや blob ではなく、水面の shader (`renderB`) そのものを寄せた。手順・採点文面・記録は `docs/web/reference/water-{goal,judge,tuning-log}.md`、撮影と gate は `e2e/water-shots.mjs`
- 採用は iter 7 の形: 集光は「6 波の和の曲面が光を集める」(1 / |det(I − s∇²h)|) の折れ線、焦点外は少し深いアクア、水は赤から吸収するターコイズで浅い砂と深い斑、砂は粒 + 小石 + 砂紋、流れに沿う水面の筋と星、Home の静かな所はぼかした線を残す。描画コストは元の shader の 0.87 倍
- 採点 (fresh な Opus、全軸 4 以上 2 回連続が完了条件) は上限 10 回で未達。元の shader の 2/3/2/2/3 から 3/3/3/3/4 (iter 5 と 7) まで。iter 2 以降は全軸 3 前後で頭打ちで、網目の形 (Voronoi はタイル的、焦点の折れ線は稲妻的、重み付き Voronoi の iter 9 / 10 も多角形と言われた) と水面の筋の弱さが毎回残った。規則どおり最低軸が最も高い commit のうち後の iter 7 に戻した。iter 9 / 10 の丸い網目は `0ccdeec` / `a10006f` に残してある
- gate は全 iteration で通過: 文字のコントラスト (iter 0 の値以上)、作業画面の静かさ、reduced motion で静止、描画コストの比 ≤ 1.4。作業マシンは別セッションの test / build で負荷が高く、perf は iter 0 の shader と同じ page で交互に測る比にした。撮影中の vite reload は撮り直す
- 延長 (iter 11–15、ユーザーの指示): 浅い砂を app の vanilla cream (別の UI mock の上端の色) に変え、採点の depth 軸も合わせた。網目は乗法重み付き Voronoi (壁が円弧の小石状の網目) に替え、吸収を深さの 2 乗に (浅い所は vanilla、深い所はティール)。最良は iter 14 / 15 の 3/3/3/4/4 (depth が初めて 4) で、後の iter 15 を採用。完了条件 (全軸 4 × 2 回) は未達。e2e 110 件全 pass、描画コストは元の 0.95 倍
- 粒の修正と 2 回目の延長 (iter 16–20): 砂の粒を正方形の hash から滑らかな noise に (Retina で荒く見えない)、droplet card の縁で粒・砂紋・筋を薄める。線の太さを細線〜太い帯に、knot に hot spot と小さなきらめき、水面の筋を流れに沿う長い細線に。最良は iter 16 / 19 / 20 の 3/4/3/4/4 (caustics と depth が 4) で iter 20 を採用。完了条件は未達。採点には ±1 のぶれ (同じ線で Ca が 4 と 3)。e2e 110 件全 pass、描画コストは元の 1.05 倍
- Home の水色の膜: DOM の層ではなく、列ごとに束ねた quiet zone (0.85) だった。Home の `quiet` を下げ (0.4 を試してユーザー指定で 0.6)、上部バーの glass の下だけは 0.85 のまま (ロゴの文字のコントラストを保つ)

### 水面背景の発熱対策 (2026-10-06)

- 原因: MacBook Pro M4 Pro (ProMotion 120 Hz) で、水面と glass の 2 枚の canvas を毎フレーム全画面に描いていた。
  GPU がほぼ常に水を描いていて追いつかず、Home の rAF は 120 Hz から 70 Hz 前後に落ちていた。
- 対策 (`src/background/perfVariant.ts`、dev では `?water-perf=none|1,3|all|default` で 1 つずつ切り替えられる):
  1. 水の描画を 20 fps に間引く (`waterDefaults.maxFps`)。kick (quiet zone / glass の移動) は即描く。
     キャラクターの style 書き換えだけでは kick しない (`useQuietZones` の measure が floater だけの変化で false を返す)。
  2. 作業画面 (calm preset) は静止画 (`waterCalm.animate: false`、`data-water-state="still"`)。
  3. DPR 上限 1.0。見た目の判断待ちで既定には入れていない。
  4. glass layer を glass の外接矩形だけ描く (`glassScissor()`)。
  5. Home のキャラクターの動きを 30 fps に (水とは別)。
- 計測 (`e2e/water-power.mjs`、画面に Chrome を出して 120 Hz で、各版 10 秒 × 2 周):
  水を描いている GPU 時間の目安は、対策なしで Home 約 94 %、Calendar 約 98 %。
  既定 (1+2+4+5) で Home 約 37 %、Calendar 0 % (静止画)。3 も入れると Home 約 25 %。
  単独では 1 と 2 が効き、3 は単独だと fps が上がるだけで GPU の忙しさはほぼ変わらない。4 と 5 は単独では小さい。
- 最終版 (ユーザーが決定): 10 / 15 / 20 / 25 / 30 fps を `?water-fps=` で見比べ、水は 20 fps、作業画面は静止画、キャラは 30 fps。
  10 fps はコマ送りに見えた。DPR は 1.25 のまま。Home で水を描く GPU 時間の目安は約 94 % → 約 30 %、Calendar は 0 %。
- 確認: web typecheck / test 152、`water-shots.mjs` の gate 全 true、`e2e/run.mjs` 110/110。

### Solana を web で実行 (Seeker 版の移植、2026-10-05、未 commit)
- 範囲 (ユーザー決定): Solana browser wallet 接続 + Menu の deposit / withdraw + Calendar の claim / redeem + Dashboard の Your Positions からの withdraw。**mainnet に実送信** (Seeker と同じ経路)。Agent plan 承認 inbox / autonomous は対象外
- 実装済み:
  - wallet: `services/solanaWallet.ts` (Wallet Standard を手書き。`getWallets()` で検出、`standard:connect` / `standard:events` / `solana:signTransaction` の一括署名、拒否判定)。`@solana/web3.js` と wallet-adapter は入れず、tx は base64 ↔ Uint8Array のまま (`services/bytes.ts`)。依存は `@wallet-standard/{app,base,features}` と `@solana/wallet-standard-{features,chains}` (MWA 経由で lockfile に既にあった版)
  - session: `connectedEvm` → chain 別 `connected`。Solana wallet 名だけ保存し、reload 後に `connect({ silent: true })` で 1 回だけ戻す。Settings の Server integrations に Solana RPC (Helius) の設定有無
  - lib (same source of truth): Seeker の `oracle-gate` / `amount-utils` / `event-action` を `lib/derive/` へ移設 (mobile は import 先だけ変更、test も移動)。`lib/derive/solana-action.ts` (`resolveSolanaRoute` = Seeker ActionModal の dispatch cascade を順序込みで転写、`canWithdrawEarnPosition` = MenuDrawer から移設、`depositAction` / `withdrawActionFromPosition` / `withdrawActionFromParams`)。`lib/types/solana-tx.ts` (tx builder の応答型を mobile のローカル定義から lift)。`allEarnPositions`
  - Calendar: `fromUnifiedTimeEventDTO` が event.metadata の withdraw 用フィールドを action params に写し、BFF route に解決できる時だけ `available` (欠けたら unsupported、fail-closed)
  - BFF: `GET /tx/status?signature=` (getSignatureStatuses の要約、read-only) と `/health` の `solana.heliusConfigured` (boolean のみ)
  - web: `solana/useSignAndSubmit.ts` (build → 1 回の承認で全 tx 署名 → `/tx/submit` を順に、2 本目以降 skipPreflight → `/tx/status` で confirmed / failed)、`solana/OracleGate.tsx` (web 版 WarningArea: blocked は CTA を出さない、warning は 1 秒グレーアウト)、`solana/SolanaExecutePanel.tsx` (Menu / Calendar / Dashboard 共用)。Menu の Solana カードに Deposit / Withdraw (display_only / 満杯 / route 無しは理由付きで無効)、chain chip は `SUPPORTED_CHAINS` から。Dashboard に「Your positions (Solana)」
- 判断: 署名できるのは接続中の wallet の address だけ (watch は読み取りのみ)。`oracle_blocked` / `fair_value_blocked` は失敗ではなく declined (Seeker 8.74)。route の無い pool は Seeker と違い押す前に無効にする
- 検証:
  - `pnpm -r test` green (lib 264 / mobile 427 (移設した 48 件は lib 側) / BFF 524 / web 138 / MCP 20)、`pnpm -r typecheck` green
  - e2e 113/113 (`SOL_E2E=1`): 偽 Wallet Standard wallet の検出・接続・reload で silent 再接続、実 BFF で Menu の Jupiter USDC deposit panel が実 mainnet 残高 (38.486021 USDC) を読む、network を差し替えた block で署名 → `/tx/submit` (署名済 bytes の base64 一致) → confirmed → Solscan link
- **oracle 障害 → 解消済み** (下の「oracle 移行」): 実 BFF での build → wallet prompt は e2e で確認済み。**mainnet 実送信は未検証**のまま (実 wallet での署名が要る)。少額で Jupiter Lend USDC deposit → withdraw、Kamino、Save (複数 tx)、Orca / Meteora の部分署名済 tx を wallet ごと (Phantom / Solflare / Backpack) に確かめる
- 既知: Orca / Meteora の withdraw は Seeker と同じ入力単位 (metadata の share_decimals と asset) なので、position NFT 1 枚が「1 USDC」のように見える。mobile の `ActionModal` はまだ `resolveSolanaRoute` に乗せ替えていない (lib test が cascade 順序を固定。乗せ替えは実機確認が要るので別 phase)

### oracle 移行: Pyth push + RedStone push (2026-10-05、未 commit)
- 背景: Pyth Hermes REST が 2026-08-26 の Pyth Core upgrade で API key 必須 (key 無しは 401、key は 14 日 trial 後 $500/月)、Switchboard が 2026-09-25 にサポート終了 (crossbar は DNS 消滅)。BFF の oracle gate が全 Solana asset で `oracle_unavailable` になり、Seeker も web も Solana の tx を組めなかった
- 判断 (ユーザー決定): primary = Pyth の sponsored push feed、secondary = RedStone の push feed。どちらも Solana 上の account を Helius で読む (追加費用・key なし)。Hermes の key は買わない。RedStone の off-chain gateway (tier B) は後続。wire 形は `switchboard` → `secondary: { source }` + `tier` に改名。staleness は source ごとに heartbeat + 猶予 (Pyth 75 秒 / RedStone 90 秒) — 60 秒固定だと heartbeat の谷で RedStone が 15〜26%、Pyth が 2〜4% の時間 stale 判定になった (4 分 × 5 秒間隔の実測)
- 実装:
  - lib: `lib/config/oracle-feeds.ts` (asset ごとの tier A–D、feed id、program 定数、閾値。BFF の `ASSET_ORACLE_FEEDS` を移設)。`oracle-feeds.test.ts` が registry の全 underlying / deposit mint に tier があることを強制 (Menu に asset を足して tier を忘れると落ちる)。`lib/types/oracle.ts` を `secondary` / `tier` / `reason` / `OracleSourceId` に、warning kind `oracle_switchboard_stale` → `oracle_secondary_stale` (§32.2 enum 変更)。warning 文言を `lib/derive/oracle-gate.ts` に集約し Seeker WarningArea と web OracleGate で共有
  - BFF: `clients/oracle-onchain.ts` (PDA 導出 + PriceUpdateV2 / RedStone PriceData の手書き decode、価格は bigint で 8 桁 string)、`helius-rpc.ts` `getMultipleAccountsBase64` (1 asset = RPC 1 回)、`clients/oracle.ts` 書き直し (Hermes / Crossbar 削除、last-good は source の閾値以内だけ)。`scripts/verify-oracle-feeds.ts` + `verify:oracle` (全 feed の鮮度と乖離、stale は 15 秒おきに 2 回読み直してから判定)。実 account の bytes を `src/__fixtures__/oracle/` に固定
  - 評価額履歴: Pyth Benchmarks も 404 になっていた。feed のある asset は Benchmarks しか見ず、SOL / USDC が「現在価格の横一直線」に近似されていた → 空 series なら DefiLlama に落とす (`solanaPriceSeries`)
  - 表示: Seeker WarningArea / MCPApprovalPushCard、web OracleGate (tier C は「Single price source (Pyth)」を muted で 1 行、CTA は止めない)
- tier (2026-10-05): A = SOL / USDC / JupUSD、C = USDT (RedStone の account が 2025-07 から停止) / JLP / EURC、D = USDG (Pyth が 3 分 heartbeat) / USDS / USX (Pyth sponsor 停止) / Exponent の niche underlying 11 種 (feed 無し、従来どおり gate 対象外)
- Save (旧 Solend) への影響なし: Save の reserve が指す Pyth oracle は同じ sponsored push account で、Switchboard 側は 2025-01 から止まっていた (Save は以前から Pyth 単独)。solend-sdk が Hermes を呼ぶのは push account が 80 秒より古い時だけで、75 秒の gate が先に止める。BFF builder の USDC / SOL deposit は mainnet simulate 成功
- 検証:
  - lib 291 / mobile 427 / BFF 538 / MCP 20 tests green、`pnpm -r typecheck` green。web は 134/135 (失敗 1 件は並行作業中の水背景 shader の sha256 検査で、この変更とは無関係)
  - `verify:oracle`: tier A / C の 6 asset すべて fresh、tier A の乖離 0.003〜0.008%
  - 実 BFF `/oracle/status`: SOL = ok / tier A / secondary redstone、USDT = ok / tier C、USDS = not_configured / tier D + reason
  - `verify:tx`: 23 経路中 simulate 成功 13 / 想定内 9 / 要調査 1 (前回は 18 が `oracle_blocked`)。残る 1 件は Perena deposit で、Jupiter が USDC → USD* の route を返さない (`NO_ROUTES_FOUND`、oracle は通過済み、別件)
  - web e2e 113/113 (`SOL_E2E=1`): 前回は oracle blocked で skip した「実 BFF で Jupiter Lend USDC deposit を build → 偽 wallet が 1 回 prompt を受けて拒否 → /tx/submit 0 回」を実行して pass
- 未実装 / 未検証: RedStone gateway (tier B、USDT / JLP / USDG / JitoSOL の 2 本目)、Seeker 実機での WarningArea 文言確認 (JS reload)、mainnet 実送信、Pyth sponsorship 停止時の Save 側の挙動 (制御外)

### oracle tier B: RedStone gateway (2026-10-05、未 commit)
- 背景: 前段の移行後、USDT / JLP は Pyth 単独 (tier C) で乖離を照合できず、USDG は Pyth の sponsored feed が 3 分 heartbeat のため gate 対象外 (tier D) だった。RedStone の on-chain push feed にはこれらが無い (USDT は 2025-07 停止、JLP / USDG は account 無し)
- 判断 (ユーザー決定): USDT / JLP を C → B、USDG を D → B (USDG の Pyth は feed 別閾値 200 秒)。2 本目は RedStone の公開 gateway (key 不要) の署名付き data package
- 実装:
  - 署名検証は **viem で手書き** (新規依存なし)。公式 `@redstone-finance/protocol@1.0.0` の `DataPackage.toBytes` / `getSignableHash` を読み、byte 列 (feed id bytes32 ‖ value 32B ‖ timestamp 6B ‖ value size 4B ‖ 件数 3B) の keccak256 を prefix なしで recover。実 package 30 件すべて正規 signer に一致を確認
  - gateway の `signerAddress` / `isSignatureValid` は自己申告なので使わない。正規 signer は SDK `getSignersForDataServiceId` 既定と同じ internal 5 つを lib に固定 (`REDSTONE_PRIMARY_SIGNERS`、出所コメント付き)。2025 年以降の external signer は受け入れない
  - 判定: 異なる正規 signer 3 以上 (quorum)、中央値 (偶数件は低い方)、age は使った package の最も古い timestamp から、閾値 60 秒
  - gateway は feed で絞れず毎回全 996 feed (~2MB) を返すので、全 asset で 1 回の取得を共有し 10 秒 cache (同時呼び出しは 1 本に合流)。1 本目が落ちたら 2 本目 (`oracle-gateway-2.a`)
  - `lib/config/oracle-feeds.ts` に `redstoneGatewayFeedId` / `pythMaxAgeS`、BFF `clients/oracle-redstone-gateway.ts`、`oracle.ts` は Pyth / push の RPC と gateway を並列取得。`verify:oracle` に gateway 列 (有効 signer 数 / 中央値 / age)
- tier (変更後): A = SOL / USDC / JupUSD、**B = USDT / JLP / USDG**、C = EURC (gateway にも無い)、D = USDS / USX / Exponent niche 11 種
- 検証:
  - lib 291 / mobile 427 / BFF 561 / MCP 20 / web 135 tests green、`pnpm -r typecheck` green
  - gateway のテストは実 package の fixture で、改ざん (値 1 桁) / 署名破損 / signer 重複 / quorum 境界 / feed id・data service 不一致 / 中央値 / cache 共有 / 予備 gateway を確認
  - `verify:oracle`: 7 asset すべて OK。tier B は 3 asset とも 5/5 signer、gateway 11 秒、Pyth との乖離 0.005〜0.031%
  - 実 BFF `/oracle/status`: USDT / JLP / USDG = tier B、secondary `redstone_gateway`、乖離が数値
  - `verify:tx`: 前回と同じ 22/23 (Perena は既知の Jupiter route 問題)。1 回目は Kamino layout 確認が Helius の 429 に当たったが、再実行で通過
  - web e2e 113/113 (`SOL_E2E=1`)
- 既知のリスク: RedStone の公式 SDK 1.0.0 は「authenticated gateway」を既定にしている。公開 gateway が key 化されたら gateway source は unavailable になり、tier B は Pyth 単独で動く (Pyth も stale なら block、fail-closed)

### Perena USD* の mint 移行 (2026-10-05、未 commit)
- 症状: `verify:tx` で「swap-earn dep perena」だけが Jupiter `NO_ROUTES_FOUND` (oracle は通過済み)
- 原因 (調査): Perena が USD* を新しい mint と新 program に移していた。registry は旧 mint を指したまま
  - 旧 `BenJy1n3…Wo6`: Jupiter 上は "USD Star (Perena StableSwap LP)" (Numéraire の LP)、流動性 $44、USDC↔USD* とも金額によらず route 無し。on-chain は RemoveLiquidity と小口 swap だけ
  - 新 `star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM`: Jupiter で verified "USD Star"、時価総額 $11.6M、program は Perena Star V2 (`save8RQ…`)。Jupiter label "Perena Star V2" で双方向に route あり (1 USDC → 0.908353 USD*、価格影響 ≈ 0)
  - 一時障害ではなく恒久的な移行。Perena の APY API は生きている (7d 9.12%)
- 修正: `lib/config/swap-earn-markets.ts` の perena の share mint を新 mint に、`verify-tx-routes.mjs` も同じ値に。旧 mint は swap-earn registry に入れず (入れると withdraw route を解決して Jupiter で必ず失敗する)、`lib/__fixtures__/known-mints.ts` に "USD* (legacy)" として表示だけ残す (Perena への預入として数える)。旧 token の移行は Perena app で行う前提
- 検証: lib 293 / BFF 561 / mobile 427 / MCP 20 / web 135 tests green、`pnpm -r typecheck` green。**`verify:tx` が 23 経路中 成功 14 / 想定内 9 / 要調査 0 で exit 0** (この phase の連続作業で初めて)。実 BFF で新 mint 向け deposit tx が組める (0.1 USDC → 0.090835 USD*)。web e2e 113/113
- 範囲外: 旧 USD* → 新 USD* の移行を Seasonals 上で行うこと、Menu の Perena TVL (fixture 5,000,000 のまま)

### Perena: 旧 USD* の案内と TVL の live 化 (2026-10-06、未 commit)
- 調査:
  - 旧 USD* (`BenJy1…`) は Perena **Tri-Stable Pool** (`2w4A1eGy…`、`@perena/numeraire-sdk` の `PRODUCTION_POOLS.tripool`、USDC / USDT / PYUSD) の LP token。Menu に display_only で載っていた「Tri-Stable Pool」カードと同じもの
  - 市場では実質売れない (Jupiter Ultra → DFlow → Raydium CLMM: 1 → 0.917 USDC、100 → 16.3、1,000 → 19.2)。正規の引き出しは Numeraire の `remove_liquidity` (USDC 単独で受け取れる) だが、公式 SDK はグローバル状態に署名者 Keypair を持つ作りで、CJS から ESM 専用の `node-fetch` 3 を require するため BFF ではそのまま使えない
  - TVL の fixture はずれていた: USD* 5,000,000 → 実測 $11.58M、Tri-Stable 3,000,000 → 実測 $306.8K (約 10 倍)
- 判断 (ユーザー決定): 旧 USD* は **表示と Perena app への案内だけ** (Seasonals で移行も withdraw も作らない)。TVL は **2 カードとも live**
- 実装:
  - `lib/config/perena.ts` (app URL、旧 USD* mint / decimals、Tri-Stable pool と vault 3 つを固定 — pool PDA は spam token も持つので owner 一覧では数えない)。`ProtocolPool` に任意の `note` / `external_url`。Tri-Stable の fixture に旧 USD* の案内と link
  - BFF: `rates.ts` `fetchPerenaUsdStarPrice` (`api.perena.org/api/usdstar/price`、5 分 cache)、`clients/perena.ts` `fetchPerenaTriStableTvlUsd` (3 vault を 1 回の getMultipleAccounts で読み、mint / owner / program が違えば throw)。`/menu-listings` の overlay で USD* = 新 mint 供給 × 単価、Tri-Stable = vault 残高合計。取れなければ fixture (fixture も実測値に更新)
  - web: Menu カードの詳細に `note` と「Open Perena ↗」。閲覧専用 pool には「wallet で署名して送る」の定型文を出さず「Seasonals では扱えない」と書く。Dashboard の Your positions に、閲覧中 address が旧 USD* を持っていれば Perena app への案内 (`/positions` の `raw_state.mint` で判定、deposit 残高と同じ query を共有)
- 検証: lib 293 / BFF 569 / mobile 427 / MCP 20 / web 139 tests green、`pnpm -r typecheck` green。実 BFF `/menu-listings`: USD* $11,575,088 / Tri-Stable $306,770.57 + 案内。Menu を screenshot で確認 ($11.6M / $306.8K、詳細に案内と link)。`verify:tx` 23 経路中 成功 14 / 想定内 9 / 要調査 0 (Kamino layout 確認が 2 回 Helius の 429 に当たり、再実行で通過)。web e2e 113/113
- 範囲外: 旧 USD* の withdraw / 移行 (必要になったら IDL から remove_liquidity を自前で組む。SDK は入れない)、Seeker への案内表示 (`note` / `external_url` は任意 field で mobile は無視する)

### Menu fixture の総点検 + RPC 429 対策 (2026-10-06、未 commit、Opus 5.5 subagent 2 本で実装)
- 背景: Perena の TVL が fixture と約 10 倍ずれていたので、`/menu-listings` の live 応答と fixture を全 pool で突き合わせた。TVL が fixture のままだったのは 13 pool (LST 6 / kVault 2 / Save 2 / sHYUSD / 出典なし 2)。同日 `verify:tx` が Helius の 429 に 3 回当たった
- 実装 (A: Menu の live 化):
  - LST (INF / jitoSOL / bSOL / mSOL / hyloSOL): Sanctum `/v1/tvl/current` (lamports) × SOL oracle 価格。display_only の sanctum_jitosol / sanctum_bsol も対象
  - kVault (steakhouse / allez): Kamino metrics の `tokensInvestedUsd + tokensAvailableUsd` (以前は apy しか拾っていなかった)
  - Save (USDC / SOL): reserve account を `@solendprotocol/solend-sdk` の `parseReserve` で decode し `available + borrowedWads/1e18` × 単価 (program id は SDK 定数、両 reserve の owner と一致を確認)
  - sHYUSD: 供給 × Jupiter price v3 (`lite-api.jup.ag/price/v3`、key 不要)。APY は Exponent `/markets` に sHYUSD の underlying が無いため fixture のまま (fixture にその旨)
  - overlay の挙動: LST / solstice の TVL と Save の TVL は APY source が失敗しても適用される (以前は APY と同じ分岐の中だった)。SOL 価格が無ければ SOL 建ての pool は fixture
  - fixture は 2026-10-06 の実測値に更新 (live 失敗時の fallback)。savefi_turbo_sol / jito_restaking_vault は出典なしで fixture 維持 + コメント
- 実装 (B: 429 対策):
  - `helius-rpc.ts` に `rpcReadWithRetry` (429 / 5xx / network は 500ms → 1s の backoff で最大 3 回、`Retry-After` 優先・上限 10 秒、他の 4xx と JSON-RPC error は即 throw)。読み取り系 (`getMultipleAccountsBase64` / `getSignatureStatus` / `getTokenSupplyUi` / `getEpochInfo` / `fetchStakeAccounts` / `simulateUnsignedTx`) が使う。`sendTransactionViaHelius` は再試行しない
  - `verify-tx-routes.mjs`: 同じ backoff の `rpc()` helper (非 JSON 応答も再試行対象)、simulate 間 250ms、再試行しても駄目なら「RPC rate limit (429) — 時間を置いて再実行」と出す。`verify-oracle-feeds.ts` は helius-rpc 経由なので自動で効く
  - backoff の待ちは test が `_setSleepForTest` で差し替える (subagent は jest 判定を本体に入れていたが、test 側の注入に変更)
- before → after (2026-10-06、SOL ≈ $119):

| pool | fixture (before) | live (after) |
|---|---|---|
| sanctum_inf | 158M | $275.9M |
| sanctum_jitosol / jito_jitosol | 780M | $1,242.9M |
| sanctum_bsol | 69M | $124.1M |
| marinade_msol | 187M | $382.2M |
| hylo_hylosol | 20M | $24.3M |
| kamino_steakhouse_usdc | 19.8M | $19.1M |
| kamino_allez_sol_vault | 6.3M | $10.6M |
| savefi_usdc_main | 21.9M | $22.5M |
| savefi_sol_main | 16.1M | $22.1M |
| hylo_shyusd | 11M | $22.9M |

- 検証: lib 293 / BFF 600 / mobile 427 / MCP 20 / web 139 tests green、`pnpm -r typecheck` green。`verify:tx` 連続 2 回とも 要調査 0 / exit 0、`verify:oracle` 7 asset OK。web e2e 113/113。Menu の Staking tab を screenshot で確認 ($275.9M / $1.2B / $124.1M / $382.1M / $24.2M)
- 未検証: 実際の 429 を再試行で吸収する経路は live で踏めなかった (今回の実行では 429 が出なかった)。単体 test では 429 → 200 / 3 回 429 / Retry-After を確認済み

### Seeker を web と同じ部品に乗せ替え (2026-10-06、未 commit、Opus 5.5 subagent)
- 背景: ActionModal の `handleExecute` は market 解決と 13 分岐 (swap-earn → Kamino reserve → kVault → Meteora → Orca → Save → Exponent) を約 400 行自前で持っていた。web 移植で同じ cascade を `lib/derive/solana-action.ts` の `resolveSolanaRoute` に写していたので、Seeker もそれに乗せ替えて重複を消す
- 実装:
  - `services/solana-tx.ts` (新規): `buildSolanaTxs(route, user, amount)` が 13 route を mobile の `api.get*` builder に写す (web `src/solana/buildTx.ts` と同じ switch。swap-earn は `slippageBps: 50` を明示、応答 key の `swapTransaction` / `transaction` / `transactions` の差を吸収、`default` は `never`)
  - `ActionModal.tsx`: `resolveSolanaRoute(action)` → `runOnchainTx(() => buildSolanaTxs(...))` に置換 (-400 行)。`canOnchain` / `action.amount` の gate、fail-closed (`route === null` → lib の `UNSUPPORTED_MARKET_MESSAGE`)、`signSubmitAndSettle`、`BffError` / plain Error の扱いは従来どおり。registry の `find*` import と web3.js `Transaction` 依存を削除
  - tier C (Pyth 単独 asset) の注記: `<WarningArea>` の外に muted 1 行「Single price source (Pyth). Not cross-checked against a second oracle.」(warning ではないので CTA を止めない。testID `oracle-single-source-note`)。`ActionModal.test.tsx` を新設 (tier C で出る / tier A で出ない / blocked なら blocked card)
  - Perena の案内: `VaultRow` に `note` / `externalUrl` (pool から写す)。`VaultRowView` に note の caption と「Open Perena ↗」(`Linking.openURL`、testID `pool-link-<key>`)。「View only」badge は維持
- 検証: mobile 427 → 456 tests green (suites 38 → 40)、`tsc` 新規エラーなし。`verify:tx` 23 経路 要調査 0
- 未検証 (Seeker 実機、ユーザー): deposit / withdraw 1 往復 (route 無しの pool で Unsupported market が出ること)、tier C 注記、Menu → Perena → Tri-Stable の link

### Solana agent plan の承認 inbox を web に (2026-10-06、未 commit、Opus 5.5 subagent 3 本で実装)
- 背景 (調査 2026-10-06): BFF の `/agent-plans` は approve で token を出し、`/execute` は swap-earn だけ unsigned tx を **Agent に返す** (`pushed_to_mobile` という label だけ) 作りで、誰も署名しない。plan はメモリのみ、wallet で絞れず、fixture と autonomous dry-run が混ざる。mobile の承認画面は `?token=` 必須 (token は approve 後にしか無いので実 plan は開けない)、push payload は `token_id` を要求して捨てる。memo stub (`buildMemoTransaction`、devnet) は fixture plan 専用
- 判断 (ユーザー決定): **web が approve → 組む → 署名 → 送信まで一気に** (ETH の ProposalInbox と同じ「承認 = 実行」)。MCP の `request_user_approval` は終端まで待って signature を返す。`execute_approved_action` は policy auto 承認 (autonomous) 専用。永続化と絞り込みは ETH に揃える (`.data/agent-plans.json`、24h で `expired`、`GET /agent-plans?wallet=`、fixture は test のみ)
- 契約 (`lib/types/agent-plan.ts` に `expires_at` / `approved_by: "user" | "auto"` / `execution { execution_id, signatures, submitted_at, via }` / `failure_reason`、応答型 `AgentPlanExecuteResponse` 等):
  - `POST /approve` (body なし) → approved + `approved_by: "user"` + token。**人が承認済みの approved plan にも token を再発行** (Seeker で承認 → web で署名、gate 拒否後の再試行のため。auto 承認の plan は 409)
  - `POST /execute {approval_token, via}` → `resolveSolanaRoute` で 13 route すべてを既存 `/protocols/*` route に in-process (`app.inject`) で流して組む。oracle / fair-value / 残高 / 預入停止の gate は builder 側のものがそのまま効く。応答 `{execution_id, status: "awaiting_signature", unsigned_transactions[{index,label,tx_base64}]}`、plan は executing。builder が止めたら status と body を透過し plan は approved のまま token 未消費 (再試行可)
  - `POST /signatures {execution_id, signatures[]}` → broadcasted (本数一致、base58 形式)。`POST /failed {execution_id, reason}` → failed。`/reject` は simulated | pending_user | approved からのみ。`GET /approval` は auto 承認の時だけ token を出す。`GET /agent-plans?wallet=` で絞る。期限超過は読み出し時に expired
  - MCP: `request_user_approval` は broadcasted (signatures) / failed (failure_reason) / rejected / expired / auto 承認 (token) / timeout を返す。`execute_approved_action` は人が承認した plan には `awaiting_user_signature` を返し `/execute` を呼ばない
  - mobile: push payload の `token_id` を任意に、承認画面は token 無しで開く、approve は body なし、承認後は「Sign & send from the Seasonals web app.」(Seeker で署名するのは後続)。`httpPostJson` は body 無しの時 content-type を付けない (Fastify の `FST_ERR_CTP_EMPTY_JSON_BODY` 400 を実 BFF で踏んだ)
- web (`src/agent/SolanaPlanInbox.tsx`): /agent の「Proposals from your Agent」の下に「Solana plans from your Agent」。card は status tag / action と金額 (`toHumanReadable` は表示直前) / protocol / estimated out / oracle 要約 (`ORACLE_WARNING_HEADLINE`) / bundle_hash / 期限 / Solscan link。**Approve & sign** (pending_user | simulated) と **Sign & send** (approved) は approve → `useSignAndSubmit(wallet_id).run(execute → unsigned tx)` → `/signatures`、wallet 拒否 / 送信失敗は `/failed`。`/execute` の 409 は「Declined by safety gate」(plan は approved のまま、`/failed` は呼ばない)。plan の wallet が接続 wallet と違えば署名ボタンを出さない。polling は live な plan がある間 5 秒、無ければ 15 秒 (ETH と同じ)
- 検証: lib 293 / BFF 634 / mobile 456 / MCP 24 / web 152 tests green、`pnpm -r typecheck` green。`verify:tx` 23 経路 要調査 0。web e2e 116/116 (agent inbox の 3 check 含む)。**MCP e2e** (新コードの MCP server を stdio で spawn、dev BFF 相手): compare → simulate (jupiter_lend USDC 1.0) → request_user_approval を待たせつつ web 相当の approve → execute (mainnet の実 tx 構築、署名なし) → /failed で Agent に `{status:"failed", failure_reason:"user_cancelled"}` が返る、wallet filter、token の秘匿、user 承認 plan への `execute_approved_action` が `awaiting_user_signature`、再 approve の token 再発行 — 19/19
- 未検証: 実 wallet で web から署名して送る (mainnet 少額、ユーザー)、Seeker 実機で承認画面が token 無しで開くこと
- 範囲外: Seeker 上での agent plan 署名、`/agent-plans` の認証 (従来どおり無し)

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
- Ethereum: mainnet への送信 (意図的に経路なし)、browser wallet 署名。Solana は実装済み (上の「Solana を web で実行」「oracle 移行」)。実 wallet での mainnet 送信は未検証
- CCA `exitPartiallyFilledBid`
- Uniswap の UniswapX `/order`
- Aqua の mainnet 実行
- Aave action
- LLM 提案、hidden concentration warning
- mobile 幅 (<1100px は 2×2 まで)
- Menu (旧 Explore) の「Add to calendar」。自分の予定 (絵文字 + 内容) は日付から手入力できるが、このブラウザの localStorage のみ (BFF / MCP には未同期)
