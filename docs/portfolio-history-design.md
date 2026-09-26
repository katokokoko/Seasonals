# Portfolio history — 評価額履歴の設計と新チェーン追加の手順

Seeker の資産推移グラフ (Phase 8.56〜8.95) と web Dashboard の Portfolio が共有する
「過去の評価額をどう作るか」の canonical な説明。経緯は長く code comment にしか
無かったので、ここにまとめる。**新しいチェーンを足す時はまず §4 のチェックリスト**。

関連: `lib/types/portfolio.ts` (wire 型) / `lib/derive/portfolio.ts` (client 側の合算・表示 helper)
/ `artifacts/seasonals-bff/src/portfolio-history.ts` (純関数 core) / `.../portfolio/engine.ts` (engine)

---

## 1. 復元モデル

端末スナップショット (8.56) は「今日から」しか貯まらない。代わりに **現在残高から
tx の差分を遡って** 各時刻の残高を作り、**その時刻の実価格**で値付けする (8.58)。

```
balance(t) = current − Σ(t より後に起きた差分)          … replayBalances
value(t)   = Σ_asset balance_asset(t) × price_asset(t)  … buildHistorySeries
```

- 残高は bigint (smallest unit)、価格は USD 8-dec string。float を通さない (CLAUDE.md §3)
- tx window の外まで遡ると負になり得るので 0 に丸める (それ以前に持っていたことは証明できない)
- **描画の下限** = max(取得できた最古の tx, 要求 range の先頭, 最初に資産を持った時刻) (8.59/8.60)。
  途中のゼロ期間 (全額引き出し → 再入金) は事実として 0 の点を描く
- 刻みは「実際に描ける期間 ÷ 目標点数 (90)」を nice step に丸め、epoch 倍数に整列 (8.59)。
  同じ引数なら同じ時刻列 = 過去価格 cache が効く
- 末尾は now − 120s (価格 API が現在時刻ちょうどだと 404、8.58 実測)

### flow 分解 (8.65)

```
value(i) − value(i−1) = Σ(a_i − a_{i−1})·p_i   +   Σ a_{i−1}·(p_i − p_{i−1})
                        └── flow (入出金) ──┘       └──── 価格変動・利回り ────┘
```

入金の段差を「儲け」に見せないため、各点に `flow_usd` を持たせる。client は
marker を打ち (`flowMarkerIndices`)、見出しの増減は flow を除いて出す (`historyChangeExFlows`)。

### 近似は隠さず明示する

| 状況 | 扱い | 応答 |
|---|---|---|
| その時刻の実価格が無い asset | 現在価格で固定 | `approximated_symbols` |
| 残高が Transfer 無しで増える (rebase: stETH 等) | 逆算した過去残高がやや過大 | `approximated_symbols` |
| 現在値しか取れないもの (Aave V4 の supply 等) | 履歴に入れない、holdings にだけ載せる | `excluded_from_history` / `in_history: false` |
| 上流が落ちた | **503** (空の 200 を返さない、8.95) | client は合算から外し理由を表示 |

---

## 2. 構成

```
          ┌──────────────── ChainHistorySource (chain ごと) ────────────────┐
          │ loadInputs(address, days) → current / assets / deltas /           │
          │                              oldestSeen / complete / extras       │
          │ priceSeries(assets, from, to, step) → Map<assetKey, PriceSeries>  │
          └───────────────────────────────┬──────────────────────────────────┘
                                          ▼
portfolio/engine.ts   createHistoryEngine(source)
  - 入力 cache (address 単位、range をまたいで共有) + in-flight の 1 本化
  - 応答 cache 5 分 + stale-while-revalidate (8.83)
  - firstFundedTime → sampleTimestamps → replayBalances → 価格 → buildHistorySeries
  - history(address, days) / holdings(address) — **同じ入力**から作るので
    グラフ右端とパイ合計が揃う
                                          ▼
routes   Solana: GET /portfolio/history, /portfolio/holdings  (sol alias 付き、mobile 互換)
         Ethereum: GET /eth/portfolio/history, /eth/portfolio/holdings
                                          ▼
lib/derive/portfolio.ts   mergeHistorySeries (複数 address を USD 合算)、
                          allocationByCategory、historyChangeExFlows、chartAreaState …
```

### 複数 address の合算 (`mergeHistorySeries`)

系列ごとに刻みも末尾時刻も違う。格子 = 最も古くから描けている系列 (同着なら粗い方)、
他系列は carry-forward、flow はその区間の合計。**開始前の扱いが要点**:

- `starts_at_funding: true` (最初に資産を持った時刻で始まり、かつ差分を取り切れている)
  → それ以前は **ゼロと確定**。0 として足し、現れた点の評価額を入金 flow に数える
