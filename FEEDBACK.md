# Uniswap developer feedback (ETHGlobal Tokyo 2026)

Seasonals added an Ethereum "time layer": a calendar and an MCP API that show when DeFi positions need attention. For Uniswap, we built:

- a participant calendar for **Continuous Clearing Auctions (CCA)**, which indexes auctions from all four factory versions and turns start, end, claim and refund into dated events
- a server-side proxy for the **Uniswap Trading API**, used to route USDC → USDe before an Ethena deposit (preview, plus fork execution behind a Chainlink peg guard)

Everything below comes from building and running that code against Ethereum mainnet on 2026-09-26.

## Where the code is

| What | File |
|---|---|
| CCA ABI (factory event, bid events, `exitBid` / `claimTokens`, `AuctionParameters`) | `artifacts/seasonals-bff/src/ethereum/abis.ts` |
| CCA indexer, auction and bid events | `artifacts/seasonals-bff/src/ethereum/cca.ts` |
| CCA `exitBid` / `claimTokens` unsigned plans | `artifacts/seasonals-bff/src/ethereum/plans.ts` (`case "cca_exit_bid"` / `"cca_claim"`) |
| Trading API proxy (`/check_approval`, `/quote`) | `artifacts/seasonals-bff/src/ethereum/uniswap.ts` |
| HTTP routes | `artifacts/seasonals-bff/src/routes/eth.ts` (`/eth/cca/status`, `/eth/uniswap/quote`) |
| MCP tools that expose the same events | `artifacts/seasonals-mcp-server/src/server.ts` (`list_events`, `build_action`) |

## Continuous Clearing Auction

### What worked well

- The contracts are easy to read. `AuctionParameters` is the same struct from v1.0.0 to v2.1.0, so one decoder covers all four factories.
- The lifecycle maps directly onto calendar events: `startBlock`, `endBlock` and `claimBlock` in the parameters, then `exitBid` / `claimTokens` per bid.
- The event types are identical from v1.1.0 to v2.1.0, so the topic hashes match. One `eth_getLogs` over all factory addresses finds every auction.
- We verified a real refund end to end:
  - A mainnet bidder in an auction that ended without graduating (UNO) had not exited.
  - `exitBid(0)` succeeded as an `eth_call` against mainnet state.
  - The same transaction executed on an Anvil fork (receipt: success).

### Friction we hit

1. **Finding the factories.**
   - The README lists deployments, including v2.1.0 (`0x000000001F26…63F8`), which our planning notes did not have.
   - It does not list deployment blocks. We found them by binary-searching `eth_getCode`: v1.0.0 at 23,780,787, v1.1.0 at 24,321,671, v2.0.0 at 25,331,230, v2.1.0 at 25,503,447.
   - Publishing the start blocks would save every indexer that search.
2. **Event shape differs from some descriptions.**
   - Our spec had `AuctionCreated(address auction, address token, uint128 amount, bytes parameters)`.
   - The deployed contracts emit `AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)`.
   - `BidSubmitted` uses `uint256 priceQ96, uint128 amount`.
   - A short "events and topics" table in the docs would prevent silent mismatches.
3. **No hosted index.**
   - We scanned about 2.28M blocks in 10,000-block slices (our RPC provider's limit) to find 330 auctions.
   - A subgraph or a factory view that returns auctions by block range would make participant tooling much easier.
4. **Many tiny or test auctions.**
   - A large share of auctions last only a few blocks.
   - Some use symbols that copy well-known tokens (for example `USDT`).
   - We filter out auctions shorter than about 2 hours and always show the token contract next to the symbol.
   - Guidance on how frontends should present unverified auctions would help.
5. **Block-based time.**
   - Calendars need wall-clock time. We estimate at 12 s per block and label the result as approximate.
   - An estimate helper in `CCALens`, or at least a doc note, would make the approximation consistent across tools.
6. **Partially filled bids.**
   - `exitPartiallyFilledBid` needs two checkpoint hints.
   - We did not find a simple off-chain recipe for computing them, so we mark those bids as "manual exit".

## Trading API

### What worked well

- The OpenAPI document at `https://trade-api.gateway.uniswap.org/v1/api.json` was the fastest way to get exact request schemas.
- `/check_approval` → `/quote` worked on the first try from the server with `x-api-key`. For example, 1,000 USDC → 999.94 USDe via `CLASSIC` routing, with approval and permit needed.
- Branching on `routing` (CLASSIC / WRAP / UNWRAP / BRIDGE → `/swap`, DUTCH_* / PRIORITY → `/order`, CHAINED → plan endpoints) is clearly documented.

### Friction we hit

1. **Docs navigation.**
   - `api-docs.uniswap.org/introduction` redirects to `developers.uniswap.org/docs/...`, which then redirects to an `llms.mdx` URL.
   - The API reference pages (`/docs/api-reference/check_approval`, `aggregator_quote`, …) returned "not found" in the `llms.mdx` form.
   - The OpenAPI JSON was the only complete machine-readable source we could reach.
2. **Preview without a wallet.**
   - `/quote` requires `swapper`, and `/check_approval` requires `walletAddress` and `amount`.
   - A read-only "indicative quote" mode that needs no wallet would suit calendar and agent previews, where nothing is signed yet.
3. **Price-dependent execution.**
   - Our rule is that any price-dependent execution must fail closed on stale or diverging oracles.
   - We gate swaps on a Chainlink USDe/USDC peg check, then call `/quote` with `generatePermitAsTransaction: true`.
     - This let an impersonated account on an Anvil fork run approve → Permit2 → swap without an off-chain signature.
     - It worked (100 USDC → 99.9986 USDe).
   - A documented way to get the quote's reference price and timestamp would make oracle comparisons more direct.
4. **`deadline` on forks.**
   - After advancing an Anvil fork's clock, the swap reverted with `TransactionDeadlinePassed()`.
   - Passing `deadline` to `/swap` based on the fork's block time did not change that.
   - A fresh fork, whose clock matches real time, worked. A note on how `deadline` interacts with the quote would help fork-based testing.

## Not done

- **UniswapX order routes** were not used. We only preview `routing`.
- **Mainnet swaps** are not sent. Execution is fork-only, and only for USDC ⇄ USDe, the pair that has a peg guard.
- **A fork demo of a full CCA lifecycle** (mining past `endBlock`) failed. Anvil mines block by block and fetches EIP-4788 beacon-root storage from upstream for each block, which hit our RPC's rate limit. We showed the exit path on an auction that had already ended on mainnet instead.
