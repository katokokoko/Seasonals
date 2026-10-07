# @seasonals/mcp-server

Seasonals MCP Server (Phase 8.28) — **"Humans read the calendar. Agents read
the API. Same source of truth."** の第 3 の柱。

## 使い方

```bash
# BFF を起動しておく (別ターミナル)
pnpm --filter @seasonals/bff start

# stdio で MCP server を起動 (Claude Code / Desktop は repo root の .mcp.json 経由)
pnpm --filter @seasonals/mcp-server start
```

接続先は `BFF_URL` env (default `http://localhost:3030`)。

## Surface (spec §6.3 / §24.9)

**Tools**: `compare_opportunities` (live menu をランクし draft AgentPlan 作成) →
`simulate_action` (selected_action 確定 + 決定的 bundle_hash) →
`request_user_approval` (承認依頼 → long-poll)。人は **Seasonals web の Agent
ページで approve → 自分の wallet で署名 → 送信** まで一気に行い (承認 = 実行)、
tool は終端 (`broadcasted` + signatures / `failed` + failure_reason / `rejected` /
`expired`) を返す。policy の自動承認 (`approved_by: "auto"`) の plan だけは
approval_token を返し、`execute_approved_action` で unsigned tx を受け取る。人が承認した
plan に `execute_approved_action` を呼ぶと `{status:"awaiting_user_signature"}` が返る
(**Agent は署名に一切触れない**、§6.5)。

### action_spec の組み方 (2026-10-08)

実行できるのは **deposit と withdraw だけ** (lib の `resolveSolanaRoute`、Seeker / web / execute と同じ 13 route)。
それ以外の action_type は simulate が `status: "failed"` / `failure_reason: "unsupported_market"` を返し、
`request_user_approval` は `{status: "simulation_failed"}` になる (BFF の request-approval / approve が 422)。

- **deposit**: `compare_opportunities` の候補 (route の解決する pool だけが出る) の `action_spec_template`
  (`{action_type, protocol, asset, metadata: {pool_id}}`) に `wallet_id` と `amount` を足して `simulate_action` へ。
  `amount` は候補の `amount_unit` の smallest unit (`amount_decimals` 桁。1.5 USDC = `"1500000"`)
- **withdraw**: resource `seasonals://positions/{wallet}` の position から
  `{action_type: "withdraw", protocol: protocol_id, asset: asset_symbol, amount: shares,
  metadata: {share_mint, share_decimals, underlying_decimals, underlying_amount}}`
  (lib `withdrawActionFromPosition` と同じ形)。部分 withdraw は amount を減らす
- `metadata` は上の 5 キーだけ (zod strict + BFF `validateActionMetadata`。未知キー / base58 でない
  share_mint / 形式外の pool_id は拒否)。BFF は metadata ごと bundle_hash を取るので、承認後に変えると token は無効

`simulate_action` の出力: `status` (`ok` | `failed`)、`estimate_kind` (`quote` = Jupiter quote /
`exchange_rate` = kVault・Save の交換レート / `same_as_input` = Kamino reserve / `lp_position` = Meteora・Orca /
`pt_redeem` = Exponent / `none`)、`estimated_out` + `estimated_out_symbol` / `_decimals` / `_mint` (**受け取る token
の単位**。jlUSDC、"Steakhouse USDC shares" 等)、`min_out` (quote のみ)、`slippage_bps`、`warnings`
(`fair_value_deviation` / `fair_value_unavailable` / `deposit_unavailable`)、`oracle_warnings`、`failure_reason`
(`unsupported_market` / `asset_mismatch` / `amount_required` / `quote_unavailable` / `rate_unavailable`)、
`bundle_hash`。fee は出さない (署名前に正直な値が無い)。

**Resources**: `seasonals://protocols` / `seasonals://positions/{wallet}` /
`seasonals://events/{wallet}` (agentReadable のみ) / `seasonals://policy/default`

**Prompts**: `max_yield_search` / `safety_first_rollover`

## Phase 8.29: 自律実行 (`run_autonomous`)

`run_autonomous(objective, asset?, dry_run=true)` — 1 サイクルで **live mainnet
menu から決定 → user policy + ハード上限で検査 → (devnet 限定・bounded 委任署名)
人のタップなしで署名+broadcast**。`dry_run` はデフォルト true (誤爆防止)。

### 逸脱 / ガードレール (v1)
- **署名は BFF の bounded 委任 keypair** (= devnet の自律サブアカウント、少額
  pre-fund)。**Agent は鍵を持たない**不変条件は保持 (鍵は BFF のみ、§32.2)。
  §6.5「制限付き委任アカウント」/ §18 Phase 3 の devnet スライス
- **devnet 限定ハードガード**: `SOLANA_RPC_URL` が devnet でなければ実行拒否
- **feature flag OFF デフォルト**: `FEATURE_APPROVAL_MODE_AUTO=true` で初めて有効
  (§11.6 / §29.3「auto は flag 無効」)
- **ハード上限は policy と独立**: `AUTONOMOUS_MAX_TX_USD8=$20` / `MAX_DAILY=5` /
  `MAX_LAMPORTS=0.0001 SOL` — policy が無制限でも超えられない
- **kill switch**: `POST /autonomous/kill` で即時全停止
- **決定/実行の分離**: 決定は実 mainnet menu、実行 tx は devnet の bounded SOL
  transfer + memo (Jupiter は devnet 不可のため。mainnet 実 DeFi は監査後)
- **監査 + 通知**: `GET /autonomous/log` (web-ready)、非 dry_run 後に「資金が
  動いた」push (`type:"execution"`)

