/**
 * Phase 8.28: MCP server のテスト — InMemoryTransport で SDK Client を接続し、
 * BffClient を fake 注入して tools / resources / prompts を検証する。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer } from "./server";
import type { BffClient } from "./bff-client";

type Handler = (body?: unknown) => unknown;

/** path → handler の fake BFF */
function fakeBff(routes: Record<string, Handler>): BffClient {
  const lookup = (path: string): Handler => {
    const h = routes[path];
    if (!h) throw new Error(`fakeBff: unhandled ${path}`);
    return h;
  };
  return {
    get: async (path) => lookup(path)() as never,
    post: async (path, body) => lookup(path)(body) as never,
  };
}

async function connect(bff: BffClient) {
  const server = buildMcpServer(bff, { pollIntervalMs: 5 });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

function textOf(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] })
    .content;
  return JSON.parse(content[0]!.text);
}

const MENU = [
  {
    protocol_id: "kamino",
    display_name: "Kamino",
    primary_category: "lending",
    supported_assets: ["USDC"],
    icon_id: "kamino",
    icon_bg: "#000",
    pools: [
      {
        pool_id: "kamino_usdc_main",
        name: "USDC Main",
        category: "lending",
        asset: "USDC",
        apy: 0.045,
        tvl_usd: 100_000_000,
        utilization: 0.89,
      },
    ],
  },
  {
    protocol_id: "savefi",
    display_name: "Save",
    primary_category: "lending",
    supported_assets: ["USDC"],
    icon_id: "savefi",
    icon_bg: "#000",
    pools: [
      {
        pool_id: "savefi_usdc_main",
        name: "USDC Main",
        category: "lending",
        asset: "USDC",
        apy: 0.81,
        tvl_usd: 120_000_000,
        utilization: 1,
      },
    ],
  },
];

