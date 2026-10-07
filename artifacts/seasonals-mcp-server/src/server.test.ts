/**
 * Phase 8.28: MCP server のテスト — InMemoryTransport で SDK Client を接続し、
 * BffClient を fake 注入して tools / resources / prompts を検証する。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer } from "./server";
import { BffHttpError, type BffClient } from "./bff-client";

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
  it("tools/list に §24.9 の tools + Ethereum time layer 4 tools + rebalance proposal 6 tools、prompts 2 種、resources 5 種", async () => {
    const { client } = await connect(fakeBff({}));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "build_action",
      "compare_opportunities",
      "execute_approved_action",
      "execute_rebalance",
      "get_holdings",
      "get_proposal",
      "list_events",
      "list_yield_menu",
      "preview_rebalance_step",
      "propose_rebalance",
      "request_user_approval",
      "run_autonomous",
      "ship_lp_strategy",
      "simulate_action",
      "wait_for_rebalance_decision",
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      "design_rebalance",
      "max_yield_search",
      "safety_first_rollover",
    ]);
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    expect(
      resources.resources.length + templates.resourceTemplates.length
    ).toBe(5);
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

  it("compare: 候補は action_spec_template / route_kind / amount 単位を持ち、route の無い pool は出さない", async () => {
    const menu = [
      ...MENU,
      {
        protocol_id: "nowhere",
        display_name: "Nowhere",
        primary_category: "lending",
        supported_assets: ["USDC"],
        icon_id: "x",
        icon_bg: "#000",
        pools: [
          // APY 最高だが lib の resolveSolanaRoute に解決しない (execute できない)
          { pool_id: "nowhere_usdc", name: "USDC", category: "lending", asset: "USDC", apy: 0.99, tvl_usd: 1e9 },
        ],
      },
      {
        protocol_id: "meteora",
        display_name: "Meteora",
        primary_category: "lp",
        supported_assets: ["USDC"],
        icon_id: "meteora",
        icon_bg: "#000",
        pools: [
          {
            pool_id: "meteora_usdc_usdt_dlmm",
            name: "USDC-USDT",
            category: "lp",
            asset: "USDC-USDT",
            deposit_asset: "USDC",
            apy: 0.2,
            tvl_usd: 1_000_000,
          },
        ],
      },
    ];
    const { client } = await connect(
      fakeBff({ "/menu-listings": () => menu, "/agent-plans": () => ({ plan_id: "p5" }) })
    );
    const out = textOf(
      await client.callTool({ name: "compare_opportunities", arguments: { objective: "max_yield", asset: "USDC" } })
    ) as { ranked_candidates: Record<string, unknown>[] };
    const ids = out.ranked_candidates.map((c) => c.market_id);
    expect(ids).not.toContain("nowhere_usdc");
    expect(ids).toEqual(["savefi_usdc_main", "meteora_usdc_usdt_dlmm", "kamino_usdc_main"]);
    const kamino = out.ranked_candidates.find((c) => c.market_id === "kamino_usdc_main")!;
    expect(kamino).toMatchObject({
      action_spec_template: {
        action_type: "deposit",
        protocol: "kamino",
        asset: "USDC",
        metadata: { pool_id: "kamino_usdc_main" },
      },
      route_kind: "kamino_deposit",
      amount_decimals: 6,
      amount_unit: "USDC",
    });
    // 雛形に amount は入れない (空文字は simulate_action の §4.5 検証で落ちる)
    expect("amount" in (kamino.action_spec_template as object)).toBe(false);
    // LP は deposit_asset 建て
    const met = out.ranked_candidates.find((c) => c.market_id === "meteora_usdc_usdt_dlmm")!;
    expect(met).toMatchObject({ route_kind: "meteora_deposit", amount_unit: "USDC" });
    expect((met.action_spec_template as { asset: string }).asset).toBe("USDC");
  });

  it("simulate_action: metadata を BFF へそのまま渡し、見積りと status を返す", async () => {
    let sent: unknown;
    const { client } = await connect(
      fakeBff({
        "/agent-plans/p1/simulate": (body) => {
          sent = body;
          return {
            plan_id: "p1",
            simulation: {
              simulation_id: "sim_1",
              estimate_kind: "exchange_rate",
              estimated_out: "2000000",
              estimated_out_symbol: "Allez SOL shares",
              estimated_out_decimals: 6,
              bundle_hash: "0xdef",
              oracle: { primary: "pyth", primary_age_seconds: 3, warnings: ["oracle_secondary_stale"] },
              metadata: { tokens_per_share: "1.25" },
            },
          };
        },
      })
    );
    const action_spec = {
      wallet_id: "W",
      action_type: "deposit",
      protocol: "kamino",
      asset: "SOL",
      amount: "2500000000",
      metadata: { pool_id: "kamino_allez_sol_vault" },
    };
    const out = textOf(
      await client.callTool({ name: "simulate_action", arguments: { plan_id: "p1", action_spec } })
    );
    expect(sent).toEqual({ action_spec });
    expect(out).toEqual({
      simulation_id: "sim_1",
      plan_id: "p1",
      status: "ok",
      estimate_kind: "exchange_rate",
      estimated_out: "2000000",
      estimated_out_symbol: "Allez SOL shares",
      estimated_out_decimals: 6,
      warnings: [],
      oracle_warnings: ["oracle_secondary_stale"],
      bundle_hash: "0xdef",
    });

    // withdraw の metadata (seasonals://positions の position から写した形) も通る
    const withdraw = {
      wallet_id: "W",
      action_type: "withdraw",
      protocol: "kamino",
      asset: "SOL",
      amount: "2000000",
      metadata: {
        share_mint: "A1so1bPD3W1TfeFwboDh8yfAAVaVtcdAYBYCjhg2mJQ",
        share_decimals: 6,
        underlying_decimals: 9,
        underlying_amount: "2500000000",
      },
    };
    const ok = await client.callTool({ name: "simulate_action", arguments: { plan_id: "p1", action_spec: withdraw } });
    expect(ok.isError).toBeFalsy();
    expect(sent).toEqual({ action_spec: withdraw });
  });

  it("simulate_action: 未知の metadata key / base58 でない share_mint / 不正 pool_id は zod で拒否 (BFF を呼ばない)", async () => {
    const called = jest.fn();
    const { client } = await connect(fakeBff({ "/agent-plans/p1/simulate": called }));
    const base = { wallet_id: "W", action_type: "deposit", protocol: "kamino", asset: "USDC", amount: "1" };
    for (const metadata of [
      { pool_id: "kamino_usdc_main", slippage_bps: 9999 },
      { share_mint: "0OIl-not-base58" },
      { pool_id: "Kamino USDC" },
      { share_decimals: 6.5 },
      { underlying_amount: "1.5" },
    ]) {
      const res = await client.callTool({
        name: "simulate_action",
        arguments: { plan_id: "p1", action_spec: { ...base, metadata } },
      });
      expect(res.isError).toBe(true);
    }
    expect(called).not.toHaveBeenCalled();
  });

  it("simulate_action: failure_reason があれば status failed", async () => {
    const { client } = await connect(
      fakeBff({
        "/agent-plans/p1/simulate": () => ({
          plan_id: "p1",
          simulation: {
            simulation_id: "sim_2",
            estimate_kind: "none",
            failure_reason: "asset_mismatch",
            bundle_hash: "0x1",
            metadata: { oracle_warnings: ["oracle_pyth_stale"] },
          },
        }),
      })
    );
    const out = textOf(
      await client.callTool({
        name: "simulate_action",
        arguments: {
          plan_id: "p1",
          action_spec: {
            wallet_id: "W",
            action_type: "deposit",
            protocol: "kamino",
            asset: "USDC",
            amount: "1000000",
            metadata: { pool_id: "kamino_sol_main" },
          },
        },
      })
    ) as Record<string, unknown>;
    expect(out).toMatchObject({
      status: "failed",
      estimate_kind: "none",
      failure_reason: "asset_mismatch",
      warnings: [],
      oracle_warnings: ["oracle_pyth_stale"],
    });
    expect(out.estimated_out).toBeUndefined();
  });

  it("request_user_approval: 422 simulation_failed は poll せず理由を返す", async () => {
    const polled = jest.fn();
    const { client } = await connect({
      get: async () => {
        polled();
        return {} as never;
      },
      post: async () => {
        throw new BffHttpError(422, { error: "simulation_failed", failure_reason: "unsupported_market", plan_id: "p6" });
      },
    });
    const out = textOf(
      await client.callTool({ name: "request_user_approval", arguments: { plan_id: "p6", timeout_seconds: 5 } })
    ) as { status: string; failure_reason: string };
    expect(out).toMatchObject({ status: "simulation_failed", failure_reason: "unsupported_market" });
    expect(polled).not.toHaveBeenCalled();
  });

  it("request_user_approval: web で approve → 署名中 → broadcasted まで待って signatures を返す", async () => {
    const SIG = "5".repeat(88);
    const states = [
      { plan_id: "p1", status: "pending_user", approved_by: null },
      { plan_id: "p1", status: "approved", approved_by: "user" }, // 人の承認: token は出ない
      { plan_id: "p1", status: "executing", approved_by: "user" }, // web で署名中
      {
        plan_id: "p1",
        status: "broadcasted",
        approved_by: "user",
        execution: {
          execution_id: "exec_p1",
          signatures: [SIG],
          submitted_at: "2026-10-06T00:00:00.000Z",
          via: "web",
        },
      },
    ];
    let calls = 0;
    const { client } = await connect(
      fakeBff({
        "/agent-plans/p1/request-approval": () => ({ status: "pending_user" }),
        "/agent-plans/p1/approval": () => states[Math.min(calls++, states.length - 1)],
      })
    );
    const out = textOf(
      await client.callTool({
        name: "request_user_approval",
        arguments: { plan_id: "p1", timeout_seconds: 5 },
      })
    ) as { status: string; signatures: string[]; via: string };
    expect(calls).toBe(4); // approved / executing では返らず待ち続けた
    expect(out.status).toBe("broadcasted");
    expect(out.signatures).toEqual([SIG]);
    expect(out.via).toBe("web");
  });

  it("request_user_approval: auto 承認は token を返す (autonomous 経路)", async () => {
    const { client } = await connect(
      fakeBff({
        "/agent-plans/pa/request-approval": () => ({ status: "approved" }),
        "/agent-plans/pa/approval": () => ({
          plan_id: "pa",
          status: "approved",
          approved_by: "auto",
          approval_token: { token_id: "tok_auto", expires_at: "2026-10-06T00:05:00.000Z" },
        }),
      })
    );
    const out = textOf(
      await client.callTool({
        name: "request_user_approval",
        arguments: { plan_id: "pa", timeout_seconds: 5 },
      })
    ) as { status: string; approval_token: string; approved_by: string };
    expect(out).toMatchObject({ status: "approved", approved_by: "auto", approval_token: "tok_auto" });
  });

  it("request_user_approval: failed / rejected / expired は理由付きで返す、未決は timeout", async () => {
    for (const [status, reason] of [
      ["failed", "user_cancelled"],
      ["rejected", "user_declined"],
      ["expired", undefined],
    ] as const) {
      const { client } = await connect(
        fakeBff({
          "/agent-plans/p2/request-approval": () => ({}),
          "/agent-plans/p2/approval": () => ({
            plan_id: "p2",
            status,
            approved_by: status === "failed" ? "user" : null,
            ...(reason ? { failure_reason: reason } : {}),
          }),
        })
      );
      const out = textOf(
        await client.callTool({
          name: "request_user_approval",
          arguments: { plan_id: "p2", timeout_seconds: 5 },
        })
      ) as { status: string; failure_reason?: string };
      expect(out.status).toBe(status);
      expect(out.failure_reason).toBe(reason);
    }

    const t = await connect(
      fakeBff({
        "/agent-plans/p3/request-approval": () => ({}),
        "/agent-plans/p3/approval": () => ({
          plan_id: "p3",
          status: "approved",
          approved_by: "user", // 人が承認したが web でまだ署名していない
        }),
      })
    );
    const out = textOf(
      await t.client.callTool({
        name: "request_user_approval",
        arguments: { plan_id: "p3", timeout_seconds: 1 },
      })
    ) as { status: string; last_status: string };
    expect(out).toEqual({ status: "timeout", last_status: "approved" });
  }, 15000);

  it("request_user_approval: 既に approved の plan への再呼び出し (request-approval 409) も poll に進む", async () => {
    const { client } = await connect({
      get: async () =>
        ({
          plan_id: "p4",
          status: "broadcasted",
          approved_by: "user",
          execution: { execution_id: "e", signatures: ["S"], submitted_at: "t", via: "web" },
        }) as never,
      post: async () => {
        throw new BffHttpError(409, { error: "invalid_status_transition", current: "executing" });
      },
    });
    const out = textOf(
      await client.callTool({
        name: "request_user_approval",
        arguments: { plan_id: "p4", timeout_seconds: 5 },
      })
    ) as { status: string; signatures: string[] };
    expect(out).toMatchObject({ status: "broadcasted", signatures: ["S"] });
  });

  it("execute_approved_action: 人が承認した plan は /execute を呼ばず awaiting_user_signature", async () => {
    const executed = jest.fn();
    const { client } = await connect(
      fakeBff({
        "/agent-plans/p1/approval": () => ({
          plan_id: "p1",
          status: "approved",
          approved_by: "user",
        }),
        "/agent-plans/p1/execute": executed,
      })
    );
    const out = textOf(
      await client.callTool({
        name: "execute_approved_action",
        arguments: { plan_id: "p1", approval_token: "tok_1" },
      })
    ) as { status: string; message: string };
    expect(out.status).toBe("awaiting_user_signature");
    expect(out.message).toMatch(/Seasonals web app/);
    expect(executed).not.toHaveBeenCalled();
  });

  it("execute_approved_action: auto 承認の plan は unsigned tx を透過 (署名は受け取らない)", async () => {
    let sentBody: unknown;
    const { client } = await connect(
      fakeBff({
        "/agent-plans/pa/approval": () => ({
          plan_id: "pa",
          status: "approved",
          approved_by: "auto",
          approval_token: { token_id: "tok_auto" },
        }),
        "/agent-plans/pa/execute": (body) => {
          sentBody = body;
          return {
            execution_id: "exec_pa",
            status: "awaiting_signature",
            plan: {},
            unsigned_transactions: [{ index: 0, label: "deposit", tx_base64: "TX" }],
          };
        },
      })
    );
    const out = textOf(
      await client.callTool({
        name: "execute_approved_action",
        arguments: { plan_id: "pa", approval_token: "tok_auto" },
      })
    ) as { status: string; unsigned_transactions: { tx_base64: string }[] };
    expect(sentBody).toEqual({ approval_token: "tok_auto", via: "autonomous" });
    expect(out.status).toBe("awaiting_signature");
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
