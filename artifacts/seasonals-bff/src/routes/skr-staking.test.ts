/**
 * GET /protocols/skr-staking/state の検査 (docs/skr-r0-implementation.md §3 / §6 R0-01・R0-02 の route 部分)
 */
import Fastify, { type FastifyInstance } from "fastify";
import {
  FIXTURE_SKR_OBSERVED_AT,
  FIXTURE_SKR_POSITION_ACCOUNT,
  FIXTURE_SKR_WALLET,
  fixtureCooldownStateCoolingDown,
} from "@workspace/lib/__fixtures__";
import { isCooldownStateResponse, type CooldownStateResponse } from "@workspace/lib/types";
import { buildServer } from "../server";
import { registerSkrStakingRoutes } from "./skr-staking";
import { SKR_DEMO_PENDING, skrDemoOptionsFromEnv, type SkrDemoOptions } from "../clients/skr-staking-demo";
import { referenceAccounts, referenceClockFields, clockAccount, encodeUserStake, programAccount } from "../clients/skr-staking-encode";
import type { SkrRpc } from "../clients/skr-staking";
import { SKR_GUARDIAN_POOL, SKR_STAKE_CONFIG } from "@workspace/lib/config/skr-staking";

const URL = "/protocols/skr-staking/state";
const T0 = Date.parse("2026-10-05T12:00:00.000Z");

/** lib fixture (cooling_down) と同じ bytes を返す live RPC */
function fixtureLiveRpc(): SkrRpc {
  const r = referenceAccounts();
  return {
    async getMultipleAccounts() {
      return {
        slot: fixtureCooldownStateCoolingDown.slot!,
        accounts: [
          r.config,
          r.pool,
          programAccount(
            encodeUserStake({
              stake_config: SKR_STAKE_CONFIG,
              user: FIXTURE_SKR_WALLET,
              guardian_pool: SKR_GUARDIAN_POOL,
              shares: BigInt(fixtureCooldownStateCoolingDown.position!.shares!),
              unstaking_amount: BigInt(fixtureCooldownStateCoolingDown.position!.pending_amount!),
              unstake_timestamp: BigInt(fixtureCooldownStateCoolingDown.position!.unstake_timestamp!),
            })
          ),
          r.vault,
          r.mint,
          clockAccount({ ...referenceClockFields(), unix_timestamp: BigInt(fixtureCooldownStateCoolingDown.chain_time!) }),
        ],
      };
    },
    async getTokenAmountsByOwner() {
      return { slot: fixtureCooldownStateCoolingDown.liquid.slot!, amounts: [fixtureCooldownStateCoolingDown.liquid.amount!] };
    },
  };
}

async function appWith(opts: {
  liveRpc?: () => SkrRpc;
  demo?: SkrDemoOptions;
  demoEnabled?: boolean;
  now?: () => Date;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerSkrStakingRoutes(app, {
    liveRpc: opts.liveRpc,
    demo: opts.demo,
    demoEnabled: () => opts.demoEnabled ?? false,
    now: opts.now,
  });
  return app;
}

/** 呼ばれるたびに 5 秒進む時計 */
function demoOpts(over: Partial<SkrDemoOptions> = {}): SkrDemoOptions {
  let now = T0;
  return {
    scenario: "cooling_down",
    unlockInSeconds: 1800,
    anchorMs: T0,
    now: () => (now += 5_000),
    ...over,
  };
}

describe("入力検証 (400)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await appWith({ liveRpc: fixtureLiveRpc });
  });
  afterAll(() => app.close());

  it.each([
    ["wallet 無し", "", "wallet_required"],
    ["base58 でない", "?wallet=0OIl000000000000000000000000000000", "invalid_wallet_address"],
    ["短すぎる", "?wallet=abc", "invalid_wallet_address"],
    ["32 byte にならない base58", `?wallet=${"1".repeat(44)}`, "invalid_wallet_address"],
    ["source が不正", `?wallet=${FIXTURE_SKR_WALLET}&source=fixture`, "invalid_source"],
    ["demo が無効な時の demo", `?wallet=${FIXTURE_SKR_WALLET}&source=demo`, "demo_source_disabled"],
  ])("%s → 400 %s", async (_label, qs, error) => {
    const res = await app.inject({ method: "GET", url: `${URL}${qs}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("live", () => {
  it("fresh: 200 / no-store / lib fixture と同じ body", async () => {
    const app = await appWith({ liveRpc: fixtureLiveRpc, now: () => new Date(FIXTURE_SKR_OBSERVED_AT) });
    const res = await app.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as CooldownStateResponse;
    expect(isCooldownStateResponse(body)).toBe(true);
    expect(body).toEqual(fixtureCooldownStateCoolingDown);
    await app.close();
  });

  it("RPC 失敗は 200 + unavailable (HTTP error にしない、demo に差し替えない)", async () => {
    const failing: SkrRpc = {
      getMultipleAccounts: async () => {
        throw new Error("down");
      },
      getTokenAmountsByOwner: async () => {
        throw new Error("down");
      },
    };
    const app = await appWith({ liveRpc: () => failing, demoEnabled: true, demo: demoOpts() });
    const res = await app.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}&source=live` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CooldownStateResponse;
    expect(body.data_status).toBe("unavailable");
    expect(body.source).toBe("live");
    expect(body.events).toEqual([]);
    await app.close();
  });

  it("buildServer に登録済み。HELIUS_API_KEY が無ければ外部 fetch せず unavailable", async () => {
    const old = process.env.HELIUS_API_KEY;
    delete process.env.HELIUS_API_KEY;
    const spy = jest.spyOn(global, "fetch");
    try {
      const app = await buildServer({ logger: false });
      const res = await app.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json().data_status).toBe("unavailable");
      expect(res.json().position_account).toBe(FIXTURE_SKR_POSITION_ACCOUNT);
      expect(spy).not.toHaveBeenCalled();
      await app.close();
    } finally {
      spy.mockRestore();
      process.env.HELIUS_API_KEY = old;
    }
  });
});

