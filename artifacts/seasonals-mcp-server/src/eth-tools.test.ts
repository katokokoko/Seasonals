import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TimelineEvent } from "@workspace/lib/types";
import { buildMcpServer, toIcal } from "./server";
import type { BffClient } from "./bff-client";

const OWNER = "0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5";
const now = Date.now();
const ev = (id: string, atOffsetH: number | null, available: boolean): TimelineEvent => ({
  id,
  chain: "ethereum",
  class: "protocol",
  kind: "withdrawal_claimable",
  protocol: "lido",
  protocolName: "Lido",
  title: `Event ${id}`,
  at: atOffsetH === null ? null : new Date(now + atOffsetH * 3_600_000).toISOString(),
  atApprox: false,
  settled: false,
  metrics: [],
  actions: [{ actionType: "lido_claim", label: "Claim ETH", requiresWallet: true, availability: available ? "available" : "not_yet", params: {} }],
  requiresWallet: true,
  owner: OWNER,
  links: [],
  source: "lido.withdrawalQueue",
  observedAt: new Date(now).toISOString(),
});

const HASH = `0x${"ab".repeat(32)}`;
function bff(): BffClient & { posts: unknown[]; proposalStatus: string; gets: string[] } {
  const posts: unknown[] = [];
  const gets: string[] = [];
  const self = {
    posts,
    gets,
    proposalStatus: "pending",
    get: async (path: string) => {
      gets.push(path);
      if (path === `/eth/events?address=${OWNER}`)
        return { events: [ev("past", -2, true), ev("future", 48, false), ev("pending", null, false)], sources: [{ source: "lido", ok: true, observedAt: "" }] } as never;
      if (path.startsWith("/eth/proposal")) return { eventId: "past", generator: "rule-based" } as never;
      if (path === "/eth/menu") return [{ id: "ethereum:ethena:susde", rate: { value: 0.05 } }] as never;
      if (path.startsWith("/eth/holdings")) return { address: OWNER, holdings: [], spendable: [], failed: [] } as never;
      if (path === "/eth/status") return { executionTarget: "fork", forkReachable: true } as never;
      if (path === "/eth/agent-proposals/ethprop_1") return { id: "ethprop_1", status: self.proposalStatus, bundleHash: HASH } as never;
      throw new Error(`unhandled ${path}`);
    },
    post: async (path: string, body?: unknown) => {
      posts.push({ path, body });
      if (path === "/eth/agent-proposals/brief") return { ...(body as object), previews: [], brief: { name: (body as { name: string }).name, markdown: "# brief" } } as never;
      if (path === "/eth/agent-proposals") return { id: "ethprop_1", status: "pending", bundleHash: HASH, ...(body as object), brief: { markdown: "# brief" } } as never;
      if (path.endsWith("/execute")) return { id: "ethprop_1", status: "executed", bundleHash: HASH } as never;
      return { broadcast: false, steps: [] } as never;
    },
  };
  return self;
}

