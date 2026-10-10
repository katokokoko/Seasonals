# Seasonals

**DeFi, on a calendar.** Seasonals turns time-sensitive DeFi state (maturities, cooldowns, withdrawal queues, auction blocks) into one calendar that people can read and an agent can query. *Humans read the calendar. Agents read the API. Same source of truth.*

This monorepo has four parts:
- the Solana Seeker app (Expo) — see [`docs/mobile-runbook.md`](docs/mobile-runbook.md)
- a BFF (Fastify)
- an MCP Server
- a **desktop Web app with an Ethereum time layer**, added during ETHGlobal Tokyo 2026 (branch `ethglobal-tokyo-web`)

> **ETHGlobal disclosure.** The Ethereum work reuses the existing Seasonals Solana monorepo: the shared `lib/` types, numeric helpers and design tokens, plus the BFF and MCP Server. It was built as an extension of that codebase. We do not claim eligibility as a from-scratch project. The work log (`docs/web/WORKLOG.md`) lists what was added during the event, with commit hashes.

## What the Ethereum time layer does

| Protocol | Time event (real mainnet data) | Action | Verified |
|---|---|---|---|
| Pendle | PT maturity: public market maturities, and per-address PT positions (a matured, unredeemed PT becomes **overdue**) | Redeem via Pendle Hosted SDK Convert | Plan checked with `eth_call` on mainnet. Executed on an Anvil fork. |
| Ethena | sUSDe cooldown end. `cooldownDuration()` is read live, never assumed to be 7 days. | `unstake` | Executed on the fork after advancing fork time past a real cooldown. |
| Lido | Withdrawal queue: pending (no ETA), or finalized and claimable | `claimWithdrawal` | `eth_call` on mainnet, then executed on the fork (`isClaimed=true`). |
| Uniswap CCA | Auction start / end / claim; per-bid exit, claim and refund | `exitBid` / `claimTokens` | A real refund `exitBid` checked on mainnet and executed on the fork. |
| 1inch Aqua + SwapVM | Strategy review date, set when a strategy ships (a "your plan" event) | Ship a PEGGED_STABLE USDC/USDe strategy (SwapVM `AquaPeggedAmmStrategy` + fee + salt) behind the peg guard. Dock it from the review event. | On the fork: ship → one fill by a real USDC-holding EOA (10 USDC → 9.9886 USDe) → review event on the calendar → dock. |
| Aave V4 (context only) | None. Aave has no dated events (v3), so it never appears on the calendar. | Read only: Hub/Spoke positions, supplied / debt, health factor, net APY on the Dashboard | Real AaveKit (`api.aave.com`) data for a V4 Bluechip-spoke user. |
| Uniswap Trading API | Route USDC → USDe before an Ethena deposit | `/check_approval` → `/quote` → `/swap` behind a fail-closed Chainlink USDe/USDC peg guard | Real API responses. Swap executed on a fresh fork: approve → Permit2 transaction → swap, all receipts success. |

Every calendar entry belongs to one of three classes, kept visually and type-separate (`lib/types/timeline.ts`):
- **protocol event**: derived from chain or protocol data
- **your plan**: created by the user or an agent on their behalf
- **executed**: written only after a transaction receipt is observed

Rules the code enforces:
- **No sample data.** Without a wallet, the app shows only public events. Unknown prices are left blank, never shown as 0.
- **Unsigned plans only.**
  - Calldata comes from protocol ABIs or Pendle Convert, never from an AI.
  - The server re-checks on-chain state before building a plan and runs `eth_call` to confirm it would succeed.
  - `broadcast: false` is fixed.
- **Execution runs only on a local Anvil fork**, and only after the user presses an explicit button. The owner is impersonated. There is no code path that sends to mainnet.
- **Secrets stay on the server.** RPC and API keys live only in `artifacts/seasonals-bff/.env`. `scripts/check-no-secrets.sh` checks staged diffs, the web build and screenshots for leaked keys.

## Run it locally

Requirements: Node 20+ (`.nvmrc` pins 24, the Docker image uses 24, development machines run 25), pnpm 10.33.4, and optionally Foundry for the fork demo. For the Seeker app add JDK 17 and the Android SDK (see the mobile runbook).

```bash
pnpm install

# 1. BFF — needs artifacts/seasonals-bff/.env (see below)
pnpm --filter @seasonals/bff dev          # http://127.0.0.1:3030

# 2. Web (desktop) — proxies /api → BFF
pnpm --filter @seasonals/web dev          # http://localhost:5173

# 3. Optional: Anvil mainnet fork for the execution demo
bash scripts/eth-fork.sh                  # 127.0.0.1:8545 (key never on argv or in logs)
#    Restart the fork after using fork time travel (/eth/fork/advance). Uniswap swaps
#    revert with TransactionDeadlinePassed on a fork whose clock runs ahead of real time.

# 4. Optional: MCP client (e.g. Claude Desktop) — see .mcp.json
npx tsx artifacts/seasonals-mcp-server/src/index.ts
```

Environment variables (server side only, `artifacts/seasonals-bff/.env`; names and comments are in `.env.example`). Clients never see any key: the mobile app, the web app and the MCP Server only know the BFF URL.