- それ以外 → それ以前は **不明**。合算をその系列の先頭から始める (不明を 0 と見なして
  合計を低く描かない)

---

## 3. chain 別メモ

### Solana (8.58〜)

| 項目 | 出所 |
|---|---|
| 現在残高 | Helius DAS `getAssetsByOwner` (native SOL は WSOL mint の synthetic entry) |
| 差分 | Helius enhanced tx (`nativeBalanceChange` は fee 込み、`tokenBalanceChanges`)、100 件 × 最大 10 page |
| 現在価格 | DAS `price_per_token`、jlToken は protocol の交換レート (8.70)、native SOL は oracle |
| 過去価格 | Pyth Benchmarks (feed がある symbol) + DeFiLlama `solana:<mint>` (8.64)、DAS 価格に anchor |
| category | `KNOWN_PROTOCOL_MINTS` → `fixtureProtocols`、無ければ `wallet_stable` / `wallet_sol` (/positions と同じ規則) |

既知の限界: 今は保有していない token は `assets` に入らないので、過去にだけ持っていた
token の評価額は線に乗らない (DAS が現在保有しか返さないため)。

### Ethereum (web Dashboard 追加時)

| 項目 | 出所 |
|---|---|
| 対象 asset | `lib/config/eth-assets.ts` の registry + wallet に出入りした Pendle PT のみ (spam token を数えない) |
| 現在残高 | RPC (Infura): `getBalance` + `balanceOf` multicall |
| 差分 | **Etherscan API V2** `txlist` / `txlistinternal` / `tokentx` (1000 件 × 最大 5 page / action)。env `ETHERSCAN_API_KEY` |
| native の厳密さ | 送信 tx は **失敗しても gas (`gasUsed × gasPrice`) を引く**。contract からの ETH (Lido claim 等) は internal tx で拾う |
| 現在価格 | Chainlink Feed Registry (ETH / USDC / USDe / stETH、stale は使わない) → DeFiLlama current |
| 過去価格 | DeFiLlama `ethereum:<address>`、native は `coingecko:ethereum`。現在価格に anchor |
| 近似 | stETH (rebase) は approximated。Aave V4 は `excluded_from_history` |

Etherscan を選んだ理由: Infura の `eth_getLogs` は 10k block 制限で 1 年分に数百 call、
しかも ERC-20 Transfer しか取れず native ETH / gas / internal tx が抜ける。Alchemy の
`getAssetTransfers` は gas を含まず native の逆算がずれる。

既知の限界: beacon chain の validator withdrawal (Etherscan の別 action) は未対応、
Aave V3 の aToken など registry 外の rebase token は数えない。

---

## 4. 新チェーン追加チェックリスト

1. **asset registry** を `lib/config/<chain>-assets.ts` に作る (key / symbol / decimals /
   protocolId / `PositionCategory` / deposited / rebasing)。spam を数えないため registry 外は無視
2. **ChainHistorySource** を実装する (`artifacts/seasonals-bff/src/<chain>/history.ts`)
   - `loadInputs`: 現在残高と **符号付き差分 (fee / gas 込み)** を bigint で。page 上限で
     打ち切ったら `complete: false`
   - `priceSeries`: 1 リクエストで全 asset の系列 (点ごとに取ると rate limit に落ちる、8.59)。
     右端は `anchorSeries` で現在価格に揃える
   - 差分を取れないもの (現在値だけの position) は `extraHoldings` + `excludedFromHistory`
3. `createHistoryEngine(source)` を作り、route を足す (失敗は 503、key 未設定は専用 code)
4. `lib/config/chains.ts` の `ChainId` に追加し、web の `api.portfolioHistory` /
   `portfolioHoldings` で endpoint を振り分ける
5. テスト: 差分変換の純関数 (受取 / 送信 / 失敗 tx の fee / 自己送金 / spam 除外)、
   indexer client (paging / 取り切り判定 / key を漏らさない)、route の 400 / 503

EVM L2 (Base / Arbitrum / Optimism) は Etherscan V2 の `chainid` と RPC を差し替えれば
ほぼそのまま動く (registry と Chainlink feed は chain ごとに別)。L2 の gas は L1 data fee が
加わる chain があるので、`txlist` の値で足りるかを実測してから使う。

Hyperliquid は `docs/hyperliquid-integration-design.md` の R0 方針 (totals / time series /
allocation から隔離し「対象外」と表示) を優先する。取り込む場合も perp の未実現損益は
残高差分ではないので、この復元モデル (残高 × 価格) にそのままは乗らない。
