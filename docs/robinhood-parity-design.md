# Seasonals × Robinhood 連携 実装設計・計画書

- バージョン: **0.2** / 改訂日: 2026-09-19 (0.1 は同日、ChatGPT 未読のまま Solana 側対応物だけで書いた版。付録 A に圧縮して残す)
- ステータス: 実装提案。アプリコード・DB・本番設定の変更は含まない。**アプリ実装の完了報告ではない。**
- 基準: [spec.md v0.2.15](spec.md)、[CLAUDE.md](../CLAUDE.md)、ローカル HEAD `eb4f94c`。
- 起点 (両方とも全文取得済み):
  - [Robinhood機能再考検討](https://chatgpt.com/share/6aae122f-b790-83ee-b92b-9576f5762555) (12:33) — SEMI3X / SEMI Adaptive / 独立 Strategy Protocol の再評価。結論は「個人別バスケット + 定期購入・配分調整」を最初の商品にする
  - [Seasonals実装提案](https://chatgpt.com/share/6aae1243-5ffc-83e9-9dd2-b1334bef567a) (12:43、「3x バスケットは忘れる」前提) — Stock Token の Execution Window を中核に、Robinhood Trading MCP / Morpho timeline / Bridge lifecycle / Prediction market interface を提案
- 姉妹文書: [hyperliquid-integration-design.md v0.1](hyperliquid-integration-design.md) (同日。**`ChainRef` / `LinkedAccount` / nullable view / 外部 EVM wallet 署名の設計はそのまま流用し、本書で再定義しない**)、[skr-integration-design.md v0.2](skr-integration-design.md) (要求の強さ・FND 案件の定義)、[RFC-001](rfc-oracle-exit-operations.md)。

---

## 0. 2 スレッドのレビューと採否

| スレッドの結論 | 本書の採否 | 理由 |
|---|---|---|
| (12:43) Stock Token の **Execution Window** を中核にする。「いつ実行するか」に加え「今実行してよい状態か」を判定 | **採用・中核** (§5) | Seasonals の simulate → approve → execute に自然に乗り、公式 API (`tradingCapabilities` / `isTradingHalt` / `oraclePaused()` / Chainlink `updatedAt`) で全入力が取れることを確認した (§2) |
| (12:43) Morpho Earn / Lending timeline (APY 変化・campaign 終了・health review) | 採用 (RH-R0 読取) | Morpho API が chain 4663 を正式サポート。Kamino health 分岐と同型に落ちる |
| (12:43) Bridge lifecycle (7 日 challenge → claimable) | 採用 (RH-R0 読取、R2 で claim) | 公式 docs で 7 日 + L1 手動 claim を確認。`lockup_end` そのもの |
| (12:43) Robinhood Trading MCP と接続、Seasonals は Temporal Planner | **採用するが RH-R3 に後置** | 公式仕様は「Agentic account 専用・desktop 認証・US 居住者」。Stock Token (US 除外) と**利用者集合が交わらない**上、第三者サーバーが本人に代わって接続してよいかが未確認 (§2.3)。tool 名 (`review_equity_order` 等) も公式ページで確認できず |
| (12:43) Prediction Markets は interface だけ | 採用 (adapter interface のみ、DEFER) | Trading MCP に event-contract 実行が無いのは公式ページと整合 |
| (12:43) Uniswap / UniswapX は execution backend | 採用 (RH-R2 の `rotate` backend、hero にしない) | §31.3 の trader DNA 回避と一致 |
| (12:43) Lighter / Arcus perps は優先しない | 採用 | perps の時間軸は Hyperliquid 設計書が担当 |
| (12:33) 独立プロトコル (個人別資産管理コントラクト) を Robinhood Chain に作り Seasonals を管理画面にする | **見送り (DEFER)** | 新規コントラクトは監査・地域制限・Seasonals の「鍵を持たない」構造 (§32.2) と衝突する検証項目が多い。**同じ体験は既存 Position + `UnifiedTimeEvent` + 既存 ActionType で出せる** (§4) ので、まずコントラクト無しで検証する |
| (12:33) 「個人別バスケット + 定期購入・配分調整」を最初の商品に | 部分採用 → RH-R3 の "Plan" | 「予定された配分調整が市場状態で保留され、条件が整ってから再見積・承認・完了」という体験は §5 の ExecutionState と `forecast_marker` で表せる。定期購入の**執行**は EVM 署名経路 (HL-R2) が前提 |
| (12:33) 企業行動・価格更新・実行可能状態の管理は必須基盤 | 採用 (RH-R0/R1 の中身そのもの) | 12:43 スレッドと同じ結論 |
| (12:33) 株式担保借入の管理・返済は次段階 | 採用 (Morpho health → RH-R2 repay) | |
| (12:33) 共有バスケット / Vault、SEMI Adaptive、SEMI3X | 見送り | 12:43 スレッド自身が撤回。本書でも扱わない |

**両スレッドに無かった論点で本書が足すもの**: (a) Seeker の Seed Vault / MWA は EVM 署名不可 → Robinhood Chain は Hyperliquid と同じく**読取から始め、実行は外部 EVM wallet** (§3)。(b) §4.6 Oracle 規約は Pyth / Switchboard 前提で、Robinhood Chain には Chainlink しか無く、しかも株式 feed は休場中に更新を止める → 実行解禁には **RFC-002** が要る (§5.3)。(c) Solana 側の対応物 (xStocks / Kamino xStocks market / Jupiter Recurring / Kalshi-DFlow) は Seeker がネイティブに署名できる別経路として付録 A に残す。

---

## 1. 結論

**Robinhood Chain を、Hyperliquid 設計で導入する chain 汎用化 (`ChainRef` / `LinkedAccount`) の 2 本目の EVM chain (`eip155:4663`) として載せる。** 最初のスライスは読取専用で、Stock Token の保有・企業行動・実行可能状態、Morpho の health / rewards、bridge の claimable を既存 Calendar に並べる。

| 判断 | 内容 |
|---|---|
| 最初に通す (RH-R0) | 利用者が入力した EVM address の Stock Token 残高 (raw × `uiMultiplier`)、pending 企業行動、Morpho position、bridge 出金の claimable 予定。全て読取 |
| デモの主役 (RH-R1) | **Execution Window**: 保有 Stock Token ごとに「今実行できるか / 市場再開待ち / 要確認 / 不可」を公式 API と Chainlink から判定し、Calendar の予定に理由付きで表示。「予定された操作が休場・企業行動で保留され、条件が整うと再見積できる」一連 |
| 最大の設計制約 | **EVM 署名**。Seed Vault / MWA では不可。RH-R2 の署名者は外部 EVM wallet (HL-R2-SIGN-01 の成立が前提)。RH-R0/R1 は署名 CTA を出さない |
| Oracle | Chainlink のみ (Pyth / Switchboard 無し)、株式 feed は 24/5 で休場中は last price を保持し heartbeat 無し、企業行動中は `oraclePaused()`。**§4.6 は変更しない**。実行解禁は RFC-002 採用後 |
| Trading MCP | 別軸 (offchain 証券口座、US 限定)。RH-R3。Seasonals BFF が本人資格情報で MCP client になる構造は FND-01/02 + 規約確認が前提 |
| enum | `TimeEventCategory` 8 / `ActionType` 12 / `PositionCategory` 10 は**増やさない** (§32.2、Hyperliquid 設計と同じ) |
| 地域 | Stock Token は **US / CA / UK / CH 等の居住者に提供不可**。Trading MCP は **US のみ**。両軸を同一ユーザーに同時に訴求しない |

---

## 2. 外部仕様として確認したこと (2026-09-19 取得)

### 2.1 Robinhood Chain / Stock Token

| 項目 | 確認結果 | 出典 |
|---|---|---|
| chain id / RPC | mainnet `4663`、testnet `46630`。`https://rpc.mainnet.chain.robinhood.com`、sequencer feed `wss://feed.mainnet.chain.robinhood.com`、explorer `robinhoodchain.blockscout.com`。gas は ETH。Alchemy 推奨 | [connecting](https://docs.robinhood.com/chain/connecting/) |
| Stock Token 契約 | ERC-20、18 decimals。**非 rebasing**。`uiMultiplier()` (1e18 = 1.0、ERC-8056 Scaled UI Amount)、`underlying shares = raw × uiMultiplier ÷ 1e18`。予定変更は `newUIMultiplier()` / `effectiveAt()`、event `UIMultiplierUpdated(old, new, effectiveAt)`。企業行動処理中は `oraclePaused()` (advisory) | [building](https://docs.robinhood.com/chain/building-with-stock-tokens/)、[Chainlink](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood) |
| REST (`https://api.robinhood.com/rhj/`、API key 不要、60 rps) | `GET /assets` (cache 15s): `currentMultiplier` / `pendingMultiplier` / `pendingMultiplierEffectiveTime` (RFC-3339) / `tradingCapabilities.{fractionalTradability, allDayTradability, extendedHoursFractionalTradability}` / `status`。`GET /prices/{symbol}` (15s): `bid` / `ask` (**原株価格、multiplier 未調整**) / `isTradingHalt` / `generatedAt`。`GET /corporate-actions` (1h): `type` 14 種 (split / cash・stock dividend / spin-off / merger / redemption / name change / …) / `status` / `processDate` / `details` | [stock-token-apis](https://docs.robinhood.com/chain/stock-token-apis/) |
| Chainlink feed | `AggregatorV3Interface`、**multiplier 調整済み** (Total Return Value)。24/5、休場中は last price を保持し **heartbeat 無し** → `updatedAt` で staleness 判定必須。企業行動中は paused | [oracles](https://docs.robinhood.com/chain/oracles-and-price-feeds/)、[Chainlink](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood) |
| Tokenization window (一次市場 mint/burn) | **月 02:00 CET/CEST – 土 02:00 CET/CEST**。AP / market maker のみ (KYB)。window 外でも onchain 二次取引は可 | [stock-tokens](https://docs.robinhood.com/chain/stock-tokens/) |
| 取引セッション | market / extended / overnight。`tradingCapabilities` で銘柄別。halt は `/prices.isTradingHalt` | 同上 |
| 地域 | **US 居住者に提供不可**。CA / UK / CH 等も制限 | 同上 |
| Bridge (canonical、Arbitrum) | 入金 ~10 分。出金は **7 日 challenge → Ethereum L1 で手動 claim (L1 gas)**。UI は portal.arbitrum.io。USDG 等 OFT は LayerZero / Stargate (分単位) | [bridging](https://docs.robinhood.com/chain/bridging/) |
| エコシステム | Uniswap (DEX)、Morpho (lending)、Chainlink、LayerZero、Paxos USDG、ERC-4337 | [about](https://docs.robinhood.com/chain/) |

### 2.2 Morpho on Robinhood Chain

- Morpho API (GraphQL `api.morpho.org/graphql`) は **chain 4663 を fully supported** として列挙。market / vault の現在値・時系列、user の supply / borrow / collateral position、rewards campaign APR が取れる ([docs](https://docs.morpho.org/tools/offchain/api/get-started/))。
- Robinhood Earn は Steakhouse USDG vault (Morpho、Robinhood Chain 決済) で構築 ([morpho.org](https://morpho.org/blog/robinhood-chooses-morpho-to-power-new-earn-product)、[app](https://app.morpho.org/robinhood-chain/vault/0xBeEff033F34C046626B8D0A041844C5d1A5409dd/steakhouse-usdg))。
- **未確認**: 12:43 スレッドの「NVDA / GOOGL / AAPL を担保にした USDG market が 4663 に存在」は Morpho API で market 一覧を実測してから registry に載せる (RH-R0 着手前確認)。

### 2.3 Robinhood Trading MCP (Agentic Trading)

- server `https://agent.robinhood.com/mcp/trading`。2026-05-27 公開。対応 client は Claude Code / Claude Desktop / ChatGPT / Codex / Cursor / Grok 等。**Agentic account (専用の self-directed 口座) 内でのみ発注**、read は全口座。desktop でのみ口座開設・認証。equities / options / crypto。kill switch あり ([overview](https://robinhood.com/us/en/support/articles/agentic-trading-overview/)、[newsroom](https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/))。
- **未確認**: 個別 tool 名 (`review_equity_order` / `place_equity_order` / `get_earnings_calendar`)、第三者サーバー (Seasonals BFF) が本人の資格情報で接続することの規約上の可否、2026-09-09 経営陣発言 (prediction markets / futures への拡張)。RH-R3 着手前確認。

---

## 3. リリース境界

| リリース | 提供する価値 | 必須依存 | 優先順位 |
|---|---|---|---|
| **RH-R0: Robinhood Chain 読取** | linked EVM address の Stock Token (raw × multiplier)、pending 企業行動、Morpho position (supply / borrow / health / rewards)、bridge 出金 claimable を Your Positions と Calendar に表示 | **HL-R0 の `ChainRef` / `LinkedAccount` / nullable view が先に入っていること**、BFF `viem` (HL-R1 と共用)、Robinhood REST、Morpho API、Ethereum L1 RPC (bridge claim 判定) | 実装対象 (HL-R0 の直後) |
| **RH-R1: Execution Window + デモ** | 保有銘柄ごとの `ExecutionState` と理由、休場・halt・企業行動・tokenization window の予定を Calendar に集約表示。CTA 無し | RH-R0 | 実装対象 (デモ) |
| RH-R2: 実行 | Morpho supply / withdraw / repay / add_collateral、bridge claim (L1)、Uniswap 経由 `rotate` を simulate → approve → 外部 EVM wallet 署名 → broadcast | **HL-R2-SIGN-01** (Seeker 上の WalletConnect 署名成立)、`ExecutionPayload`、**RFC-002** (Chainlink / 市場時間 oracle)、FND-01/04、地域制限の方針 | 別判断 |
| RH-R3: Plan と Trading MCP | (a) 「毎月 X 日に配分を見直す」Plan を `forecast_marker` + ExecutionState で運用 (12:33 スレッドのバスケット体験、コントラクト無し)、(b) Trading MCP を offchain data / execution adapter として接続し、決算日 review event を生成 | RH-R2、Robinhood 側規約確認、FND-01/02 (資格情報の保管)、prediction market adapter interface | 別判断 |

**RH-R0 から外す:** EVM 署名、WalletConnect、DB、認証、server push、MCP 公開 (`agentReadable=false`)、USD 合計への算入 (RFC-002 まで)、Stock Token の売買、独立コントラクト、Trading MCP、Lighter / Arcus perps。

要求の強さ (MUST / SHOULD / DEFER) は SKR 設計 §1 の定義に従う。

---

## 4. spec 照合と enum 写像 (8 / 12 / 10 を維持)

| 仕様 | 照合結果 / 判断 |
|---|---|
| §11.4 `TimeEventCategory` | 8 種で足りる (下表)。12:43 スレッドの `RobinhoodTimeEvent` 10 種は **`metadata.source` に写す**。新 category は作らない |
| §5.7 `ActionType` | Morpho: `deposit` / `withdraw` / `repay` / `add_collateral`、bridge claim: `withdraw`、Uniswap 経由の配分変更: `rotate`。**12 種で足りる**。Stock Token の「買い」は `rotate` (USDG → 株式トークン) だが RH-R2 でも `display_only` から始める |
| §5.2 `PositionCategory` | Stock Token は `other` + `metadata.asset_class = "tokenized_equity"`。Morpho vault は `vault`、Morpho market supply/borrow は `lending`。`rwa` 追加は別 §32.2 案件 |
| §4.5 | raw は 18 decimals 整数 string、multiplier は 1e18 整数 string、REST の price / rate は decimal string → `toSmallestUnit` (USD 8 decimals)。Number 禁止 |
| §4.6 | 変更しない。Robinhood Chain には Pyth / Switchboard が無いので、**現行規約下では execute は常に `oracle_unavailable`**。RFC-002 (§5.3) が採用されるまで R2 を出さない |
| §6.5 / §32.2 「署名は MWA」「鍵を持たない」 | Hyperliquid 設計 §3.2 と同じ分岐。R0/R1 は署名なし、R2 は外部 EVM wallet。Seasonals は鍵を持たない |
| §11.1 Wallet | `linked_accounts` (HL 設計 §4.3) に `{family:"evm", chain_id:4663}` を追加するだけ。所有未検証を UI に常時表示 |
| §13.2 registry | `robinhood_stock_token` / `morpho` / `robinhood_bridge` を追加、`chains: [eip155:4663]` (bridge は `eip155:1` も)。trust level は admin 判断 (仮: Morpho A、Stock Token A、bridge A) |
| §13.3 unknown assets | multiplier が読めない ERC-20 は「既知」に混ぜない。`/assets` に無い symbol は unsupported |
| §32.2 "One tap. No new tab." | R0/R1 は訴求しない。R2 も外部 wallet への app 切替が入るため Robinhood には使わない |

### 時間イベント写像

| 事象 | 元データ | category | actions | agentReadable | 備考 |
|---|---|---|---|---|---|
| 企業行動 (配当再投資 / 分割 / 合併 …) の multiplier 有効化 | `/assets.pendingMultiplierEffectiveTime`、`effectiveAt()`、`/corporate-actions` | `forecast_marker` (`source="corporate_action"`, `kind=type`) | — | R1 から true | 表示数量が変わる予定。cash merger / redemption / worthless removal は `urgency=watch` |
| US 市場 open / close、tokenization window 開閉 | 固定スケジュール + `tradingCapabilities` | `forecast_marker` (`source="market_session"`) | — | false | **保有銘柄がある日だけ、1 日 1 件に集約** (24 件 / 日を出さない、HL 設計の funding と同じ規則) |
| trading halt / oracle paused | `/prices.isTradingHalt`、`oraclePaused()` | イベントにしない → `ExecutionState` (§5) の理由に載せる | — | — | 時刻を持たないので Calendar に置かない |
| Morpho 借入の LTV 上昇 | Morpho API position (`ltv` / `lltv`) | `health` | R2: `repay` / `add_collateral` | true | 既存 `health: {ltv, liquidation_ltv}` 分岐にそのまま写像 |
| Morpho rewards campaign 終了 / claimable | Morpho API rewards | claimable > 0 なら `claim`、終了予定は `forecast_marker` (`source="reward_campaign_end"`) | R2: `claim` | true | |
| Morpho vault APY 変化 | Morpho API 時系列 | `forecast_marker` (`source="apy_change"`、閾値超のみ) | — | true | spec §5.8 Phase 2「利回り差分アラート」の実体 |
| Bridge 出金 (7 日 challenge) | L2 出金 event + L1 outbox 状態 | `lockup_end` (`unlock_at = initiated + 7d`) | R2: `withdraw` ("Claim on Ethereum") | true | 到達判定は L1 outbox の再取得で行う (端末時計で ready にしない) |
| 決算日 review (R3、Trading MCP) | earnings calendar | `forecast_marker` (`source="earnings"`) | — | true | Seasonals は売買を推薦しない (Cortex と競合しない) |
| Prediction market resolve (R3、interface のみ) | — | `maturity` | — | — | adapter interface だけ切る |

---

## 5. Execution Window Engine (RH-R1 の中核)

### 5.1 目的

「いつ」だけでなく「その時に実行してよい状態か」を Seasonals が判定し、予定 (event) と操作 (action) の両方に理由付きで貼る。12:43 スレッドの提案をそのまま採用し、入力を公式 API に限定する。

### 5.2 入力と判定

`lib/types/execution-window.ts` (新設、Mobile / BFF / MCP 共有):

```typescript
export type ExecutionState =
  | "executable"          // 全 gate 通過
  | "wait_market_open"    // 休場 / overnight 不可 / tokenization window 外 (時刻が分かる待ち)
  | "review_required"     // 企業行動 pending / halt 解除直後 / price 乖離 / 流動性不足 (人の確認が要る)
  | "not_executable";     // halt 中 / oraclePaused / asset inactive / 地域制限 / feed 不明

export interface ExecutionWindow {
  state: ExecutionState;
  reasons: ExecutionReason[];       // 複数可。UI は先頭を見出しに
  next_check_at: string | null;     // wait_* のとき次に評価が変わる時刻 (ISO)
  evaluated_at: string;             // ISO
  inputs_hash: string;              // 判定に使った入力の hash (再評価で変化を検出)
}
```

| 入力 | 取得元 | 判定 |
|---|---|---|
| `status` | `/assets` | `ASSET_STATUS_ACTIVE` 以外 → `not_executable` |
| `tradingCapabilities` × 現在セッション | `/assets` + セッション表 | 現セッションで untradable → `wait_market_open` (`next_check_at` = 次セッション開始)。`position_closing_only` → 買い側のみ `not_executable` |
| `isTradingHalt` | `/prices` | true → `not_executable` |
| `oraclePaused()` | token contract | true → `not_executable` (企業行動処理中) |
| pending multiplier | `/assets` / `effectiveAt()` | 有効化まで 24h 以内 → `review_required` (数量表示が変わる) |
| Chainlink `updatedAt` | feed | 現セッションが open なのに古い → `not_executable`。休場中は `wait_market_open` (stale ではなく closed として扱う、§5.3) |
| Chainlink price vs `/prices` bid/ask × `currentMultiplier` | 両方 | 乖離 > 閾値 → `review_required` (execute は RFC-002 の乖離規則に従う) |
| tokenization window | 固定スケジュール | 一次市場が閉じている間は二次流動性が薄くなり得る → `review_required` (SHOULD、実測で閾値化) |
| Morpho market liquidity / utilization | Morpho API | withdraw 額 > available → `not_executable`、utilization ≥ 0.9 → `review_required` (既存 menu の 0.9 警告と同じ) |

判定は **BFF が行い** (`robinhood/execution-window.ts`)、Mobile は結果を表示するだけ。決定性のため `now` と全入力を引数で渡し、golden test を置く。

### 5.3 RFC-002 (別起票、R2 の前提) — Chainlink と市場時間

現行 §4.6 は「primary Pyth / fallback Switchboard / 60 秒 staleness / 両 stale で拒否」。Robinhood Chain には Chainlink しか無く、株式 feed は休場中に **意図して** 更新を止める。よって現行規約をそのまま適用すると R2 は「常に拒否」になる。本書は §4.6 を変更せず、RFC-001 と同形式で次を提案する (採否は別判断):

1. oracle provider を chain ごとに registry で選ぶ (`solana` = Pyth/Switchboard、`eip155:4663` = Chainlink + REST `/prices` を「乖離検出用の第 2 ソース」として使う。REST は multiplier 未調整なので `currentMultiplier` を掛けてから比較)。
2. 「stale」と「closed」を区別する。closed (セッション表 + `updatedAt` が最終セッション終了以降) は simulate 可 / execute 不可 (`market_closed`)。open なのに `updatedAt` が閾値超なら従来通り `oracle_both_stale` 相当で拒否。
3. `oraclePaused()` は advisory だが、true の間は execute 拒否。
4. Morpho の USDG 建て操作 (supply / withdraw / repay) は Chainlink USDG feed の有無を実測し、無ければ stablecoin 用の別規則を RFC に含める。

---

## 6. 数値・データ契約

| 項目 | 規則 |
|---|---|
| Stock Token 残高 | raw (18 decimals 整数 string) と `uiMultiplier` (1e18 整数 string) を別々に保持。表示株数 = `raw × multiplier / 1e18` を bigint で計算 (`numeric.ts` に `applyUiMultiplier(raw, multiplier1e18)` を追加、Solana Token-2022 用の decimal multiplier とは別関数)。**tx は raw** |
| 価格 | Chainlink は multiplier 調整済み、REST は未調整。**同じ画面で混ぜない**。USD 評価は Chainlink (R0 では表示のみ、合計非算入)。decimal string → USD 8 decimals string |
| 企業行動 rate | decimal string のまま保持し表示専用。数量には使わない (multiplier が正) |
| 時刻 | REST は RFC-3339、契約は unix 秒、bridge は L1 block time。ISO へ正規化し、到達判定は再取得で行う |
| ID | `chainRefId` (`eip155:4663`) を position / event id に含める (HL 設計 §10) |
| rate limit / cache | REST 60 rps 共有、`/assets` `/prices` 15 秒、`/corporate-actions` 1 時間の cache window に合わせて BFF 側 cache を揃える。Morpho GraphQL は complexity 予算 |
| 地域 | Stock Token 行には「提供地域制限あり」を常時表示。Seasonals は発行体でも取引所でもないが、R2 の売買 CTA は地域方針決定まで出さない |

---

## 7. アーキテクチャ差分

Hyperliquid 設計 §4 の型 (`ChainRef` / `LinkedAccount` / `CooldownPositionView` 系 nullable view / `ExecutionPayload`) を前提に、追加分だけ:

```text
lib/
  types/execution-window.ts          # §5.2 (R1)
  config/robinhood-chain.ts          # chain 4663 / REST base / セッション表 / tokenization window / registry entries
artifacts/seasonals-bff/src/
  clients/robinhood-rhj.ts           # /assets /prices /corporate-actions (undici、zod、cache window 同期)
  clients/robinhood-chain-rpc.ts     # viem publicClient (4663): balanceOf / uiMultiplier / newUIMultiplier / effectiveAt / oraclePaused / Chainlink latestRoundData
  clients/morpho-api.ts              # GraphQL: user positions / vaults / markets / rewards (chain 4663)
  clients/arbitrum-bridge.ts         # L2 出金 event + L1 outbox 状態 (Ethereum RPC、R0 は読取)
  robinhood/state.ts                 # 応答 → nullable view + PositionSnapshot[] → 既存 deriveTimeEvents
  robinhood/execution-window.ts      # §5.2 判定 (決定的、golden test)
  server.ts                          # GET /protocols/robinhood/state?address=  (feature flag FEATURE_ROBINHOOD_READ)
artifacts/seasonals/
  components/drawer/                 # Robinhood セクション (HL と同じ専用 renderer、vault-rows.ts を通さない)
  components/calendar/event-display.ts  # source = corporate_action / market_session / reward_campaign_end / apy_change の headline
  services/api.ts / queries.ts       # getRobinhoodState
```

`derive-time-events.ts` は変更しない。`PositionSnapshot` の `forecast` / `health` / `claimable` / `unlock_at` に流し込む。MCP Server は変更なし (R0/R1 は `agentReadable=false` → R1 末で schema 固定後に true)。

---

## 8. 受け入れ条件

### RH-R0

| テスト ID | 入力 / 操作 | 期待結果 (MUST) |
|---|---|---|
| RH-R0-READ-01 | `/assets` `/prices` `/corporate-actions` の正常 / 型不一致 / timeout / 429 | 正常のみ fresh。不一致は unsupported、timeout は unavailable、429 は rate_limited。fake 値なし |
| RH-R0-MULT-01 | raw `1e18`、multiplier `1.0123e18`、および u256 上限付近 | 表示株数が桁落ちなく一致。`Number` / `parseFloat` 0 件 (lint)。multiplier 読取失敗の mint は unsupported |
| RH-R0-CA-01 | pending multiplier あり / なし / 有効化後 | あり → `forecast_marker` 1 件 (`triggerAt` = effective time)。なし・有効化後 → 0 件。同 snapshot で導出 2 回が deep equal |
| RH-R0-MORPHO-01 | borrow あり (ltv / lltv)、rewards claimable、vault のみ | `health` 分岐が既存閾値 (0.7 / 0.9) で発火。claimable > 0 で `claim` (actions 空)。vault のみは event 0 件 |
| RH-R0-BRIDGE-01 | 出金 initiated (challenge 中) / 到達 / claim 済 | challenge 中 → `lockup_end`、到達は L1 再取得でのみ判定、claim 済は 0 件 |
| RH-R0-NULL-01..04 | HL-R0-NULL-01..04 と同一 | `Position` へ代入不可、portfolio 合計に非算入、MCP 非混入、`agentReadable=false` |
| RH-R0-PRICE-01 | Chainlink と REST × multiplier を同一行に | 表示は片方のみ。両方を足す / 平均する経路が 0 件 |
| RH-R0-SCOPE-01 | flag ON で全画面 | 署名 CTA / AgentPlan 生成 / DB mutation 0 件。flag OFF で route 404 |

### RH-R1

| テスト ID | 適用 | 機械判定 |
|---|---|---|
| RH-R1-EW-01 | §5.2 の各入力 × 4 state | golden fixture 全組合せ。`reasons` 非空、`wait_*` は `next_check_at` 非 null |
| RH-R1-EW-02 | 休場中 + `updatedAt` 古い | `wait_market_open` (not `not_executable`)。open + 古い → `not_executable` |
| RH-R1-SESSION-01 | 保有 3 銘柄、同日 | `market_session` marker は 1 日 1 件に集約 |
| DEMO-RH-01 | Solana + Hyperliquid + Robinhood の予定 | 同一 Calendar に描画、fixture 表示、署名 / 送金の成功表示 0 件 |

R2 / R3 の受け入れ条件は HL-R2-EXEC-01..06 を EVM chain 4663 に読み替え、RFC-002 の規則を追加して別途起票する。

---

## 9. 実装計画と工数

| 順序 | Phase (仮) | 内容 | 前提 | 目安 |
|---|---|---|---|---|
| 1 | 9.0 (HL-R0) | `ChainRef` / `LinkedAccount` / nullable view の導入 (Hyperliquid 設計) | — | HL 設計の見積 |
| 2 | **9.3 RH-R0** | Robinhood REST / RPC / Morpho / bridge の fixture 化 → state → Calendar | HL-R0、`viem` (HL-R1 と共用) | **5–7 人日** |
| 3 | **9.4 RH-R1** | Execution Window Engine + セッション集約 + デモ fixture + Seeker 確認 | RH-R0 | **4–6 人日** |
| 4 | RFC-002 起票 | Chainlink / 市場時間 oracle 規則 | RH-R1 の実測 (feed の休場挙動) | 文書 1–2 日 |
| 5 | 9.5 RH-R2 | Morpho 操作 / bridge claim / Uniswap `rotate` | HL-R2-SIGN-01、RFC-002 採用、FND-01/04、地域方針 | 10 人日 + wallet 検証 (HL-R2 と共有) |
| 6 | RH-R3 | Plan (定期見直し) / Trading MCP / prediction adapter interface | RH-R2、Robinhood 規約確認、FND-02 | 未見積 |

RH-R0 の作業順は HL-R0 (HL 設計 §11) と同じ段取り: (0) 実 address で REST / RPC / Morpho を叩き fixture 化 → (1) config / registry → (2) clients → (3) state + derive → (4) mobile query / drawer → (5) MCP 非混入テスト + Seeker JS reload。完了ゲートは `pnpm -r test` / `pnpm -r typecheck`、BFF 依存追加時は `verify:tx`。

---

## 10. 停止条件と訴求ガード

- **停止:** `FEATURE_ROBINHOOD_READ` (R0/R1)、`FEATURE_ROBINHOOD_EXEC` (R2、action 別)。
- **訴求してよい (R0/R1):** 「Solana / Hyperliquid / Robinhood Chain の予定を 1 つの Calendar で読む」「配当・分割で表示株数がいつ変わるかを先に知っている」「今この操作が実行できる状態かを理由付きで示す」。
- **訴求しない (R2 まで):** "One tap" / "No new tab" / 「Robinhood Chain を Seasonals から操作」。
- **訴求しない (常時):** 「Seasonals が株を選ぶ / 自動売買する」 (Cortex と競合しない立場を維持、12:43 スレッドと同じ)。
- **地域:** Stock Token は US 不可、Trading MCP は US のみ。デモ・LP・ストア説明で両方を同一ユーザー向けに並べない。
- **PROD-RH-01 (SHOULD):** Stock Token 保有者 3–5 人に「企業行動の予定と実行可否が読めたか」「Solana の予定と並べたいか」を観察。弱ければ R2 の署名経路投資 (HL-R2 と共有) の優先度を下げる。

---

## 11. 未決事項 (製品判断)

| # | 論点 | 選択肢 | 仮置き |
|---|---|---|---|
| 1 | 独立コントラクト (12:33 案) を将来作るか | 作らない / R3 後に共有 Vault として再検討 | 作らない。既存 ActionType + Plan で体験を先に検証 |
| 2 | Stock Token の売買 (`rotate`) を Seasonals から出すか | display_only 維持 / R2 で解禁 | display_only。地域方針と RFC-002 の後 |
| 3 | `rwa` PositionCategory | 追加 / `other` + metadata | `other` + metadata (§32.2 案件は別起票) |
| 4 | `market_session` marker の粒度 | 1 日 1 件 / セッション毎 | 1 日 1 件 |
| 5 | Trading MCP の接続主体 | BFF が MCP client / 端末が client | 未決。規約確認後 |
| 6 | Phase 番号 | 9.3 / 9.4 / 9.5 | HL 9.0–9.2 の後ろに仮置き |

---

## 付録 A. Solana 側の対応物 (v0.1 の要約、別 backlog)

Seeker が署名できる Solana 上には Robinhood 機能の対応物があり、こちらは EVM 署名経路を待たずに実行まで出せる。v0.1 の採用順を圧縮して残す (詳細設計は本文と衝突しない範囲で v0.1 の記述を踏襲):

| 優先 | Robinhood 側 | Solana 対応物 | Seasonals での姿 | 主な注意 |
|---|---|---|---|---|
| A1 | Stock Tokens / 株式担保 | **xStocks** (Token-2022 Scaled UI Amount、multiplier は Ex date 翌日 00:30 UTC 有効化、`api.xstocks.fi/api/v2/public/assets/{SYMBOL}/multiplier`)、**Kamino xStocks Market** | 保有の正しい表示 (現行 holdings は multiplier 未考慮 → 誤表示の可能性、**守りの修正**)、企業行動 `forecast_marker`、Kamino health は registry 追加だけで自動 | Pyth 株式 feed も休場中 stale → RFC-002 の対象に含める。xStocks も US 不可 |
| A2 | Recurring Investments | **Jupiter Recurring** (time-based DCA) | 次回約定 `forecast_marker`、`ActionType.Cancel` の初の利用先 | API / program の現行状態を実測 (docs 404、廃止記述あり) |
| A3 | Prediction Markets | **Kalshi on Solana (DFlow)** yes/no SPL | close = `maturity`、settled winning = `maturity_redeem` (Exponent PT と同型)。買いは display_only | DFlow の docs index に prediction 節が無く公開状態未確認 |
| A4 | Cash Sweep / Earn | Jupiter Lend `jlUSDG` / Kamino / Save (既存) | idle stablecoin 行に one-tap CTA + 月次 `forecast_marker` | 新 tx なし |
| A5 | Cortex / Agentic | Seasonals MCP Server (既存) | `daily_digest` prompt、`plan_rollover` tool (spec §6.3 未実装分) | — |

既存でカバー済: DRIP (`re_deposit_include_yield`)、Crypto Staking (Jito / Marinade / native stake)、Strategies (`run_autonomous` + Objective)、Perps 露出 (`kamino_jlp`)。見送り: Options / Futures / IRA / Banking / Social / Round-ups。

---

## 参照 (2026-09-19 取得)

Robinhood Chain 公式: [About](https://docs.robinhood.com/chain/) / [Connecting](https://docs.robinhood.com/chain/connecting/) / [Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/) / [Building with Stock Tokens](https://docs.robinhood.com/chain/building-with-stock-tokens/) / [Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/) / [Oracles & Price Feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/) / [Bridging](https://docs.robinhood.com/chain/bridging/)。
Chainlink: [Robinhood Tokenized Equity Feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood)。
Morpho: [API get started](https://docs.morpho.org/tools/offchain/api/get-started/) / [Robinhood chooses Morpho](https://morpho.org/blog/robinhood-chooses-morpho-to-power-new-earn-product) / [Steakhouse USDG vault](https://app.morpho.org/robinhood-chain/vault/0xBeEff033F34C046626B8D0A041844C5d1A5409dd/steakhouse-usdg)。
Robinhood Agentic Trading: [overview](https://robinhood.com/us/en/support/articles/agentic-trading-overview/) / [Open to Agents](https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/) / [2026-07-01 newsroom](https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/)。
Solana 側 (付録 A): [xStocks multipliers](https://docs.xstocks.fi/developers/multipliers) / [Ondo GM on Solana](https://solana.com/news/ondo-global-markets-tokenized-stocks-etfs-solana) / [Kamino xStocks (The Block)](https://www.theblock.co/post/362284/solana-based-decentralized-lending-protocol-kamino-integrates-tokenized-xstocks-as-collateral-option) / [Kalshi on Solana (The Block)](https://www.theblock.co/post/380983/kalshi-tokenizes-thousands-of-its-prediction-markets-using-solana) / [DFlow Prediction API](https://solana.com/news/dflow-prediction-markets-api) / [Jupiter Recurring API](https://dev.jup.ag/docs/recurring-api/)。

**End of robinhood-parity-design.md v0.2**
