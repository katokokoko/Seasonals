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
`request_user_approval` (mobile へ push → long-poll、承認で single-use
approval_token) → `execute_approved_action` (unsigned tx を返す — **Agent は
署名に一切触れない**、§6.5)。

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
- plan / approval_token は BFF の **in-memory store** (§17/§25 の Redis+Postgres
  は後続)。プロセス再起動で消える
- **client 認証なし** — `GET /agent-plans/:id/approval` は plan_id を知る者に
  token を返す (ローカル dev 前提。v2 で MCP client 承認 §8.6 と連動)
- 監査は stderr 構造化ログ (`mcp_audit`)。ClickHouse `mcp_audit_logs` (§25.3)
  は後続
- `execute_approved_action` v1 は **swap-earn の deposit/withdraw のみ** tx 構築
  (他 protocol は `unsupported_action_v1`)。mobile への tx push も後続 (§24.10)

## v2 backlog

plan_rollover / prompts 残 3 種 / HTTP+SSE transport / rate limit (§15.4) /
policy engine 連携 (`approval_mode=manual_only` 拒否等) / ClickHouse 監査 /
Redis+Postgres 永続化 / execute の全 protocol 対応 + mobile tx push
