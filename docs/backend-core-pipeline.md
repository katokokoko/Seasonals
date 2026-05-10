# Seasonals Backend Core Pipeline

This document defines the backend core for Seasonals: authenticated wallet indexing, protocol-aware position detection, calendar event derivation, and action execution.

The short version:

```text
MWA wallet auth
  -> wallet address
  -> transaction/account ingestion
  -> trusted protocol parser
  -> Position records
  -> deriveTimeEvents
  -> Calendar/Menu UI and MCP resources
  -> simulate/approve/execute actions
```

This is the canonical plan for the feature set that turns Seasonals from a fixture-driven prototype into a real wallet-aware DeFi calendar.

## Goals

Seasonals must read an authenticated Solana wallet and detect meaningful DeFi time events:

- Deposits into supported protocols such as Kamino, Jupiter Lend, Jito, Marinade, Streamflow, Meteora, RateX, and future trusted protocols.
- Withdrawals and position closures.
- Maturity dates, lockup end dates, claim windows, epoch boundaries, vesting cliffs, health alerts, vote deadlines, and forecast markers.
- Deposit history markers so the calendar can show when a position was opened.
- Action entry points from the menu and calendar: `deposit`, `withdraw`, `re_deposit`, `re_deposit_include_yield`, `re_deposit_exclude_yield`, and `rotate`.

The backend must be the source of truth. Mobile renders the calendar and action sheets, but it does not parse raw transactions or infer balances locally.

## Non-Goals

- Seasonals never stores private keys, mnemonics, seed phrases, or signing material.
- Mobile never builds protocol-specific DeFi instructions directly.
- Raw transaction blobs are not the primary query model. They may be retained for debugging, but parsed, normalized records are the data product.
- Unsupported protocols must not be guessed from arbitrary address activity.

## Existing Code Surface

The current repo already contains the skeleton:

- Shared types: `lib/types/position.ts`, `lib/types/unified-time-event.ts`, `lib/types/agent-plan.ts`, `lib/types/approval-token.ts`, `lib/types/enums.ts`.
- Numeric helpers: `lib/utils/numeric.ts`.
- Adapter interfaces: `lib/adapters/types.ts`.
- Mock adapters: `lib/adapters/kamino.ts`, `lib/adapters/jupiter.ts`.
- BFF endpoint skeleton: `artifacts/seasonals-bff/src/server.ts`.
- Mobile API/query layer: `artifacts/seasonals/services/api.ts`, `artifacts/seasonals/services/queries.ts`.
- Calendar/menu/action UI: `artifacts/seasonals/app/index.tsx`, `components/calendar/*`, `components/drawer/MenuDrawer.tsx`, `components/action/ActionModal.tsx`.

What is missing today is the real ingestion and derivation pipeline described below.

## Architecture

### 1. Wallet Identity

Mobile authenticates with Solana Mobile Wallet Adapter and sends only the wallet address to the backend.

Required backend records:

- `wallets`: canonical wallet identity, active status, user binding, device binding metadata.
- `wallet_indexer_cursors`: last indexed signature/slot per wallet and provider.
- `wallet_sync_jobs`: backfill and refresh jobs.

The backend treats wallet address as public identity data. It must not receive or store secrets.

### 2. Trusted Protocol Registry

Every parser and action builder must be registered through a trusted protocol registry. A protocol entry must include:

- `protocol_id`: canonical ID such as `kamino`, `jupiter_lend`, `jito`, `streamflow`.
- `category`: canonical `PositionCategory`.
- `enabled`: whether Seasonals can show and act on it.
- `trust_level`: canonical `TrustLevel`.
- `program_ids`: one or more Solana program IDs per cluster.
- `watched_accounts`: optional vault/reserve/market accounts for account-state indexing.
- `parser_id`: parser implementation key.
- `adapter_id`: action adapter implementation key.
- `supported_actions`: canonical `ActionType[]`.
- `oracle_policy`: optional Pyth/Switchboard threshold overrides.

Protocol matching is fail-closed. If a transaction touches an unknown program ID, it can be stored as raw activity, but it must not become a trusted `Position` or actionable calendar event.

### 3. Ingestion

Use Helius enhanced transactions/webhooks first, with provider-agnostic interfaces so the backend can fall back to RPC or Solscan later.

Required ingestion modes:

- Historical backfill after wallet connection.
- Incremental sync on app open or scheduled refresh.
- Webhook-based near-real-time updates for active wallets.
- Manual repair/backfill by wallet and slot range.

Every ingested transaction must store:

- `signature`
- `slot`
- `block_time`
- `wallet_address`
- `provider`
- `raw_provider_payload` or debug reference
- normalized involved accounts/program IDs
- ingestion timestamp