async function connect(b: BffClient) {
  const server = buildMcpServer(b, { pollIntervalMs: 5 });
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

test("list_events derives status and filters by status / range", async () => {
  const client = await connect(bff());
  const all = text(await client.callTool({ name: "list_events", arguments: { address: OWNER } }));
  expect(all.events.map((e: { id: string; status: string }) => [e.id, e.status])).toEqual([
    ["past", "due"],
    ["future", "upcoming"],
    ["pending", "upcoming"],
  ]);
  const due = text(await client.callTool({ name: "list_events", arguments: { address: OWNER, status: "due" } }));
  expect(due.events.map((e: { id: string }) => e.id)).toEqual(["past"]);
  const ranged = text(
    await client.callTool({ name: "list_events", arguments: { address: OWNER, from: new Date(now).toISOString(), to: new Date(now + 72 * 3_600_000).toISOString() } })
  );
  expect(ranged.events.map((e: { id: string }) => e.id)).toEqual(["future"]);
});

test("build_action forwards to the BFF and returns an unsigned plan", async () => {
  const b = bff();
  const client = await connect(b);
  const plan = text(await client.callTool({ name: "build_action", arguments: { address: OWNER, eventId: "past", actionType: "lido_claim" } }));
  expect(plan.broadcast).toBe(false);
  expect(b.posts).toEqual([{ path: "/eth/build-action", body: { owner: OWNER, eventId: "past", actionType: "lido_claim" } }]);
});

test("rejects a non-EVM address at the MCP boundary", async () => {
  const client = await connect(bff());
  const r = await client.callTool({ name: "get_proposal", arguments: { address: "nope", eventId: "x" } });
  expect(r.isError).toBe(true);
});

test("list_yield_menu / get_holdings read the same BFF endpoints as the Menu page", async () => {
  const b = bff();
  const client = await connect(b);
  const menu = text(await client.callTool({ name: "list_yield_menu", arguments: {} }));
  expect(menu.products[0].id).toBe("ethereum:ethena:susde");
  const h = text(await client.callTool({ name: "get_holdings", arguments: { address: OWNER } }));
  expect(h).toMatchObject({ address: OWNER, executionTarget: "fork", forkReachable: true });
  expect(b.gets).toEqual(["/eth/menu", `/eth/holdings?address=${OWNER}`, "/eth/status"]);
});

const steps = [
  { kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDe", amount: "100" },
  { kind: "menu", productId: "ethereum:ethena:susde", action: "deposit", amount: "99" },
];

test("preview_rebalance_step / propose_rebalance forward symbol + decimal steps verbatim (conversion happens in the BFF)", async () => {
  const b = bff();
  const client = await connect(b);
  await client.callTool({ name: "preview_rebalance_step", arguments: { address: OWNER, step: steps[0] } });
  const dry = text(await client.callTool({ name: "propose_rebalance", arguments: { address: OWNER, name: "🍋 Lemon Ladder", tagline: "Idle USDC → sUSDe", rationale: "why", steps, dryRun: true } }));
  expect(dry).toMatchObject({ dryRun: true, brief: { name: "🍋 Lemon Ladder", markdown: "# brief" } });
  const p = text(await client.callTool({ name: "propose_rebalance", arguments: { address: OWNER, name: "🍋 Lemon Ladder", rationale: "why", steps } }));
  expect(p).toMatchObject({ id: "ethprop_1", status: "pending", bundleHash: HASH, brief: { markdown: "# brief" } });
  expect(b.posts).toEqual([
    { path: "/eth/agent-proposals/preview", body: { owner: OWNER, step: steps[0] } },
    { path: "/eth/agent-proposals/brief", body: { owner: OWNER, name: "🍋 Lemon Ladder", tagline: "Idle USDC → sUSDe", rationale: "why", steps } },
    { path: "/eth/agent-proposals", body: { owner: OWNER, name: "🍋 Lemon Ladder", rationale: "why", steps } },
  ]);
  const bad = await client.callTool({ name: "propose_rebalance", arguments: { address: OWNER, name: "t", rationale: "r", steps: [{ kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "DAI", amount: "1" }] } });
  expect(bad.isError).toBe(true);
  const aqua = { kind: "aqua_ship", usdc: "40", usde: "40", bandBps: 50, reviewAt: "2026-10-10T00:00:00.000Z" };
  const withAqua = text(await client.callTool({ name: "propose_rebalance", arguments: { address: OWNER, name: "🌊 Aqua Anchor", rationale: "r", steps: [aqua] } }));
  expect(withAqua.steps).toEqual([aqua]);
  const badBand = await client.callTool({ name: "propose_rebalance", arguments: { address: OWNER, name: "🌊 Aqua Anchor", rationale: "r", steps: [{ ...aqua, bandBps: 5 }] } });
  expect(badBand.isError).toBe(true);
});

test("design_rebalance prompt teaches the brief workflow for the address", async () => {
  const client = await connect(bff());
  const prompt = await client.getPrompt({ name: "design_rebalance", arguments: { address: OWNER, goal: "more stable yield" } });
  const textOf = (prompt.messages[0]!.content as { text: string }).text;
  expect(textOf).toContain(OWNER);
  expect(textOf).toContain("more stable yield");
  expect(textOf).toContain("brief.markdown");
  expect(textOf).toContain("dryRun: true");
  expect(textOf).toContain("execute_rebalance");
});

test("wait_for_rebalance_decision polls until the human decided on the web page", async () => {
  const b = bff();
  const client = await connect(b);
  // 承認直後は executing (fork で実行中) → 終端の executed まで待つ
  setTimeout(() => (b.proposalStatus = "executing"), 10);
  setTimeout(() => (b.proposalStatus = "executed"), 40);
  const done = text(await client.callTool({ name: "wait_for_rebalance_decision", arguments: { proposalId: "ethprop_1", timeout_seconds: 5 } }));
  expect(done.status).toBe("executed");
  expect(b.gets.filter((g) => g === "/eth/agent-proposals/ethprop_1").length).toBeGreaterThan(2);
  b.proposalStatus = "pending";
  const timeout = text(await client.callTool({ name: "wait_for_rebalance_decision", arguments: { proposalId: "ethprop_1", timeout_seconds: 1 } }));
  expect(timeout.status).toBe("timeout");
}, 10_000);

test("execute_rebalance sends the user's chat approval with the bundle hash, and refuses without confirmation", async () => {
  const b = bff();
  const client = await connect(b);
  const p = text(await client.callTool({ name: "execute_rebalance", arguments: { proposalId: "ethprop_1", bundleHash: HASH, user_confirmed: true } }));
  expect(p.status).toBe("executed");
  expect(b.posts).toEqual([{ path: "/eth/agent-proposals/ethprop_1/execute", body: { approvedBy: "user", via: "chat", bundleHash: HASH } }]);
  const refused = await client.callTool({ name: "execute_rebalance", arguments: { proposalId: "ethprop_1", bundleHash: HASH, user_confirmed: false } });
  expect(refused.isError).toBe(true);
  expect(b.posts).toHaveLength(1);
});

test("toIcal emits one VEVENT per dated event", () => {
  const ics = toIcal([ev("a", 1, true), ev("b", null, false)]);
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(ics).toContain("UID:a@seasonals");
  expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
});
