/**
 * Cooldown position 共有型の検査 (docs/skr-r0-implementation.md §3 / §5、R0-05 の型部分)
 */
import { fixturePositionKaminoLending } from "../__fixtures__/positions";
import {
  COOLDOWN_REMINDER_PAYLOAD_KEYS,
  CooldownDataStatus,
  CooldownPendingStatus,
  CooldownSource,
  isCooldownDataStatus,
  isCooldownPendingStatus,
  isCooldownPositionView,
  isCooldownReminderPayload,
  isCooldownSource,
  isCooldownStateResponse,
  type CooldownPositionView,
  type CooldownReminderPayload,
  type CooldownStateResponse,
} from "./cooldown-position";
import type { Position } from "./position";

const U128_MAX = ((1n << 128n) - 1n).toString();

function view(over: Partial<CooldownPositionView> = {}): CooldownPositionView {
  return {
    kind: "cooldown_position",
    source: CooldownSource.Live,
    cluster: "mainnet-beta",
    wallet_address: "W1111111111111111111111111111111111111111",
    protocol_id: "skr_staking",
    position_account: "P1111111111111111111111111111111111111111",
    pool: "DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr",
    asset_mint: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
    asset_symbol: "SKR",
    asset_decimals: 6,
    shares: U128_MAX,
    share_price: "1141844787",
    share_price_scale: "1000000000",
    active_amount_estimate: "1141844787",
    pending_amount: "250000000",
    unstake_timestamp: "1789900000",
    cooldown_seconds: "172800",
    unlock_at: "2026-09-22T09:46:40.000Z",
    pending_status: CooldownPendingStatus.CoolingDown,
    data_status: CooldownDataStatus.Fresh,
    observed_at: "2026-09-20T14:21:10.127Z",
    chain_time: "1789914002",
    slot: 448756823,
    principal_amount: null,
    accrued_yield_amount: null,
    unit_price_usd: null,
    unit_price_sol: null,
    deposited_at: null,
    available_actions: [],
    ...over,
  };
}

function response(over: Partial<CooldownStateResponse> = {}): CooldownStateResponse {
  const v = view();
  return {
    schema_version: 1,
    source: v.source,
    cluster: v.cluster,
    wallet_address: v.wallet_address,
    protocol_id: v.protocol_id,
    position_account: v.position_account,
    pool: v.pool,
    commitment: "confirmed",
    observed_at: v.observed_at,
    slot: v.slot,
    chain_time: v.chain_time,
    data_status: CooldownDataStatus.Fresh,
    coverage: "configured_pool_only",
    position: v,
    liquid: { amount: "0", slot: 448756824, observed_at: v.observed_at, data_status: "fresh" },
    events: [
      {
        event: {
          id: `lockup_end:mainnet-beta:skr_staking:${v.wallet_address}:${v.position_account}`,
          protocol: "skr_staking",
          category: "lockup_end",
          triggerAt: "2026-09-22T09:46:40.000Z",
          urgency: "watch",
          walletAddress: v.wallet_address,
          positionRef: null,
          actions: [],
          agentReadable: true,
          metadata: { source: "live", observed_at: v.observed_at, slot: v.slot, pending_status: "cooling_down" },
        },
        schedule_revision: "v1:1789900000:172800",
      },
    ],
    ...over,
  };
}

describe("enum guards", () => {
  it("正しい値だけ通す", () => {
    expect(isCooldownPendingStatus("cooling_down")).toBe(true);
    expect(isCooldownPendingStatus("cooldown")).toBe(false);
    expect(isCooldownDataStatus("fresh")).toBe(true);
    expect(isCooldownDataStatus("stale")).toBe(false);
    expect(isCooldownSource("demo")).toBe(true);
    expect(isCooldownSource("fixture")).toBe(false);
  });
});

