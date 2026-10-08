/**
 * R0-07 (docs/skr-r0-implementation.md §4 / §6): MCP は SKR cooldown を event だけ公開する。
 * - 同じ fixture から Mobile (fromDTO → toDTO) と MCP の event が一致
 * - fresh のみ公開、stale / 失敗は SKR event 0 件 + 補足文
 * - actions 空 / positionRef null、positions resource と実行候補に SKR は 0 件
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FIXTURE_SKR_WALLET,
  fixtureCooldownStateCoolingDown,
  fixtureCooldownStateDemoCoolingDown,
  fixtureCooldownStateNone,
  fixtureCooldownStateUnavailable,
  fixtureCooldownStateUnsupported,
} from "@workspace/lib/__fixtures__";
import { fromDTO, toDTO, type CooldownSource, type UnifiedTimeEventDTO } from "@workspace/lib/types";

import type { BffClient } from "./bff-client";
import { buildMcpServer } from "./server";

const W = FIXTURE_SKR_WALLET;
const BASE_PATH = `/time-events/wallet?wallet=${W}`;
const SKR_LIVE = `/protocols/skr-staking/state?wallet=${W}&source=live`;
const SKR_DEMO = `/protocols/skr-staking/state?wallet=${W}&source=demo`;

const BASE_EVENT: UnifiedTimeEventDTO = {
  id: "lockup_end_solana_Stake111",
  protocol: "solana",
  category: "lockup_end",
  triggerAt: "2026-10-10T00:00:00.000Z",
  urgency: "info",
  walletAddress: W,
  positionRef: "Stake111",
  actions: [],
  agentReadable: true,
  metadata: {},
};

type Handler = () => unknown;

function fakeBff(routes: Record<string, Handler>, calls: string[] = []): BffClient {
  const lookup = (path: string): Handler => {
    calls.push(path);
    const h = routes[path];
    if (!h) throw new Error(`fakeBff: unhandled ${path}`);
    return h;
  };
  return {
    get: async (path) => lookup(path)() as never,
    post: async (path) => lookup(path)() as never,
  };
}

async function connect(bff: BffClient, skrSource: CooldownSource = "live") {
  const server = buildMcpServer(bff, { pollIntervalMs: 5, skrSource });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function readEvents(client: Client) {
  const res = await client.readResource({ uri: `seasonals://events/${W}` });
  const contents = res.contents as { mimeType?: string; text: string }[];
  return {
    events: JSON.parse(contents[0]!.text) as UnifiedTimeEventDTO[],
    note: contents[1]?.text ?? null,
    noteMime: contents[1]?.mimeType ?? null,
    count: contents.length,
  };
}

describe("seasonals://events/{wallet} の SKR 投影", () => {
  it("fresh: BFF の event をそのまま追加し、Mobile の fromDTO → toDTO と一致", async () => {
    const client = await connect(
      fakeBff({ [BASE_PATH]: () => [BASE_EVENT], [SKR_LIVE]: () => fixtureCooldownStateCoolingDown })
    );
    const { events, count } = await readEvents(client);
    expect(count).toBe(1);
    expect(events.map((e) => e.id)).toEqual([BASE_EVENT.id, fixtureCooldownStateCoolingDown.events[0]!.event.id]);

    const skr = events[1]!;
    const fromBff = fixtureCooldownStateCoolingDown.events[0]!.event;
    expect(skr).toEqual(fromBff);
    // Mobile は wrapper.event を fromDTO で Calendar に渡す。往復しても MCP と同じ値
    expect(toDTO(fromDTO(fromBff))).toEqual(skr);
    expect(skr.actions).toEqual([]);
    expect(skr.positionRef).toBeNull();
    expect(skr.agentReadable).toBe(true);
  });

  it("既存 event と同じ id は重複させない", async () => {
    const dup = fixtureCooldownStateCoolingDown.events[0]!.event;
    const client = await connect(
      fakeBff({ [BASE_PATH]: () => [dup], [SKR_LIVE]: () => fixtureCooldownStateCoolingDown })
    );
    const { events } = await readEvents(client);
    expect(events.filter((e) => e.id === dup.id)).toHaveLength(1);
  });

  it("pending なし (fresh で event 0) は追加なし・補足なし", async () => {
    const client = await connect(fakeBff({ [BASE_PATH]: () => [BASE_EVENT], [SKR_LIVE]: () => fixtureCooldownStateNone }));
    const { events, count } = await readEvents(client);
    expect(events.map((e) => e.id)).toEqual([BASE_EVENT.id]);
    expect(count).toBe(1);
  });

  it.each([
    ["unavailable", () => fixtureCooldownStateUnavailable, "skr_staking events omitted: unavailable"],
    ["unsupported", () => fixtureCooldownStateUnsupported, "skr_staking events omitted: unsupported"],
    ["形の不正", () => ({ data_status: "fresh", events: [{ event: { id: "x" } }] }), "skr_staking events omitted: invalid_response"],
    [
      "別 wallet の応答",
      () => ({ ...fixtureCooldownStateCoolingDown, wallet_address: "9hQpJ4xRwY7nKsT2bGvCmHdEq6jPzN5fLrXk3aBoMyVc" }),
      "skr_staking events omitted: scope_mismatch",
    ],
  ] as const)("%s → SKR event 0 件 + 補足文", async (_label, skr, note) => {
    const client = await connect(fakeBff({ [BASE_PATH]: () => [BASE_EVENT], [SKR_LIVE]: skr }));
    const r = await readEvents(client);
    expect(r.events.map((e) => e.id)).toEqual([BASE_EVENT.id]);
    expect(r.note).toBe(note);
    expect(r.noteMime).toBe("text/plain");
  });

  it("SKR の取得失敗 (BFF error) は補足文のみ。既存 event は返す", async () => {
    const client = await connect(fakeBff({ [BASE_PATH]: () => [BASE_EVENT] }));
    const r = await readEvents(client);
    expect(r.events.map((e) => e.id)).toEqual([BASE_EVENT.id]);
    expect(r.note).toBe("skr_staking events omitted: fetch_failed");
  });

  it("既存 events の取得失敗は従来どおり error (SKR だけで返さない)", async () => {
    const client = await connect(fakeBff({ [SKR_LIVE]: () => fixtureCooldownStateCoolingDown }));
    await expect(client.readResource({ uri: `seasonals://events/${W}` })).rejects.toThrow();
  });

  it("skrSource=demo の時だけ demo を読む (live の失敗を demo に差し替えない)", async () => {
    const calls: string[] = [];
    const client = await connect(
      fakeBff({ [BASE_PATH]: () => [], [SKR_DEMO]: () => fixtureCooldownStateDemoCoolingDown }, calls),
      "demo"
    );
    const { events } = await readEvents(client);
    expect(calls).toContain(SKR_DEMO);
    expect(calls).not.toContain(SKR_LIVE);
    expect(events[0]?.metadata.source).toBe("demo");

    const liveCalls: string[] = [];
    const liveClient = await connect(fakeBff({ [BASE_PATH]: () => [], [SKR_DEMO]: () => fixtureCooldownStateDemoCoolingDown }, liveCalls));
    const live = await readEvents(liveClient);
    expect(liveCalls).not.toContain(SKR_DEMO);
    expect(live.events).toEqual([]);
    expect(live.note).toBe("skr_staking events omitted: fetch_failed");
  });
});

describe("SKR は positions と実行候補に出ない", () => {
  it("positions resource は SKR 口を呼ばず、skr_staking を含まない", async () => {
    const calls: string[] = [];
    const client = await connect(
      fakeBff(
        {
          [`/positions/earn?wallet=${W}`]: () => ({ jupiterLend: [], kaminoBestEffort: [] }),
          [SKR_LIVE]: () => fixtureCooldownStateCoolingDown,
        },
        calls
      )
    );
    const res = await client.readResource({ uri: `seasonals://positions/${W}` });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).not.toContain("skr_staking");
    expect(calls.some((c) => c.includes("skr-staking"))).toBe(false);
  });

  it("compare_opportunities の候補は menu だけから作り、SKR を含まない", async () => {
    const calls: string[] = [];
    const client = await connect(
      fakeBff(
        {
          "/menu-listings": () => [
            {
              protocol_id: "kamino",
              display_name: "Kamino",
              primary_category: "lending",
              supported_assets: ["USDC"],
              icon_id: "kamino",
              icon_bg: "#000",
              pools: [
                { pool_id: "kamino_usdc_main", name: "USDC Main", category: "lending", asset: "USDC", apy: 0.045, tvl_usd: 1e8, utilization: 0.5 },
              ],
            },
          ],
          "/agent-plans": () => ({ plan_id: "p_skr", status: "draft" }),
          [SKR_LIVE]: () => fixtureCooldownStateCoolingDown,
        },
        calls
      )
    );
    const res = await client.callTool({ name: "compare_opportunities", arguments: { objective: "max_yield", asset: "USDC" } });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).not.toContain("skr_staking");
    expect(calls.some((c) => c.includes("skr-staking"))).toBe(false);
  });
});
