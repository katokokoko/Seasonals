/**
 * Seasonals MCP Server (Phase 8.28) — "Humans read the calendar. Agents read
 * the API. Same source of truth."
 *
 * 仕様 §6.3 / §24.9 の MCP surface を実装する v1:
 *   Tools    : compare_opportunities / simulate_action / request_user_approval
 *              / execute_approved_action (plan_rollover は v2)
 *   Resources: seasonals://protocols, seasonals://positions/{wallet},
 *              seasonals://events/{wallet}, seasonals://policy/default
 *   Prompts  : safety_first_rollover / max_yield_search (残 3 種は v2)
 *
 * v1 の逸脱 (README 参照): core service 直結ではなく BFF REST を表現層として
 * 共有 / 監査は stderr 構造化ログ (ClickHouse は §25.3 で後続) / rate limit・
 * policy engine 連携は未実装。
 *
 * §4.5: amount は smallest-unit string を透過 (境界で ^[0-9]+$ 検証)。
 * §6.5: Agent は unsigned tx を受け取るだけで署名しない (秘密鍵ゼロ)。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  AgentPlan,
  ApprovalToken,
  EthAgentProposal,
  EthProposalPreviewSlot,
  MenuHoldingsResponse,
  MenuProduct,
  ProtocolMenuEntry,
  UnifiedTimeEventDTO,
} from "@workspace/lib/types";
import { SWAP_SYMBOLS } from "@workspace/lib/types";

import type { BffClient } from "./bff-client";
import type { TimelineEvent, TimelineEventsResponse } from "@workspace/lib/types";
import { TIMELINE_STATUSES } from "@workspace/lib/types";
import { deriveTimelineStatus } from "@workspace/lib/derive/timeline";

/** RFC 5545 の最小 VEVENT 列 (日時のある event のみ) */
export function toIcal(events: TimelineEvent[]): string {
  const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (t: string) => t.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Seasonals//Time Layer//EN"];
  for (const e of events) {
    if (!e.at) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@seasonals`,
      `DTSTAMP:${stamp(e.observedAt)}`,
      `DTSTART:${stamp(e.at)}`,
      `SUMMARY:${esc(e.title)}`,
      `DESCRIPTION:${esc(`${e.protocolName ?? ""} ${e.kind} (${e.class}) source=${e.source}`)}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// Phase 8.38 (F3): enum は lib/types/enums.ts が canonical (§2)。手書き複製は
// enum 追加時に MCP 境界だけ zod が新値を拒否する drift を生むため、lib から導出
import {
  ACTION_TYPES as LIB_ACTION_TYPES,
  OBJECTIVES as LIB_OBJECTIVES,
} from "@workspace/lib/types";

const OBJECTIVES = LIB_OBJECTIVES as unknown as [string, ...string[]];
const ACTION_TYPES = LIB_ACTION_TYPES as unknown as [string, ...string[]];

/** tool 応答は JSON text content (MCP の標準形) */
function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** 監査ログ (v1: stderr 構造化 — ClickHouse mcp_audit_logs は §25.3 で後続) */
function audit(
  tool: string,
  planId: string | null,
  status: "ok" | "rejected" | "error",
  startedAt: number
): void {
  process.stderr.write(
    `${JSON.stringify({
      kind: "mcp_audit",
      tool_name: tool,
      plan_id: planId,
      response_status: status,
      latency_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    })}\n`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BuildOptions {
  /** request_user_approval の poll 間隔 (テストで短縮) */
  pollIntervalMs?: number;
}

export function buildMcpServer(
  bff: BffClient,
  opts: BuildOptions = {}
): McpServer {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const server = new McpServer({
    name: "seasonals",
    version: "0.1.0",
  });

  // ── Tools (§24.9) ──────────────────────────────────────────────────────────

  server.registerTool(
    "compare_opportunities",
    {
      description:
        "Compare and rank deposit opportunities across Seasonals-registered protocols " +
        "(live APY/TVL/utilization). Creates a draft AgentPlan and returns plan_id. " +
        "Follow with simulate_action → request_user_approval → execute_approved_action.",
      inputSchema: {
        objective: z.enum(OBJECTIVES),
        asset: z.string().describe('Deposit asset symbol, e.g. "USDC" or "SOL"'),
        constraints: z
          .object({
            min_tvl: z.number().optional(),
            max_utilization: z
              .number()
              .optional()
              .describe("Exclude lending pools above this utilization (0..1)"),
          })
          .optional(),
      },
    },
    async ({ objective, asset, constraints }) => {
      const t0 = Date.now();
      try {
        const menu = await bff.get<ProtocolMenuEntry[]>("/menu-listings");
        const pools = menu.flatMap((entry) =>
          entry.pools
            // Phase 8.33: read-only listing (Exponent PT 等) は simulate/execute 経路が
            // 無いため候補から除外 (fail-closed — stub simulate が「実行可能」に見える
            // 事故を防ぐ)。PT の maturity 情報は calendar resource 経由で agent に届く
            .filter((p) => !p.display_only)
            // Phase 8.52: 預入停止中 / 上流都合で預入不能な pool も候補から外す
            // (BFF は execute を 409 で止めるが、Agent に無駄な plan を作らせない)
            .filter((p) => p.deposit_open !== false)
            .filter((p) => (p.deposit_asset ?? p.asset) === asset)
            .filter((p) =>
              constraints?.min_tvl !== undefined
                ? p.tvl_usd >= constraints.min_tvl
                : true
            )
            .filter((p) =>
              constraints?.max_utilization !== undefined &&
              p.utilization !== undefined
                ? p.utilization <= constraints.max_utilization
                : true
            )
            .map((p) => ({ entry, pool: p }))
        );
        // ランク: safety_first は TVL 優先、それ以外は APY 優先
        pools.sort((a, b) =>
          objective === "safety_first"
            ? b.pool.tvl_usd - a.pool.tvl_usd
            : b.pool.apy - a.pool.apy
        );
        const ranked = pools.slice(0, 8).map(({ entry, pool }, i) => {
          const reasoning: string[] = [
            `APY ${(pool.apy * 100).toFixed(2)}%`,
            `TVL $${Math.round(pool.tvl_usd).toLocaleString()}`,
          ];
          if (pool.utilization !== undefined && pool.utilization >= 0.95) {
            reasoning.push(
              `WARNING: utilization ${(pool.utilization * 100).toFixed(0)}% — withdrawals may be limited`
            );
          }
          return {
            rank: i + 1,
            protocol_id: entry.protocol_id,
            market_id: pool.pool_id,
            apy: pool.apy,
            tvl: pool.tvl_usd,
            utilization: pool.utilization ?? null,
            reasoning,
          };
        });
        const plan = await bff.post<AgentPlan>("/agent-plans", {
          objective,
          mcp_client_id: "seasonals-mcp-v1",
          constraints,
        });
        audit("compare_opportunities", plan.plan_id, "ok", t0);
        return jsonContent({ plan_id: plan.plan_id, ranked_candidates: ranked });
      } catch (err) {
        audit("compare_opportunities", null, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "simulate_action",
    {
      description:
        "Simulate an action against an existing AgentPlan (sets selected_action, " +
        "returns deterministic bundle_hash). Use plan_id (not simulation_id) for approval.",
      inputSchema: {
        plan_id: z.string(),
        action_spec: z.object({
          wallet_id: z.string(),
          action_type: z.enum(ACTION_TYPES),
          protocol: z.string(),
          asset: z.string().optional(),
          amount: z
            .string()
            .regex(/^[0-9]+$/, "smallest-unit integer string (§4.5)")
            .optional(),
          to_protocol: z.string().optional(),
        }),
      },
    },
    async ({ plan_id, action_spec }) => {
      const t0 = Date.now();
      try {
        const res = await bff.post<{
          plan_id: string;
          simulation: Record<string, unknown>;
        }>(`/agent-plans/${plan_id}/simulate`, { action_spec });
        audit("simulate_action", plan_id, "ok", t0);
        return jsonContent({
          simulation_id: res.simulation.simulation_id,
          plan_id: res.plan_id,
          status: "ok",
          estimated_out: res.simulation.estimated_out,
          slippage_bps: res.simulation.slippage_bps,
          bundle_hash: res.simulation.bundle_hash,
        });
      } catch (err) {
        audit("simulate_action", plan_id, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "request_user_approval",
    {
      description:
        "Request user approval for a simulated plan (push notification to the " +
        "user's mobile, then long-poll). Returns approval_token only after the " +
        "user explicitly approves. Idempotent — safe to retry while pending.",
      inputSchema: {
        plan_id: z.string(),
        timeout_seconds: z.number().int().min(1).max(600).default(300),
      },
    },
    async ({ plan_id, timeout_seconds }) => {
      const t0 = Date.now();
      try {
        await bff.post(`/agent-plans/${plan_id}/request-approval`, {
          timeout_seconds,
        });
        const deadline = Date.now() + timeout_seconds * 1000;
        // §10.3: long-running response — approved/rejected/timeout まで poll。
        // Phase 8.38 (F7): 一過性の BFF エラー (deploy 中の 502 等) で承認待ち全体を
        // abort しない — deadline 内なら次の poll で継続する (fail 側は timeout が拾う)
        for (;;) {
          let res: {
            status: AgentPlan["status"];
            approval_token: ApprovalToken | null;
          };
          try {
            res = await bff.get<{
              status: AgentPlan["status"];
              approval_token: ApprovalToken | null;
            }>(`/agent-plans/${plan_id}/approval`);
          } catch {
            if (Date.now() >= deadline) {
              audit("request_user_approval", plan_id, "rejected", t0);
              return jsonContent({ status: "timeout" });
            }
            await sleep(pollIntervalMs);
            continue;
          }
          if (res.status === "approved" && res.approval_token) {
            audit("request_user_approval", plan_id, "ok", t0);
            return jsonContent({
              status: "approved",
              approval_token: res.approval_token.token_id,
              expires_at: res.approval_token.expires_at,
            });
          }
          if (res.status === "rejected") {
            audit("request_user_approval", plan_id, "rejected", t0);
            return jsonContent({
              status: "rejected",
              rejection_reason: "user_declined",
            });
          }
          if (Date.now() >= deadline) {
            audit("request_user_approval", plan_id, "rejected", t0);
            return jsonContent({ status: "timeout" });
          }
          await sleep(pollIntervalMs);
        }
      } catch (err) {
        audit("request_user_approval", plan_id, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "execute_approved_action",
    {
      description:
        "Execute a previously user-approved plan. Requires the single-use " +
        "approval_token issued at approval. Returns UNSIGNED transactions — " +
        "the agent never receives signed transactions (§6.5).",
      inputSchema: {
        plan_id: z.string(),
        approval_token: z.string(),
      },
    },
    async ({ plan_id, approval_token }) => {
      const t0 = Date.now();
      try {
        const res = await bff.post<Record<string, unknown>>(
          `/agent-plans/${plan_id}/execute`,
          { approval_token }
        );
        audit("execute_approved_action", plan_id, "ok", t0);
        return jsonContent({
          execution_id: res.execution_id,
          status: res.status,
          unsigned_transactions: res.unsigned_transactions,
        });
      } catch (err) {
        audit("execute_approved_action", plan_id, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "run_autonomous",
    {
      description:
        "Run ONE autonomous cycle: decide from live mainnet menu under the user " +
        "policy + hard caps, then (devnet only, bounded delegate) auto-sign and " +
        "broadcast with NO human tap. dry_run defaults to TRUE — pass dry_run:false " +
        "explicitly to move funds. Returns an AutonomousExecutionRecord.",
      inputSchema: {
        objective: z.enum(OBJECTIVES),
        asset: z.string().optional(),
        dry_run: z.boolean().default(true),
      },
    },
    async ({ objective, asset, dry_run }) => {
      const t0 = Date.now();
      try {
        const record = await bff.post<{ plan_id: string | null; decision: string }>(
          "/autonomous/tick",
          { objective, asset, dry_run }
        );
        audit(
          "run_autonomous",
          record.plan_id,
          record.decision === "rejected" ? "rejected" : "ok",
          t0
        );
        return jsonContent(record);
      } catch (err) {
        // 無効状態 (flag off / not devnet / kill / no delegate) は agent-friendly に
        const anyErr = err as { status?: number; body?: { reason?: string } };
        if (anyErr.status === 403 || anyErr.status === 503 || anyErr.status === 409) {
          audit("run_autonomous", null, "rejected", t0);
          return jsonContent({
            decision: "rejected",
            reason: anyErr.body?.reason ?? "autonomous_disabled",
          });
        }
        audit("run_autonomous", null, "error", t0);
        throw err;
      }
    }
  );

  // ── Resources (§6.3) ───────────────────────────────────────────────────────

  server.registerResource(
    "protocols",
    "seasonals://protocols",
    {
      description:
        "Trusted protocol / pool catalog with live APY, TVL and utilization",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await bff.get("/menu-listings"), null, 2),
        },
      ],
    })
  );

  server.registerResource(
    "positions",
    new ResourceTemplate("seasonals://positions/{wallet}", { list: undefined }),
    {
      description: "Normalized earn positions for a wallet (same data as mobile)",
      mimeType: "application/json",
    },
    async (uri, { wallet }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            await bff.get(`/positions/earn?wallet=${wallet}`),
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerResource(
    "events",
    new ResourceTemplate("seasonals://events/{wallet}", { list: undefined }),
    {
      description:
        "UnifiedTimeEvents for a wallet (agentReadable events only, §11.4)",
      mimeType: "application/json",
    },
    async (uri, { wallet }) => {
      const events = await bff.get<UnifiedTimeEventDTO[]>(
        `/time-events/wallet?wallet=${wallet}`
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              events.filter((e) => e.agentReadable !== false),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerResource(
    "policy",
    "seasonals://policy/default",
    {
      description: "User policy (read-only, §11.6)",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await bff.get("/user-policy"), null, 2),
        },
      ],
    })
  );

  // ── Prompts (§6.3、v1 は 2/5) ──────────────────────────────────────────────

  server.registerPrompt(
    "max_yield_search",
    {
      description: "Find the best yield for an asset within safety constraints",
      argsSchema: { asset: z.string() },
    },
    ({ asset }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Find the highest-yield deposit opportunity for ${asset} on Seasonals. ` +
              `Use compare_opportunities with objective "max_yield". Exclude pools with ` +
              `utilization above 0.95 (withdrawal liquidity risk). Present the top 3 with ` +
              `APY, TVL and risks, then ask me before simulating.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "safety_first_rollover",
    {
      description: "Plan a safety-first rollover for a maturing position",
      argsSchema: { position_id: z.string() },
    },
    ({ position_id }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Position ${position_id} is approaching a time event. Read my positions and ` +
              `events resources, then use compare_opportunities with objective "safety_first" ` +
              `to propose a rollover. Prefer high-TVL, low-utilization pools. Simulate before ` +
              `requesting my approval.`,
          },
        },
      ],
    })
  );

  // ── Ethereum time layer (docs/web/WORKLOG.md Stage B) ─────────────────────
  // UI と同じ BFF /eth/* を読む (same source of truth)。build_action は unsigned plan
  // を返すだけで、署名も broadcast もしない (Ethereum v3 §9)。

  const EVM_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 20-byte address");

  server.registerTool(
    "list_events",
    {
      description:
        "List Ethereum time events (Pendle PT maturity, Ethena sUSDe cooldown end, Lido withdrawal queue, " +
        "public Pendle market maturities) from the same source the Seasonals calendar renders. " +
        "Each event carries observedAt and source so you can judge freshness. Status is derived at request time.",
      inputSchema: {
        address: EVM_ADDRESS.optional().describe("Wallet to read. Omit for public events only."),
        from: z.string().datetime().optional().describe("ISO start (inclusive)"),
        to: z.string().datetime().optional().describe("ISO end (inclusive)"),
        status: z.enum(TIMELINE_STATUSES as unknown as [string, ...string[]]).optional(),
      },
    },
    async ({ address, from, to, status }) => {
      const t0 = Date.now();
      try {
        const res = await bff.get<TimelineEventsResponse>(
          address ? `/eth/events?address=${address}` : "/eth/public-events"
        );
        const now = new Date();
        const lo = from ? Date.parse(from) : -Infinity;
        const hi = to ? Date.parse(to) : Infinity;
        const events = res.events
          .map((e) => ({ ...e, status: deriveTimelineStatus(e, now) }))
          .filter((e) => (e.at === null ? !from && !to : Date.parse(e.at) >= lo && Date.parse(e.at) <= hi))
          .filter((e) => !status || e.status === status);
        audit("list_events", null, "ok", t0);
        return jsonContent({ events, sources: res.sources, derivedAt: now.toISOString() });
      } catch (err) {
        audit("list_events", null, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "get_proposal",
    {
      description:
        "Get the proposal for one event: what to do when its date arrives (facts, assumptions, options, risks, " +
        "recommendation). Rule-based unless the server has an LLM configured. Contains no calldata.",
      inputSchema: { address: EVM_ADDRESS, eventId: z.string().min(1) },
    },
    async ({ address, eventId }) => {
      const t0 = Date.now();
      try {
        const p = await bff.get(`/eth/proposal?address=${address}&eventId=${encodeURIComponent(eventId)}`);
        audit("get_proposal", null, "ok", t0);
        return jsonContent(p);
      } catch (err) {
        audit("get_proposal", null, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "build_action",
    {
      description:
        "Build an UNSIGNED transaction plan for an event action (e.g. lido_claim, ethena_unstake, pendle_redeem). " +
        "The server re-checks on-chain state, builds calldata from protocol ABIs / Pendle Convert, and checks it with " +
        "eth_call. It never signs or broadcasts; the human signs in their own wallet.",
      inputSchema: { address: EVM_ADDRESS, eventId: z.string().min(1), actionType: z.string().regex(/^[a-z_]+$/) },
    },
    async ({ address, eventId, actionType }) => {
      const t0 = Date.now();
      try {
        const plan = await bff.post("/eth/build-action", { owner: address, eventId, actionType });
        audit("build_action", null, "ok", t0);
        return jsonContent(plan);
      } catch (err) {
        audit("build_action", null, "rejected", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "ship_lp_strategy",
    {
      description:
        "Prepare an UNSIGNED plan to ship a 1inch Aqua LP strategy. Only the PEGGED_STABLE template (USDC/USDe) is accepted; " +
        "the server validates the parameters and refuses if the Chainlink USDe/USDC peg is stale or off by more than 0.5%. " +
        "It never signs or broadcasts. After the human ships it, a strategy review event appears on the calendar on reviewAt.",
      inputSchema: {
        maker: EVM_ADDRESS,
        template: z.enum(["PEGGED_STABLE"]),
        usdcAmount: z.string().regex(/^[0-9]+$/).describe("USDC in smallest units (6 decimals)"),
        usdeAmount: z.string().regex(/^[0-9]+$/).describe("USDe in smallest units (18 decimals)"),
        bandBps: z.number().int().min(10).max(200),
        feeBps: z.number().int().min(1).max(30).optional().describe("Fee on the taker's input token, default 5 bps"),
        reviewAt: z.string().datetime(),
      },
    },
    async (args) => {
      const t0 = Date.now();
      try {
        const plan = await bff.post("/eth/aqua/ship-plan", args);
        audit("ship_lp_strategy", null, "ok", t0);
        return jsonContent(plan);
      } catch (err) {
        audit("ship_lp_strategy", null, "rejected", t0);
        throw err;
      }
    }
  );

  // ── Agent rebalance proposals (Ethereum) ──────────────────────────────────
  // 読む (menu / holdings) → 1 step ずつ preview → 複数 step の proposal を提出 → 人が承認
  // (web の Agent ページ、または chat で明示的な yes) → fork でだけ実行。Agent は署名しない。

  const DECIMAL = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "decimal string like \"100\" or \"1.5\"");
  const PROPOSAL_STEP = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("menu"),
      productId: z.string().min(1).describe('From list_yield_menu, e.g. "ethereum:ethena:susde", "ethereum:lido:steth", "ethereum:pendle:pt:0x…"'),
      action: z.enum(["deposit", "withdraw"]),
      amount: DECIMAL.describe("Human-readable decimal of the token being paid (deposit) or sold/withdrawn (withdraw)"),
      token: z.string().min(1).optional().describe('Withdraw token when the product offers a choice (Lido: "stETH" | "wstETH")'),
    }),
    z.object({
      kind: z.literal("uniswap_swap"),
      tokenIn: z.enum(SWAP_SYMBOLS),
      tokenOut: z.enum(SWAP_SYMBOLS),
      amount: DECIMAL.describe("Human-readable decimal of tokenIn"),
    }),
    z.object({
      kind: z.literal("event_action"),
      eventId: z.string().min(1).describe("An event id from list_events"),
      actionType: z.string().regex(/^[a-z_]+$/).describe("One of that event's actions (lido_claim, ethena_unstake, pendle_redeem, aqua_dock …)"),
    }),
  ]);
  const proposalPath = (id: string) => `/eth/agent-proposals/${encodeURIComponent(id)}`;

  server.registerTool(
    "list_yield_menu",
    {
      description:
        "List the Ethereum yield menu the Seasonals Menu page shows: Lido stETH, Ethena sUSDe and the top Pendle PT / YT markets " +
        "with live rates (APR / 30d yield / implied APY; null when the source was unavailable), product ids, maturities and facts. " +
        "Use the product ids in propose_rebalance menu steps.",
      inputSchema: {},
    },
    async () => {
      const t0 = Date.now();
      try {
        const menu = await bff.get<MenuProduct[]>("/eth/menu");
        audit("list_yield_menu", null, "ok", t0);
        return jsonContent({ products: menu });
      } catch (err) {
        audit("list_yield_menu", null, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "get_holdings",
    {
      description:
        "Read what an address holds in the menu products (stETH / wstETH, sUSDe incl. cooldown, Pendle PT / YT) plus spendable ETH / USDe, " +
        "as the Menu page shows them (mainnet state; amounts are smallest-unit strings with decimals). Also reports whether the local " +
        "Anvil fork is reachable, which is where approved proposals run.",
      inputSchema: { address: EVM_ADDRESS },
    },
    async ({ address }) => {
      const t0 = Date.now();
      try {
        const [holdings, status] = await Promise.all([
          bff.get<MenuHoldingsResponse>(`/eth/holdings?address=${address}`),
          bff.get<{ executionTarget: "fork" | "mainnet"; forkReachable: boolean }>("/eth/status"),
        ]);
        audit("get_holdings", null, "ok", t0);
        return jsonContent({ ...holdings, executionTarget: status.executionTarget, forkReachable: status.forkReachable });
      } catch (err) {
        audit("get_holdings", null, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "preview_rebalance_step",
    {
      description:
        "Build the UNSIGNED plan for one rebalance step against current mainnet state, without submitting anything. Runs the same " +
        "guards as execution (Chainlink peg for swaps, Pendle TWAP for PT / YT, balances). For a uniswap_swap it returns amountOut " +
        "(smallest units of tokenOut) so you can size the next step. Nothing is signed or sent.",
      inputSchema: { address: EVM_ADDRESS, step: PROPOSAL_STEP },
    },
    async ({ address, step }) => {
      const t0 = Date.now();
      try {
        const preview = await bff.post<EthProposalPreviewSlot>("/eth/agent-proposals/preview", { owner: address, step });
        audit("preview_rebalance_step", null, "ok", t0);
        return jsonContent(preview);
      } catch (err) {
        audit("preview_rebalance_step", null, "rejected", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "propose_rebalance",
    {
      description:
        "Submit a multi-step rebalance (up to 6 steps: menu deposit / withdraw, USDC ⇄ USDe swap, event action) as an UNSIGNED proposal. " +
        "The server builds every step and refuses the whole proposal if any guard fails; a later step that spends what an earlier step " +
        "produces is deferred and checked on the fork when it runs. Size such steps from the previous step's preview amountOut (leave ~1% margin). " +
        "Withdrawals from Lido (queue) and Ethena (cooldown) are not liquid in the same run — end the proposal at the request and let the " +
        "calendar event handle the claim later. Nothing runs until a human approves: after submitting, show the user the id, the steps and the " +
        "bundleHash, then either ask them to approve it on the Seasonals web Agent page (then call wait_for_rebalance_decision) or ask for an " +
        "explicit yes in this conversation (then call execute_rebalance). Execution happens only on the local Anvil fork; the Agent never signs.",
      inputSchema: {
        address: EVM_ADDRESS,
        title: z.string().min(1).max(120),
        rationale: z.string().min(1).max(2000).describe("Why this rebalance, in plain words the user will read before approving"),
        steps: z.array(PROPOSAL_STEP).min(1).max(6),
      },
    },
    async ({ address, title, rationale, steps }) => {
      const t0 = Date.now();
      try {
        const proposal = await bff.post<EthAgentProposal>("/eth/agent-proposals", { owner: address, title, rationale, steps });
        audit("propose_rebalance", proposal.id, "ok", t0);
        return jsonContent(proposal);
      } catch (err) {
        audit("propose_rebalance", null, "rejected", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "wait_for_rebalance_decision",
    {
      description:
        "Wait for the human to approve (and thereby execute on the fork) or reject a proposal on the web Agent page. Long-polls until the " +
        "status is no longer pending, then returns the proposal with per-step fork transaction results. Returns {status:\"timeout\"} if nothing " +
        "happened within timeout_seconds; safe to call again.",
      inputSchema: { proposalId: z.string().min(1), timeout_seconds: z.number().int().min(1).max(600).default(300) },
    },
    async ({ proposalId, timeout_seconds }) => {
      const t0 = Date.now();
      const deadline = Date.now() + timeout_seconds * 1000;
      try {
        for (;;) {
          let p: EthAgentProposal | null = null;
          try {
            p = await bff.get<EthAgentProposal>(proposalPath(proposalId));
          } catch (err) {
            // 一過性の BFF エラーでは待ちを止めない (request_user_approval と同じ)。404 は即座に返す
            if ((err as { status?: number }).status === 404) throw err;
          }
          if (p && p.status !== "pending") {
            audit("wait_for_rebalance_decision", proposalId, p.status === "executed" ? "ok" : "rejected", t0);
            return jsonContent(p);
          }
          if (Date.now() >= deadline) {
            audit("wait_for_rebalance_decision", proposalId, "rejected", t0);
            return jsonContent({ status: "timeout", proposalId });
          }
          await sleep(pollIntervalMs);
        }
      } catch (err) {
        audit("wait_for_rebalance_decision", proposalId, "error", t0);
        throw err;
      }
    }
  );

  server.registerTool(
    "execute_rebalance",
    {
      description:
        "Execute a pending proposal on the local Anvil fork after the user explicitly approved it IN THIS CONVERSATION (user_confirmed must be true " +
        "and you must have shown them the steps). Pass the bundleHash from propose_rebalance: the server refuses anything that differs from what " +
        "was shown. Steps run in order and stop at the first failure. Never sends to mainnet; the Agent never signs.",
      inputSchema: {
        proposalId: z.string().min(1),
        bundleHash: z.string().regex(/^0x[0-9a-f]{64}$/),
        user_confirmed: z.literal(true).describe("Only true after the user said yes to this exact proposal"),
      },
    },
    async ({ proposalId, bundleHash }) => {
      const t0 = Date.now();
      try {
        const p = await bff.post<EthAgentProposal>(`${proposalPath(proposalId)}/execute`, { approvedBy: "user", via: "chat", bundleHash });
        audit("execute_rebalance", proposalId, p.status === "executed" ? "ok" : "rejected", t0);
        return jsonContent(p);
      } catch (err) {
        audit("execute_rebalance", proposalId, "rejected", t0);
        throw err;
      }
    }
  );

  server.registerResource(
    "calendar",
    new ResourceTemplate("seasonals://calendar/{address}", { list: undefined }),
    {
      description: "Ethereum events for an address as an iCalendar (text/calendar) feed",
      mimeType: "text/calendar",
    },
    async (uri, { address }) => {
      const res = await bff.get<TimelineEventsResponse>(`/eth/events?address=${String(address)}`);
      return { contents: [{ uri: uri.href, mimeType: "text/calendar", text: toIcal(res.events) }] };
    }
  );

  return server;
}