describe("CooldownPositionView は Position と互いに代入できない (ゼロ埋め・cast の混入防止)", () => {
  it("型レベル", () => {
    const v = view();
    // @ts-expect-error — 専用 view を既存 Position として扱えない (元本・価格が null)
    const asPosition: Position = v;
    // @ts-expect-error — 既存 Position を cooldown view として扱えない (kind が無い)
    const asView: CooldownPositionView = fixturePositionKaminoLending;
    expect(asPosition).toBeDefined();
    expect(asView).toBeDefined();
  });

  it("runtime guard も既存 Position を拒否する", () => {
    expect(isCooldownPositionView(fixturePositionKaminoLending)).toBe(false);
  });

  it("元本 / 収益 / 価格 / 入金日を null 以外にすると拒否 (R0 は捏造しない)", () => {
    expect(isCooldownPositionView(view())).toBe(true);
    for (const key of [
      "principal_amount",
      "accrued_yield_amount",
      "unit_price_usd",
      "unit_price_sol",
      "deposited_at",
    ] as const) {
      expect(isCooldownPositionView({ ...view(), [key]: "0" })).toBe(false);
    }
    expect(isCooldownPositionView({ ...view(), available_actions: [{ actionType: "withdraw" }] })).toBe(false);
  });

  it("u128 最大値の shares を string のまま保持できる", () => {
    const v = view({ shares: U128_MAX });
    expect(isCooldownPositionView(v)).toBe(true);
    expect(JSON.parse(JSON.stringify(v)).shares).toBe("340282366920938463463374607431768211455");
  });

  it("量の欄は smallest unit の整数 string か null だけ", () => {
    expect(isCooldownPositionView(view({ pending_amount: null, shares: null }))).toBe(true);
    expect(isCooldownPositionView({ ...view(), pending_amount: 250 })).toBe(false);
    expect(isCooldownPositionView({ ...view(), pending_amount: "1.5" })).toBe(false);
  });
});

describe("isCooldownStateResponse", () => {
  it("正常 response を通す", () => {
    expect(isCooldownStateResponse(response())).toBe(true);
  });

  it("position null / events 空 (UserStake 不在 or 失敗) も通す", () => {
    expect(
      isCooldownStateResponse(
        response({ position: null, events: [], data_status: CooldownDataStatus.Unavailable, observed_at: null, slot: null, chain_time: null })
      )
    ).toBe(true);
  });

  it.each([
    ["schema_version", { schema_version: 2 }],
    ["source", { source: "fixture" }],
    ["commitment", { commitment: "finalized" }],
    ["coverage", { coverage: "all" }],
    ["data_status", { data_status: "stale" }],
    ["slot が小数", { slot: 1.5 }],
    ["events が配列でない", { events: {} }],
  ])("%s が不正なら拒否", (_label, patch) => {
    expect(isCooldownStateResponse({ ...response(), ...patch })).toBe(false);
  });

  it("event の category / triggerAt が不正なら拒否", () => {
    const r = response();
    const bad = { ...r, events: [{ ...r.events[0]!, event: { ...r.events[0]!.event, category: "unlock" } }] };
    expect(isCooldownStateResponse(bad)).toBe(false);
    const badDate = { ...r, events: [{ ...r.events[0]!, event: { ...r.events[0]!.event, triggerAt: "soon" } }] };
    expect(isCooldownStateResponse(badDate)).toBe(false);
  });
});

describe("CooldownReminderPayload", () => {
  const payload: CooldownReminderPayload = {
    type: "cooldown_reminder",
    schema_version: 1,
    source: "live",
    cluster: "mainnet-beta",
    wallet_address: "W1111111111111111111111111111111111111111",
    protocol_id: "skr_staking",
    position_account: "P1111111111111111111111111111111111111111",
    event_id: "lockup_end:mainnet-beta:skr_staking:W1:P1",
    schedule_revision: "v1:1789900000:172800",
  };

  it("必須 9 欄がそろえば通す", () => {
    expect(isCooldownReminderPayload(payload)).toBe(true);
    expect(Object.keys(payload).sort()).toEqual([...COOLDOWN_REMINDER_PAYLOAD_KEYS].sort());
  });

  it.each(COOLDOWN_REMINDER_PAYLOAD_KEYS)("%s が欠けたら拒否", (key) => {
    const p: Record<string, unknown> = { ...payload };
    delete p[key];
    expect(isCooldownReminderPayload(p)).toBe(false);
  });

  it("他種類の push (approval) は拒否", () => {
    expect(isCooldownReminderPayload({ type: "approval", plan_id: "p1" })).toBe(false);
    expect(isCooldownReminderPayload(null)).toBe(false);
  });

  it("許可された欄に金額 / ready / URL / plan / token は無い", () => {
    for (const forbidden of ["amount", "pending_amount", "ready", "url", "plan_id", "approval_token"]) {
      expect(COOLDOWN_REMINDER_PAYLOAD_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });
});