| Variable | Needed for |
|---|---|
| `HELIUS_API_KEY` | All Solana mainnet reads (positions, time events, tx history) and `/tx/submit`. Without it the fixture variant still works. |
| `SOLANA_RPC_URL` | Devnet guard for the (off by default) autonomous loop. Leave on devnet. |
| `SEASONALS_DATA_DIR` | JSON persistence for plans / approval tokens / policy. Default `.data`; `/data` (volume) on Fly. |
| `INFURA_API_KEY` (or `ETHEREUM_RPC_URL`) | All Ethereum reads |
| `ETHERSCAN_API_KEY` | Ethereum tx deltas and CCA bid scan logs |
| `UNISWAP_API_KEY` | Trading API quotes |
| `ETH_EXECUTION_TARGET` | `fork` (default). `mainnet` refuses to execute and returns plans only. |
| `ETH_FORK_RPC_URL` | Anvil endpoint. Default `http://127.0.0.1:8545`. |
| `ANTHROPIC_API_KEY` | Optional. Without it, proposals are rule-based. |

Public deployment only (`docs/external-release-api-handling.md`): `SOLANA_EXECUTION_TARGET` (`mainnet` default, `disabled` = plans only), `CORS_ALLOWED_ORIGINS`, `RATE_LIMIT_MAX`, `ADMIN_TOKEN`, `BFF_PROXY_SECRET`, `EXPO_PUSH_ENABLED`, `GIT_SHA`. **Never set on a public BFF**: `AUTONOMOUS_DELEGATE_SECRET`, `FEATURE_APPROVAL_MODE_AUTO=true`, `AUTONOMOUS_LOOP_MS` — with `NODE_ENV=production` the server refuses to start.

The web app has no secret environment variables. It only uses `BFF_URL` in the Vite dev proxy.

### Try it with real addresses

In the web app, open **Connect wallet → Watch an address** and add any of these public mainnet addresses (found with `artifacts/seasonals-bff/scripts/find-eth-demo-addresses.mjs`):

| Address | Shows |
|---|---|
| `0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11` | Many matured, unredeemed Pendle PTs (overdue → Redeem) |
| `0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5` | A claimable Lido withdrawal |
| `0x1B7a4C3797236A1C37f8741c0Be35c2c72736fFf` | Pending Lido withdrawals |
| `0xA7a71E78128F6e3f6dB404ec47806E472F280ef8` | An Ethena cooldown and a Pendle PT |
| `0x840b0Dea6E596e1a4DebF7F5BfD39086e01651b5` | Uniswap CCA bids |

State changes over time, so these addresses may not show the same events later.

## Solana / Seeker app

The Seeker app is the base client: a calendar of Solana time events (Kamino, Jito, Exponent, Orca, Meteora, Save, Jupiter Lend, SKR staking cooldowns) with one-tap simulate → approve → execute, signing through Mobile Wallet Adapter (Seed Vault, Phantom or Solflare). Seasonals never holds a private key.

```bash
# BFF with HELIUS_API_KEY in artifacts/seasonals-bff/.env
pnpm --filter @seasonals/bff dev                                   # :3030

# first time: debug APK with the dev client on a USB-connected device
pnpm --filter @seasonals/mobile android:onchain

# Metro — APP_VARIANT=onchain is required (without it the app runs in devnet/fixture mode)
cd artifacts/seasonals && APP_VARIANT=onchain EXPO_PUBLIC_USE_ONCHAIN=true pnpm exec expo start --dev-client --port 8081
adb reverse tcp:3030 tcp:3030 && adb reverse tcp:8081 tcp:8081   # or: pnpm dev:device
```

- Two variants: `Seasonals` (`app.seasonals.mobile`, fixture data, no key needed) and `Seasonals (onchain)` (`app.seasonals.onchain`, real mainnet positions).
- Shareable release APKs are built on EAS with the `preview-onchain` / `production-onchain` profiles and talk to `https://api.seasonals.cafe`. The signing key is EAS-managed. Full steps, the assetlinks update after the first build and adb QA tips: [`docs/mobile-runbook.md`](docs/mobile-runbook.md).
- Public hosting: web at `https://seasonals.cafe` (Cloudflare Pages; `/api/*` is proxied to the BFF by a Pages Function), BFF at `https://api.seasonals.cafe` (Fly.io). Operator steps and the key-handling policy: [`docs/external-release-api-handling.md`](docs/external-release-api-handling.md).
- MCP against the public BFF: set `"BFF_URL": "https://api.seasonals.cafe"` in `.mcp.json` (the committed file points at `127.0.0.1:3030` for local work).
- Push approvals are disabled in v1 (no FCM credentials). A public BFF may run with `SOLANA_EXECUTION_TARGET=disabled`, in which case deposit / withdraw return "Execution is disabled" before the wallet opens.

## Where the protocol calls are