describe("Seasonals MCP server", () => {
  it("tools/list に §24.9 の 4 tools、prompts 2 種、resources 4 種", async () => {
    const { client } = await connect(fakeBff({}));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "compare_opportunities",
      "execute_approved_action",
      "request_user_approval",
      "run_autonomous",
      "simulate_action",
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      "max_yield_search",
      "safety_first_rollover",
    ]);
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    expect(
      resources.resources.length + templates.resourceTemplates.length
    ).toBe(4);
  });

  it("compare_opportunities: max_yield ランキング + utilization 警告 + plan 作成", async () => {
    const created: unknown[] = [];
    const { client } = await connect(
      fakeBff({
        "/menu-listings": () => MENU,
        "/agent-plans": (body) => {
          created.push(body);
          return { plan_id: "plan_mcp_test", status: "draft" };
        },
      })
    );
    const res = await client.callTool({
      name: "compare_opportunities",
      arguments: { objective: "max_yield", asset: "USDC" },
    });
    const out = textOf(res) as {
      plan_id: string;
      ranked_candidates: { market_id: string; reasoning: string[] }[];
    };
    expect(out.plan_id).toBe("plan_mcp_test");
    expect(out.ranked_candidates[0]!.market_id).toBe("savefi_usdc_main"); // apy 順
    expect(
      out.ranked_candidates[0]!.reasoning.some((r) => r.includes("WARNING"))
    ).toBe(true); // utilization 100%
    expect(created).toHaveLength(1);
  });

  it("compare: max_utilization 制約で満杯 pool を除外、safety_first は TVL 順", async () => {
    const { client } = await connect(
      fakeBff({
        "/menu-listings": () => MENU,
        "/agent-plans": () => ({ plan_id: "p2" }),
      })
    );
    const res = await client.callTool({
      name: "compare_opportunities",
      arguments: {
        objective: "safety_first",
        asset: "USDC",
        constraints: { max_utilization: 0.95 },
      },
    });
    const out = textOf(res) as { ranked_candidates: { market_id: string }[] };
    expect(out.ranked_candidates).toHaveLength(1);
    expect(out.ranked_candidates[0]!.market_id).toBe("kamino_usdc_main");
  });

  it("compare: display_only pool (8.33 read-only) は最高 APY でも候補から除外", async () => {
    const menuWithDisplayOnly = [
      ...MENU,
      {
        protocol_id: "exponent",
        display_name: "Exponent",
        primary_category: "pt_yt",
        supported_assets: ["USDC"],
        icon_id: "exponent",
        icon_bg: "#000",
        pools: [
          {
            pool_id: "exponent_pt_usdc_20991231",
            name: "PT USDC · 2099-12-31",
            category: "pt_yt",
            asset: "USDC",
            apy: 0.99, // 全 pool 中最高だが実行経路なし
            tvl_usd: 9_000_000_000,
            display_only: true,
          },
        ],
      },
    ];
    const { client } = await connect(
      fakeBff({
        "/menu-listings": () => menuWithDisplayOnly,
        "/agent-plans": () => ({ plan_id: "p3" }),
      })
    );
    const res = await client.callTool({
      name: "compare_opportunities",
      arguments: { objective: "max_yield", asset: "USDC" },
    });
    const out = textOf(res) as { ranked_candidates: { market_id: string }[] };
    expect(
      out.ranked_candidates.some((c) => c.market_id.startsWith("exponent_"))
    ).toBe(false);
    expect(out.ranked_candidates[0]!.market_id).toBe("savefi_usdc_main");
  });

  it("compare: deposit_open=false の pool (8.52 満杯/停止中) も候補から除外", async () => {
    const menuWithClosed = [
      ...MENU,
      {
        protocol_id: "exponent",
        display_name: "Exponent",
        primary_category: "pt_yt",
        supported_assets: ["USDC"],
        icon_id: "exponent",
        icon_bg: "#000",
        pools: [
          {
            pool_id: "exponent_closed_usdc",
            name: "USDC (deposits closed)",
            category: "lending",
            asset: "USDC",
            apy: 0.99, // 全 pool 中最高だが預入不能
            tvl_usd: 9_000_000_000,
            deposit_open: false,
          },
        ],
      },
    ];
    const { client } = await connect(
      fakeBff({
        "/menu-listings": () => menuWithClosed,
        "/agent-plans": () => ({ plan_id: "p3b" }),
      })
    );
    const res = await client.callTool({
      name: "compare_opportunities",
      arguments: { objective: "max_yield", asset: "USDC" },
    });
    const out = textOf(res) as { ranked_candidates: { market_id: string }[] };
    expect(
      out.ranked_candidates.some((c) => c.market_id === "exponent_closed_usdc")
    ).toBe(false);
    expect(out.ranked_candidates[0]!.market_id).toBe("savefi_usdc_main");
  });

  it("simulate_action: BFF へ透過し bundle_hash を返す / 不正 amount は zod 拒否", async () => {
    const { client } = await connect(
      fakeBff({
        "/agent-plans/p1/simulate": (body) => ({
          plan_id: "p1",
          simulation: {
            simulation_id: "sim_1",
            estimated_out: "95",
            slippage_bps: 50,
            bundle_hash: "0xabc",
            echo: body,
          },
        }),
      })
    );
    const ok = await client.callTool({
      name: "simulate_action",
      arguments: {
        plan_id: "p1",
        action_spec: {
          wallet_id: "W",
          action_type: "deposit",
          protocol: "jito",
          asset: "SOL",
          amount: "100000000",
        },
      },
    });
    expect((textOf(ok) as { bundle_hash: string }).bundle_hash).toBe("0xabc");

    const bad = await client.callTool({
      name: "simulate_action",
      arguments: {
        plan_id: "p1",
        action_spec: {
          wallet_id: "W",
          action_type: "deposit",
          protocol: "jito",
          amount: "1.5", // §4.5 違反
        },
      },
    });
    expect(bad.isError).toBe(true);
  });

  it("request_user_approval: approved / rejected / timeout の 3 分岐", async () => {
    // approved: 2 回目の poll で token が付く
    let calls = 0;
    const approvedBff = fakeBff({
      "/agent-plans/p1/request-approval": () => ({ status: "pending_user" }),
      "/agent-plans/p1/approval": () => {
        calls++;
        return calls < 2
          ? { status: "pending_user", approval_token: null }
          : {
              status: "approved",
              approval_token: {
                token_id: "tok_1",
                expires_at: "2026-07-11T00:05:00.000Z",
              },
            };
      },
    });
    const a = await connect(approvedBff);
    const approved = textOf(
      await a.client.callTool({
        name: "request_user_approval",
        arguments: { plan_id: "p1", timeout_seconds: 5 },
      })
    ) as { status: string; approval_token: string };
    expect(approved.status).toBe("approved");
    expect(approved.approval_token).toBe("tok_1");

    const r = await connect(
      fakeBff({
        "/agent-plans/p2/request-approval": () => ({}),
        "/agent-plans/p2/approval": () => ({
          status: "rejected",
          approval_token: null,
        }),
      })
    );
    expect(
      (
        textOf(
          await r.client.callTool({
            name: "request_user_approval",
            arguments: { plan_id: "p2", timeout_seconds: 5 },
          })
        ) as { status: string }
      ).status
    ).toBe("rejected");

    const t = await connect(
      fakeBff({
        "/agent-plans/p3/request-approval": () => ({}),
        "/agent-plans/p3/approval": () => ({
          status: "pending_user",
          approval_token: null,
        }),
      })
    );
    expect(
      (
        textOf(
          await t.client.callTool({
            name: "request_user_approval",
            arguments: { plan_id: "p3", timeout_seconds: 1 },
          })
        ) as { status: string }
      ).status
    ).toBe("timeout");
  }, 15000);

  it("execute_approved_action: unsigned tx を透過 (署名は受け取らない)", async () => {
    const { client } = await connect(
      fakeBff({
        "/agent-plans/p1/execute": (body) => ({
          execution_id: "exec_p1",
          status: "pushed_to_mobile",
          unsigned_transactions: [
            { index: 0, label: "deposit", tx_base64: "TX" },
          ],
          echo: body,
        }),
      })
    );
    const out = textOf(
      await client.callTool({
        name: "execute_approved_action",
        arguments: { plan_id: "p1", approval_token: "tok_1" },
      })
    ) as { status: string; unsigned_transactions: { tx_base64: string }[] };
    expect(out.status).toBe("pushed_to_mobile");
    expect(out.unsigned_transactions[0]!.tx_base64).toBe("TX");
  });

  it("run_autonomous: dry_run デフォルト true で tick、record 透過", async () => {
    let sentBody: unknown;
    const { client } = await connect(
      fakeBff({
        "/autonomous/tick": (body) => {
          sentBody = body;
          return { record_id: "auto_1", plan_id: "p1", decision: "dry_run" };
        },
      })
    );
    const out = textOf(
      await client.callTool({
        name: "run_autonomous",
        arguments: { objective: "safety_first" },
      })
    ) as { decision: string };
    expect(out.decision).toBe("dry_run");
    expect((sentBody as { dry_run: boolean }).dry_run).toBe(true); // zod default
  });

  it("run_autonomous: 403 (flag off) は rejected content で返す", async () => {
    const { client } = await connect(
      fakeBff({
        "/autonomous/tick": () => {
          const e = new Error("disabled") as Error & {
            status: number;
            body: { reason: string };
          };
          e.status = 403;
          e.body = { reason: "feature_flag_off" };
          throw e;
        },
      })
    );
    const out = textOf(
      await client.callTool({
        name: "run_autonomous",
        arguments: { objective: "max_yield", dry_run: false },
      })
    ) as { decision: string; reason: string };
    expect(out.decision).toBe("rejected");
    expect(out.reason).toBe("feature_flag_off");
  });

  it("resources: protocols 読み / events は agentReadable=false を除外", async () => {
    const { client } = await connect(
      fakeBff({
        "/menu-listings": () => MENU,
        "/time-events/wallet?wallet=W1": () => [
          { id: "e1", agentReadable: true },
          { id: "e2", agentReadable: false },
        ],
      })
    );
    const protocols = await client.readResource({ uri: "seasonals://protocols" });
    expect(
      JSON.parse((protocols.contents[0] as { text: string }).text)
    ).toHaveLength(2);
    const events = await client.readResource({
      uri: "seasonals://events/W1",
    });
    const list = JSON.parse((events.contents[0] as { text: string }).text) as {
      id: string;
    }[];
    expect(list.map((e) => e.id)).toEqual(["e1"]);
  });
});
