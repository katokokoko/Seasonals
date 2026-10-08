/**
 * Cooldown client 規則の検査 (docs/skr-r0-implementation.md §3 鮮度 / §5 retry、R0-06 / R0-09 の純粋部分)
 */
import {
  fixtureCooldownStateCoolingDown,
  fixtureCooldownStateDemoCoolingDown,
  fixtureCooldownStateUnavailable,
  fixtureCooldownStateUnsupported,
  FIXTURE_SKR_WALLET,
} from "../__fixtures__/cooldown-state";
import type { CooldownStateResponse } from "../types/cooldown-position";
import {
  COOLDOWN_BOUNDARY_RETRY_DELAYS_S,
  COOLDOWN_BOUNDARY_RETRY_WINDOW_MS,
  COOLDOWN_FRESH_WINDOW_MS,
  classifyCooldownFreshness,
  nextBoundaryRetryDelayMs,
  shouldAcceptCooldownResponse,
} from "./cooldown-client";

const T0 = 1_800_000_000_000;
const live = { source: "live" as const, cluster: "mainnet-beta", wallet_address: FIXTURE_SKR_WALLET };

describe("classifyCooldownFreshness (R0-06)", () => {
  const state = fixtureCooldownStateCoolingDown;

  it("取得前は loading、初回から失敗なら unavailable", () => {
    expect(classifyCooldownFreshness({ state: undefined, dataUpdatedAt: 0, errorUpdatedAt: 0, nowMs: T0 })).toBe("loading");
    expect(classifyCooldownFreshness({ state: undefined, dataUpdatedAt: 0, errorUpdatedAt: T0, nowMs: T0 })).toBe("unavailable");
  });

  it("300 秒以内は fresh、超えたら stale", () => {
    expect(classifyCooldownFreshness({ state, dataUpdatedAt: T0, errorUpdatedAt: 0, nowMs: T0 + COOLDOWN_FRESH_WINDOW_MS })).toBe("fresh");
    expect(classifyCooldownFreshness({ state, dataUpdatedAt: T0, errorUpdatedAt: 0, nowMs: T0 + COOLDOWN_FRESH_WINDOW_MS + 1 })).toBe("stale");
  });

  it("再取得失敗で stale (旧値は残すが断定しない)", () => {
    expect(classifyCooldownFreshness({ state, dataUpdatedAt: T0, errorUpdatedAt: T0 + 1, nowMs: T0 + 2 })).toBe("stale");
  });

  it("app 復帰後、再取得が終わるまで stale", () => {
    expect(classifyCooldownFreshness({ state, dataUpdatedAt: T0, errorUpdatedAt: 0, nowMs: T0 + 10, resumedAtMs: T0 + 5 })).toBe("stale");
    expect(classifyCooldownFreshness({ state, dataUpdatedAt: T0 + 6, errorUpdatedAt: 0, nowMs: T0 + 10, resumedAtMs: T0 + 5 })).toBe("fresh");
  });

  it("BFF が unavailable / unsupported を返したらそのまま", () => {
    expect(classifyCooldownFreshness({ state: fixtureCooldownStateUnavailable, dataUpdatedAt: T0, errorUpdatedAt: 0, nowMs: T0 })).toBe("unavailable");
    expect(classifyCooldownFreshness({ state: fixtureCooldownStateUnsupported, dataUpdatedAt: T0, errorUpdatedAt: 0, nowMs: T0 })).toBe("unsupported");
  });
});

describe("shouldAcceptCooldownResponse (R0-06 scope / slot)", () => {
  const prev = fixtureCooldownStateCoolingDown;
  const withSlot = (s: CooldownStateResponse, slot: number): CooldownStateResponse => ({ ...s, slot });

  it("初回は scope が合えば受け入れる", () => {
    expect(shouldAcceptCooldownResponse(undefined, prev, live)).toEqual({ ok: true });
  });

  it("要求と違う wallet / source / cluster の応答は捨てる", () => {
    expect(shouldAcceptCooldownResponse(undefined, prev, { ...live, wallet_address: "Other1111111111111111111111111111111111111" })).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(shouldAcceptCooldownResponse(undefined, fixtureCooldownStateDemoCoolingDown, live)).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(shouldAcceptCooldownResponse(undefined, prev, { ...live, cluster: "devnet" })).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("slot が後退した応答で上書きしない", () => {
    expect(shouldAcceptCooldownResponse(prev, withSlot(prev, prev.slot! - 1), live)).toEqual({ ok: false, reason: "slot_regression" });
    expect(shouldAcceptCooldownResponse(prev, withSlot(prev, prev.slot!), live)).toEqual({ ok: true });
    expect(shouldAcceptCooldownResponse(prev, withSlot(prev, prev.slot! + 1), live)).toEqual({ ok: true });
  });

  it("fresh を持っている時の unavailable / unsupported は上書きしない (取消済みと解釈しない)", () => {
    expect(shouldAcceptCooldownResponse(prev, fixtureCooldownStateUnavailable, live)).toEqual({ ok: false, reason: "not_fresh" });
    expect(shouldAcceptCooldownResponse(prev, fixtureCooldownStateUnsupported, live)).toEqual({ ok: false, reason: "not_fresh" });
    expect(shouldAcceptCooldownResponse(fixtureCooldownStateUnavailable, prev, live)).toEqual({ ok: true });
  });
});

describe("nextBoundaryRetryDelayMs (R0-09)", () => {
  it("15 → 30 → 60 → 120 → 300 → 600 秒、最大 6 回", () => {
    let elapsed = 0;
    const delays: number[] = [];
    for (let attempt = 0; ; attempt++) {
      const d = nextBoundaryRetryDelayMs(attempt, elapsed);
      if (d === null) break;
      delays.push(d / 1000);
      elapsed += d;
    }
    expect(delays).toEqual([...COOLDOWN_BOUNDARY_RETRY_DELAYS_S]);
    expect(delays).toHaveLength(6);
    expect(elapsed).toBeLessThanOrEqual(COOLDOWN_BOUNDARY_RETRY_WINDOW_MS);
  });

  it("境界から 20 分を超える retry はしない", () => {
    expect(nextBoundaryRetryDelayMs(5, COOLDOWN_BOUNDARY_RETRY_WINDOW_MS - 599_000)).toBeNull();
    expect(nextBoundaryRetryDelayMs(0, COOLDOWN_BOUNDARY_RETRY_WINDOW_MS)).toBeNull();
  });

  it("範囲外の attempt は null", () => {
    expect(nextBoundaryRetryDelayMs(6, 0)).toBeNull();
    expect(nextBoundaryRetryDelayMs(-1, 0)).toBeNull();
  });
});
