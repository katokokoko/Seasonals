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

function bff(): BffClient & { posts: unknown[] } {
  const posts: unknown[] = [];
  return {
    posts,
    get: async (path: string) => {
      if (path === `/eth/events?address=${OWNER}`)
        return { events: [ev("past", -2, true), ev("future", 48, false), ev("pending", null, false)], sources: [{ source: "lido", ok: true, observedAt: "" }] } as never;
      if (path.startsWith("/eth/proposal")) return { eventId: "past", generator: "rule-based" } as never;
      throw new Error(`unhandled ${path}`);
    },
    post: async (path: string, body?: unknown) => {
      posts.push({ path, body });
      return { broadcast: false, steps: [] } as never;
    },
  };
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

test("toIcal emits one VEVENT per dated event", () => {
  const ics = toIcal([ev("a", 1, true), ev("b", null, false)]);
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(ics).toContain("UID:a@seasonals");
  expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
});