describe("demo source", () => {
  it("cooling_down: source=demo、終了予定は anchor + unlockInSeconds、cooldown は config bytes の値", async () => {
    const app = await appWith({ demoEnabled: true, demo: demoOpts() });
    const res = await app.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}&source=demo` });
    const body = res.json() as CooldownStateResponse;
    expect(res.statusCode).toBe(200);
    expect(isCooldownStateResponse(body)).toBe(true);
    expect(body.source).toBe("demo");
    expect(body.cluster).toBe("mainnet-beta");
    expect(body.data_status).toBe("fresh");
    expect(body.position?.pending_status).toBe("cooling_down");
    expect(body.position?.pending_amount).toBe(SKR_DEMO_PENDING.toString());
    expect(body.position?.cooldown_seconds).toBe("172800");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.event.triggerAt).toBe(new Date(T0 + 1800_000).toISOString());
    expect(body.events[0]?.event.id).toBe(
      `lockup_end:mainnet-beta:skr_staking:${FIXTURE_SKR_WALLET}:${FIXTURE_SKR_POSITION_ACCOUNT}`
    );
    expect(body.events[0]?.event.metadata.source).toBe("demo");
    await app.close();
  });

  it("poll しても予定キーは不変、slot は単調増加", async () => {
    const app = await appWith({ demoEnabled: true, demo: demoOpts() });
    const get = async () =>
      (await app.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}&source=demo` })).json() as CooldownStateResponse;
    const a = await get();
    const b = await get();
    expect(b.events[0]?.schedule_revision).toBe(a.events[0]?.schedule_revision);
    expect(b.slot!).toBeGreaterThan(a.slot!);
    await app.close();
  });

  it("unlockInSeconds を変えて再起動 = 追加解除: 同じ id、新しい revision と triggerAt", async () => {
    const a = await appWith({ demoEnabled: true, demo: demoOpts({ unlockInSeconds: 1800 }) });
    const b = await appWith({ demoEnabled: true, demo: demoOpts({ unlockInSeconds: 3600 }) });
    const first = (await a.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}&source=demo` })).json() as CooldownStateResponse;
    const second = (await b.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}&source=demo` })).json() as CooldownStateResponse;
    expect(second.events[0]?.event.id).toBe(first.events[0]?.event.id);
    expect(second.events[0]?.schedule_revision).not.toBe(first.events[0]?.schedule_revision);
    expect(Date.parse(second.events[0]!.event.triggerAt) - Date.parse(first.events[0]!.event.triggerAt)).toBe(1800_000);
    await a.close();
    await b.close();
  });

  it.each([
    ["ready", { pending: "ready", events: 1 }],
    ["none", { pending: "none", events: 0 }],
    ["absent", { pending: null, events: 0 }],
  ] as const)("scenario %s", async (scenario, expected) => {
    const app = await appWith({ demoEnabled: true, demo: demoOpts({ scenario }) });
    const body = (await app.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}&source=demo` })).json() as CooldownStateResponse;
    expect(body.data_status).toBe("fresh");
    expect(body.position?.pending_status ?? null).toBe(expected.pending);
    expect(body.events).toHaveLength(expected.events);
    await app.close();
  });

  it("scenario unsupported は検証で落ちる (demo も live と同じ検査経路)", async () => {
    const app = await appWith({ demoEnabled: true, demo: demoOpts({ scenario: "unsupported" }) });
    const body = (await app.inject({ method: "GET", url: `${URL}?wallet=${FIXTURE_SKR_WALLET}&source=demo` })).json() as CooldownStateResponse;
    expect(body.data_status).toBe("unsupported");
    expect(body.position).toBeNull();
    await app.close();
  });

  it("env からの設定: 不正値は既定値 (cooling_down / 1800 秒)", () => {
    const o = skrDemoOptionsFromEnv({ SKR_DEMO_SCENARIO: "boom", SKR_DEMO_UNLOCK_IN_SECONDS: "-5" }, T0);
    expect(o.scenario).toBe("cooling_down");
    expect(o.unlockInSeconds).toBe(1800);
    const p = skrDemoOptionsFromEnv({ SKR_DEMO_SCENARIO: "ready", SKR_DEMO_UNLOCK_IN_SECONDS: "120" }, T0);
    expect(p.scenario).toBe("ready");
    expect(p.unlockInSeconds).toBe(120);
  });
});