Writes must be idempotent using `(wallet_address, signature)` or `(signature, parser_id)` uniqueness. Webhooks and retries can duplicate delivery.

### 4. Parsing

Each trusted protocol gets a parser. A parser converts transaction/account state into normalized events.

Parser output should use a narrow internal model:

```ts
type ParsedProtocolEvent =
  | {
      kind: "deposit";
      protocol_id: string;
      wallet_address: string;
      signature: string;
      slot: number;
      occurred_at: string;
      asset_symbol: string;
      amount: string;
      position_key: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "withdraw";
      protocol_id: string;
      wallet_address: string;
      signature: string;
      slot: number;
      occurred_at: string;
      asset_symbol: string;
      amount: string;
      position_key: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "position_state";
      protocol_id: string;
      wallet_address: string;
      observed_at: string;
      asset_symbol: string;
      principal_amount: string;
      current_amount: string;
      accrued_yield_amount: string;
      deposited_at: string;
      maturity_at: string | null;
      unlock_at: string | null;
      health_factor: number | null;
      risk_score: number;
      position_key: string;
      raw_state: Record<string, unknown>;
    };
```

All token amounts are smallest unit strings. Do not use `Number()`, `parseInt`, or `parseFloat` for token amounts.

Parser responsibilities:

- Match known protocol instructions/accounts.
- Determine whether a transaction represents deposit, withdraw, repay, add collateral, claim, rotate, or an ignored operation.
- Normalize protocol-specific account state into `Position`.
- Preserve enough raw metadata to debug parser errors.
- Be deterministic for the same transaction payload.

### 5. Position Projection

`Position` is the query model consumed by Mobile, MCP, and action planning.

Position projection rules:

- A deposit creates or updates a position.
- A withdraw reduces `current_amount`; a full withdrawal closes or archives the position.
- `deposited_at` is the first known deposit time for the active position lineage.
- `maturity_at` is protocol state when known, otherwise `null`.
- `unlock_at` is protocol state when known, otherwise `null`.
- `health_factor` is only set for borrow/collateral protocols.
- `raw_state` keeps parser-specific debug state.

Position IDs must be stable across syncs. Prefer deterministic IDs derived from wallet, protocol, asset, and protocol position account where possible.

### 6. Calendar Event Derivation

`deriveTimeEvents` converts indexed positions and protocol state into `UnifiedTimeEvent[]`.

Required derivations:

- `deposit_history`: view-layer marker for `Position.deposited_at`. It is not a `TimeEventCategory`, but the calendar marker exists and should be rendered from position history.
- `maturity`: if `Position.maturity_at` is non-null.
- `lockup_end`: if `Position.unlock_at` is non-null and differs from maturity.
- `health`: if `health_factor` is near liquidation or below configured thresholds.
- `claim`: if parser/protocol state exposes claimable rewards or a claim window.
- `epoch`: for staking/restaking protocols with epoch boundaries.
- `vesting_cliff`: for vesting protocols such as Streamflow.
- `vote_deadline`: for governance positions/proposals.
- `forecast_marker`: optional UI-only projections, usually `agentReadable = false`.

Event actions must come from canonical `ActionType` values:

- Maturity: `withdraw`, `re_deposit`, `re_deposit_include_yield`, `re_deposit_exclude_yield`, `rotate`.
- Lockup end: `withdraw`, `rotate`.
- Deposit history: generally read-only, but may offer `deposit` again for the same protocol/asset from the day detail view.
- Health: `repay`, `add_collateral`, `withdraw` only when safe.
- Claim: `claim`.

The event must include `positionRef` whenever it came from a position. Agent-readable events must be safe for MCP exposure.

### 7. Menu and Calendar Action Entry Points

Menu and calendar flows use the same backend action pipeline.

Menu flow:

```text
Menu protocol card
  -> choose action: deposit / re_deposit / withdraw / rotate
  -> create or select AgentPlan
  -> simulate
  -> approve
  -> sign with MWA
  -> broadcast
```

Calendar flow:

```text
Calendar marker/day detail
  -> UnifiedTimeEvent.actions
  -> create or select AgentPlan tied to positionRef
  -> simulate
  -> approve
  -> sign with MWA
  -> broadcast
```

The action modal must not infer an arbitrary fallback plan when action/protocol/position cannot be resolved. It should fail closed with an explicit error.

### 8. Action Execution

Adapters build protocol-specific actions. The backend owns instruction construction.

Required methods per action-capable adapter:

- `fetchPositions(ctx)`
- `fetchReserves(ctx)` or equivalent opportunity discovery
- `simulate(ctx, actionSpec)`
- `buildTransaction(ctx, actionSpec | quote)`

Execution flow:

1. Validate `ActionSpec` with shared canonical enums.
2. Validate user policy and objective constraints.
3. Validate amount strings with `assertTokenAmount` or `assertUsdAmount`.
4. Simulate using protocol adapter.
5. Fetch oracle prices using Pyth primary and Switchboard fallback.
6. Build `bundle_hash`.
7. Issue `ApprovalToken` if user approval is required.
8. On approve, verify token, bundle hash, policy, oracle freshness/divergence, and plan status.
9. Build unsigned transaction.
10. Mobile signs through MWA.
11. Backend or wallet broadcasts depending on execution mode.
12. Update AgentPlan status and index the resulting transaction.

For MVP, Mobile may broadcast with MWA `signAndSendTransactions`, but the backend must still record the expected execution job and later reconcile by signature.

### 9. Rotate

`rotate` means moving value from one supported protocol to another. It is a multi-step operation and must be modeled explicitly.

Common route:

```text
withdraw source position
  -> optional swap route through Jupiter
  -> deposit into destination protocol
```

Rotate simulation must include:

- source protocol and position
- destination protocol/reserve
- withdraw estimate
- Jupiter quote if asset conversion is needed
- destination deposit estimate
- total fees
- slippage
- oracle status
- all warnings

Rotate execution must be atomic where possible. If atomic execution is not possible, the plan must expose partial-fill / partial-execution risk and require explicit user approval.

### 10. Storage Model

Minimum backend tables or repositories:

- `wallets`
- `trusted_protocols`
- `protocol_program_ids`
- `wallet_indexer_cursors`
- `raw_transactions`
- `parsed_protocol_events`
- `positions`
- `position_history`
- `unified_time_events` or derived materialized view
- `agent_plans`
- `approval_tokens`
- `execution_jobs`
- `mcp_audit_logs`
- `push_tokens`
- `oracle_observations`

Use Postgres for durable state. Use Redis for approval token hot lookup, idempotency windows, and short-lived job locks.

### 11. API Surface

The BFF should expose these wallet-aware endpoints:

- `GET /wallets`
- `POST /wallets/:walletId/sync`
- `GET /wallets/:walletId/sync-status`
- `GET /positions?wallet_id=...`
- `GET /time-events?wallet_id=...&from=...&to=...`
- `GET /protocols`
- `GET /protocols/:protocolId/reserves`
- `POST /agent-plans`
- `GET /agent-plans/:planId`
- `POST /agent-plans/:planId/simulate`
- `POST /agent-plans/:planId/request-approval`
- `POST /agent-plans/:planId/approve`
- `POST /agent-plans/:planId/reject`
- `POST /actions/:executionJobId/signature`

MCP Server should expose the same source of truth as resources/tools, not a separate model.

### 12. Safety Requirements

Safety rules are mandatory:

- Unknown protocol activity is not actionable.
- Unknown parser output does not create a trusted position.
- Oracle failure is fail-closed for execution.
- Dual stale oracle rejects simulate and execute.
- Oracle divergence over 5% rejects execute.
- Bundle hash mismatch rejects execute.
- Expired or consumed approval token rejects execute.
- `approval_mode = manual_only` rejects Agent-initiated execution.
- `max_tx_amount`, `max_daily_executions`, `max_lock_days`, `min_tvl`, and `min_risk_score` are enforced before transaction build.
- All financial amounts remain strings at API boundaries and bigint/decimal internally.

### 13. MVP Milestones

1. Add trusted protocol registry metadata for Kamino and Jupiter Lend.
2. Implement wallet historical sync using Helius enhanced transactions.
3. Implement idempotent raw transaction storage and cursor tracking.
4. Implement Kamino parser for deposit/withdraw/position state.
5. Implement `deriveTimeEvents` from `Position[]`.
6. Connect `/positions` and `/time-events` to derived backend data instead of fixtures.
7. Add deposit history markers to the calendar from `Position.deposited_at`.
8. Implement real Kamino deposit/withdraw transaction build.
9. Implement Jupiter quote and swap transaction build for rotate.
10. Implement approval token issue/verify/consume.
11. Add oracle service and fail-closed checks.
12. Add reconciliation after signed transaction broadcast.

### 14. Acceptance Criteria

The core feature is complete when:

- Connecting a wallet starts a backfill.
- A real supported protocol deposit appears as a `Position`.
- Deposit date appears on the calendar.
- A maturity or lockup date appears on the calendar when protocol state exposes one.
- The menu can filter currently deposited protocols based on indexed positions.
- A calendar event action opens the correct plan without fallback guessing.
- `deposit`, `withdraw`, `re_deposit`, and `rotate` can be simulated.
- At least one protocol can build and sign a real transaction through MWA on devnet or mainnet with a test wallet.
- Execution is rejected on stale oracle, large oracle divergence, invalid amount, policy violation, approval token replay, or bundle hash mismatch.