### 起動 (devnet)
```bash
FEATURE_APPROVAL_MODE_AUTO=true \
AUTONOMOUS_DELEGATE_SECRET="$(cat delegate.json)" \
SOLANA_RPC_URL="https://api.devnet.solana.com" \
pnpm --filter @seasonals/bff start
# 任意: AUTONOMOUS_LOOP_MS=60000 で scheduler、AUTONOMOUS_RECIPIENT で送金先
```

## v1 の逸脱 (仕様との差分)

- §12.3 の「共有 core service」直結ではなく **BFF REST を表現層として共有**
  (mobile と同一 endpoint = same source of truth は成立)
- plan / approval_token は BFF の `.data/agent-plans.json` に保存 (§17/§25 の
  Redis+Postgres は後続)。plan は作成から 24h で `expired`
- **client 認証なし** — `GET /agent-plans/:id/approval` は plan_id を知る者に状態を
  返す。token は policy の自動承認 plan の時だけ含める (人の承認分は出さない)。
  ローカル dev 前提、v2 で MCP client 承認 §8.6 と連動
- 監査は stderr 構造化ログ (`mcp_audit`)。ClickHouse `mcp_audit_logs` (§25.3)
  は後続
- execute は lib の `resolveSolanaRoute` (Seeker / web と同じ 13 route) で解決し、
  人と同じ `/protocols/*` の tx builder で組む (解決できない market は 422
  `unsupported_market`)。Seeker 上での署名は後続 (承認までは Seeker でもできる)

## Ethereum tools (web / ETHGlobal track)

BFF の `/eth/*` を読む。UI (web) と同じ endpoint = same source of truth。

| tool | 何をするか |
|---|---|
| `list_events` / `get_proposal` / `build_action` | 期日イベント (Pendle PT 満期 / Ethena cooldown / Lido withdrawal / CCA / Aqua review) と、その対応の未署名プラン |
| `ship_lp_strategy` | 1inch Aqua PEGGED_STABLE (USDC/USDe) の未署名 ship plan (Chainlink peg guard) |
| `list_yield_menu` / `get_holdings` | Menu の利回り (Lido / Ethena / Pendle PT・YT) と address の保有・spendable、fork の到達性 |
| `preview_rebalance_step` | 1 step の未署名プラン (swap は `amountOut` を返す → 次 step の金額決め) |
| `propose_rebalance` | 最大 6 step (menu deposit / withdraw、USDC ⇄ USDe swap、event action、**1inch Aqua LP ship**) の **提案** を BFF に保存。全 step を組んで guard を通し、`bundleHash` と **Strategy Brief** (`brief`) を付ける。`dryRun: true` なら保存せず brief だけ返す (練り直し用) |
| prompt `design_rebalance` | `{address, goal?}`。holdings → menu → preview → `dryRun` → 提出 → `brief.markdown` をそのまま提示 → web / chat で承認依頼、という手順を英語で教える |

### Strategy Brief (`brief`)

LLM が組んだ戦略を人が読める形にする。**数字は BFF が実データから決定的に組む** (holdings の on-chain 残高 + menu の利回り + 各 step の preview)。LLM が書くのは `name` (絵文字 + 短い英語名、≤ 40 文字)、`tagline`、`rationale` だけ。

- `before` / `after`: line ごとの量・USD・share・APY。after は step の効果 (builder が返す `effects`) を順に適用した結果
- `blendedApy`: USD 加重平均を 2 つ。`moved` = **この提案が動かす資金** (減る側の APY → 増える側の APY、見出し)、`deployed` = **DeFi で運用中の資金だけ** (Lido / Ethena / Pendle / Aqua) の before → after。**wallet の idle 資産はどちらの分母にも入れない** (巨大な idle 残高で効果が埋もれないように)。APY 不明 (Aqua LP など) は 0 扱いで `excluded` に列挙 (数字を膨らませない)。価格の無い line は `unpriced` に列挙し総額・APY から除外
- 表 (Markdown / web) は量の変わる line だけ。変わらない line は "Unchanged: … (N positions, $X)" の 1 行にまとめる
- `aqua`: LP sleeve の中身と peg guard、`horizon`: PT 満期 / Aqua review / cooldown 終了 / Lido queue
- `markdown`: 英語の Markdown (Claude はこれをそのまま見せる)。web の Agent ページも同じ brief を表で描く
| `wait_for_rebalance_decision` | 人が web の Agent ページで承認 (= fork 実行) / 却下するまで long-poll |
| `execute_rebalance` | chat で人が明示的に yes と言った後、`bundleHash` 付きで fork 実行 (`user_confirmed: true` 必須) |

不変条件: Agent は署名しない / mainnet 送信経路なし / 実行は Anvil fork のみ / 表示した `bundleHash` と違う内容は BFF が拒否 / peg・TWAP・残高 guard は fail-closed。
step は symbol + 人が読む decimal (`{kind:"uniswap_swap", tokenIn:"USDC", tokenOut:"USDe", amount:"100"}`) で書き、address / smallest unit への変換は BFF だけが行う。
承認の 2 経路 (web のワンタップ / chat の yes) はどちらも同じ `POST /eth/agent-proposals/:id/execute` に収束し、web の Agent ページには chat 承認分も同じ状態で出る。

## v2 backlog

plan_rollover / prompts 残 3 種 / HTTP+SSE transport / rate limit (§15.4) /
policy engine 連携 (`approval_mode=manual_only` 拒否等) / ClickHouse 監査 /
Redis+Postgres 永続化 / Seeker での agent plan 署名
