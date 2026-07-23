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
  ProtocolMenuEntry,
  UnifiedTimeEventDTO,
} from "@workspace/lib/types";

import type { BffClient } from "./bff-client";

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

  return server;
}