| What | File |
|---|---|
| CCA ABI (`AuctionCreated`, `BidSubmitted`, `AuctionParameters`) | `artifacts/seasonals-bff/src/ethereum/abis.ts` |
| CCA indexer (10k-block slices, retry, saved progress) | `artifacts/seasonals-bff/src/ethereum/cca.ts`: `ensureIndexing` (~L159), bid scan via raw `eth_getLogs` (~L391–L407) |
| CCA / Lido / Ethena / Pendle unsigned plans | `artifacts/seasonals-bff/src/ethereum/plans.ts`: `lido_claim` (~L105), `ethena_unstake` (~L129), `pendle_redeem` + Convert `POST /v3/sdk/1/convert` (~L146), `cca_exit_bid` / `cca_claim` (~L194) |
| Uniswap Trading API proxy + swap plan | `artifacts/seasonals-bff/src/ethereum/uniswap.ts`: base URL (L15), `/check_approval` / `/quote` preview (`uniswapPreview`), `buildUniswapSwapPlan` (peg guard → approval → quote with `generatePermitAsTransaction` → `/swap`) |
| Chainlink prices + fail-closed peg guard | `artifacts/seasonals-bff/src/ethereum/pricing.ts` (Feed Registry `latestRoundData`, `evaluatePeg`) |
| Aave V4 context (AaveKit) | `artifacts/seasonals-bff/src/ethereum/aave.ts` |
| Pendle / Ethena / Lido readers | `artifacts/seasonals-bff/src/ethereum/{pendle,ethena,lido}.ts` |
| Fork execution (Anvil only, user approval required) | `artifacts/seasonals-bff/src/ethereum/execute.ts` |
| 1inch Aqua (template validation, peg guard, ship / fill / dock, review event) | `artifacts/seasonals-bff/src/ethereum/aqua.ts` |
| MCP tools `list_events` / `get_proposal` / `build_action` / `ship_lp_strategy` + rebalance proposals `list_yield_menu` / `get_holdings` / `preview_rebalance_step` / `propose_rebalance` / `wait_for_rebalance_decision` / `execute_rebalance` | `artifacts/seasonals-mcp-server/src/server.ts` |
| Agent rebalance proposals (multi-step unsigned plan, bundle hash, human approval on the web Agent page or in chat, fork-only execution) | `artifacts/seasonals-bff/src/ethereum/agent-proposals.ts`, routes `/eth/agent-proposals*` in `routes/eth.ts`, web `artifacts/seasonals-web/src/agent/ProposalInbox.tsx` |
| Shared model (`TimelineEvent`, status derivation) | `lib/types/timeline.ts`, `lib/derive/timeline.ts` |
| Desktop Web | `artifacts/seasonals-web/` (Home lobby, Calendar/Timeline workspace, Explore, Agent, Dashboard, Settings, WebGL water background) |

Uniswap developer feedback is in [`FEEDBACK.md`](FEEDBACK.md).

## Tests

```bash
pnpm -r test                      # lib, BFF, MCP Server, mobile, web
pnpm -r typecheck
pnpm --filter @seasonals/bff verify:tx     # 23 Solana tx routes simulated on mainnet, no signing (needs HELIUS_API_KEY)
bash scripts/typecheck-baseline.sh
pnpm --filter @seasonals/web build
node artifacts/seasonals-web/e2e/run.mjs   # needs the web dev server; uses the system Chrome
# production build through the Pages Function proxy (BFF on :3035):
#   cd artifacts/seasonals-web && pnpm build && npx wrangler@4 pages dev dist --binding BFF_ORIGIN=http://127.0.0.1:3035 --port 8788
#   WEB_URL=http://127.0.0.1:8788 node e2e/run.mjs
```

## Not built (yet)

- Aqua on mainnet. Takers there are KYB-gated resolvers, so ship / fill / dock run only on the fork.
- Aave actions (supply / borrow). Aave is read-only context.
- Uniswap on mainnet, and UniswapX `/order`. Swaps run only on the fork, and only for USDC ⇄ USDe.
- Browser-wallet signing on mainnet
- CCA `exitPartiallyFilledBid`
- LLM-generated proposals (rule-based today)

`docs/web/WORKLOG.md` tracks the current state.

## Partner notes

- **Curvegrid MultiBaas:** not used.
- **Team:** to be completed by the submitter.

## AI usage

The desktop Web app and the Ethereum time layer were implemented with **Claude Code (Claude Opus 5.5)**, working from human-written specs:
- the UI spec, in `docs/web/ui-spec-v2.md`
- the water shader spec, in `docs/web/water-background-spec.md`
- a product plan, not committed

The agent made every commit on this branch with a `Co-Authored-By` trailer. Design decisions and conflicts between the specs are recorded in `docs/web/WORKLOG.md`.

The Solana / Seeker app, the BFF and the MCP Server were likewise built with Claude Code from a human-written requirements spec (`docs/spec.md`, kept private): prose, specs and review by Claude Fable 5.1, implementation by Claude Opus 5.5 subagents, each commit carrying a `Co-Authored-By` trailer. Humans decided the product, the protocol set, the fail-closed oracle rules and every deployment or signing step.

## License

Apache-2.0. See [`LICENSE`](LICENSE). "Seasonals" as a name and brand is not licensed.
