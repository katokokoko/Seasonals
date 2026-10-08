/**
 * Cooldown position 導出の検査 (docs/skr-r0-implementation.md §6)
 * - R0-03 状態: active/pending 独立、Clock 境界、追加解除、取消、config 不明、端末時刻非依存
 * - R0-04 予定キー: 他人の操作と Clock で不変、本人の timestamp / cooldown で変化、id 同一
 */
import {
  FIXTURE_SKR_CHAIN_TIME,
  FIXTURE_SKR_COOLDOWN_SECONDS,
  FIXTURE_SKR_OBSERVED_AT,
  FIXTURE_SKR_PENDING_AMOUNT,
  FIXTURE_SKR_POSITION_ACCOUNT,
  FIXTURE_SKR_SHARE_PRICE,
  FIXTURE_SKR_SHARES,
  FIXTURE_SKR_SLOT,
  FIXTURE_SKR_UNSTAKE_TS_COOLING,
  FIXTURE_SKR_WALLET,
  fixtureCooldownDeriveInput,
  fixtureCooldownLiquid,
  fixtureCooldownStateAbsent,
  fixtureCooldownStateCoolingDown,
  fixtureCooldownStateNone,
  fixtureCooldownStateReady,
  fixtureCooldownStateUnavailable,
  fixtureCooldownStateUnsupported,
} from "../__fixtures__/cooldown-state";
import { fixtureSkrProtocolReference as ref } from "../__fixtures__/skr-staking/protocol-reference";
import { isCooldownStateResponse } from "../types/cooldown-position";
import {
  U128_MAX,
  computeActiveAmountEstimate,
  cooldownEventId,
  cooldownScheduleKey,
  deriveCooldownEvents,
  deriveCooldownPosition,
  freshCooldownState,
  scheduleRevision,
} from "./cooldown-position";

const COOLDOWN = BigInt(FIXTURE_SKR_COOLDOWN_SECONDS);
const TS = BigInt(FIXTURE_SKR_UNSTAKE_TS_COOLING);
const UNLOCK = TS + COOLDOWN;

function user(over: Partial<{ shares: string; pending_amount: string; unstake_timestamp: string }> = {}) {
  return {
    shares: FIXTURE_SKR_SHARES,
    pending_amount: FIXTURE_SKR_PENDING_AMOUNT,
    unstake_timestamp: FIXTURE_SKR_UNSTAKE_TS_COOLING,
    ...over,
  };
}

function stateAt(chainTime: bigint, u = user(), extra: { cooldown_seconds?: string; share_price?: string; slot?: number } = {}) {
  return freshCooldownState(
    fixtureCooldownDeriveInput({ user: u, chain_time: chainTime.toString(), ...extra }),
    fixtureCooldownLiquid
  );
}

describe("fixture は取得済み mainnet batch と一致する", () => {
  it("config / Clock / slot", () => {
    expect(FIXTURE_SKR_COOLDOWN_SECONDS).toBe(ref.decoded.config.cooldown_seconds);
    expect(FIXTURE_SKR_SHARE_PRICE).toBe(ref.decoded.config.share_price);
    expect(FIXTURE_SKR_CHAIN_TIME).toBe(ref.decoded.chain_time);
    expect(FIXTURE_SKR_SLOT).toBe(ref.rpc_response.result.context.slot);
    expect(FIXTURE_SKR_OBSERVED_AT).toBe(ref.captured_at);
  });

  it("全 fixture が runtime guard を通る", () => {
    for (const s of [
      fixtureCooldownStateCoolingDown,
      fixtureCooldownStateReady,
      fixtureCooldownStateNone,
      fixtureCooldownStateAbsent,
      fixtureCooldownStateUnavailable,
      fixtureCooldownStateUnsupported,
    ]) {
      expect(isCooldownStateResponse(s)).toBe(true);
    }
  });
});

describe("R0-03 状態", () => {
  it("active > 0 かつ pending > 0 を独立に持つ", () => {
    const s = fixtureCooldownStateCoolingDown;
    expect(s.data_status).toBe("fresh");
    expect(s.position?.pending_status).toBe("cooling_down");
    expect(s.position?.pending_amount).toBe("250000000");
    // floor(1e12 × 1141844787 / 1e9)
    expect(s.position?.active_amount_estimate).toBe("1141844787000");
    expect(s.position?.unlock_at).toBe(new Date(Number(UNLOCK) * 1000).toISOString());
    expect(s.events).toHaveLength(1);
  });

  it.each([
    ["unlock − 1", UNLOCK - 1n, "cooling_down"],
    ["unlock ちょうど", UNLOCK, "ready"],
    ["unlock + 1", UNLOCK + 1n, "ready"],
  ] as const)("Clock = %s → %s", (_label, clock, expected) => {
    const s = stateAt(clock);
    expect(s.position?.pending_status).toBe(expected);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]?.event.metadata.pending_status).toBe(expected);
  });

  it("ready は Critical にしない (Watch)。境界直前の待機中は既存 lockup_end と同じ閾値", () => {
    expect(stateAt(UNLOCK).events[0]?.event.urgency).toBe("watch");
    expect(stateAt(UNLOCK + 86_400n * 30n).events[0]?.event.urgency).toBe("watch");
    expect(stateAt(UNLOCK - 1n).events[0]?.event.urgency).toBe("critical"); // ≤ 1 日
    expect(fixtureCooldownStateCoolingDown.events[0]?.event.urgency).toBe("watch"); // 47 時間
  });

  it("追加解除: pending 合算と timestamp 更新で unlock_at が延び、event id は同じ", () => {
    const before = stateAt(TS + 7200n);
    const laterTs = TS + 7200n;
    const after = stateAt(laterTs + 10n, user({ pending_amount: "400000000", unstake_timestamp: laterTs.toString() }));
    expect(after.position?.pending_amount).toBe("400000000");
    expect(after.position?.unlock_at).toBe(new Date(Number(laterTs + COOLDOWN) * 1000).toISOString());
    expect(after.events[0]?.event.id).toBe(before.events[0]?.event.id);
    expect(after.events[0]?.schedule_revision).not.toBe(before.events[0]?.schedule_revision);
    expect(Date.parse(after.events[0]!.event.triggerAt)).toBeGreaterThan(Date.parse(before.events[0]!.event.triggerAt));
  });

  it("取消 (再ステーク) で pending = 0 → none、event 0 件", () => {
    const s = stateAt(TS + 100n, user({ pending_amount: "0" }));
    expect(s.position?.pending_status).toBe("none");
    expect(s.position?.unlock_at).toBeNull();
    expect(s.position?.unstake_timestamp).toBeNull();
    expect(s.events).toEqual([]);
    expect(fixtureCooldownStateNone.events).toEqual([]);
  });

  it("pending > 0 だが解除時刻が読めない → unknown、event 0 件 (日付を捏造しない)", () => {
    const s = stateAt(TS, user({ unstake_timestamp: "0" }));
    expect(s.position?.pending_status).toBe("unknown");
    expect(s.position?.unlock_at).toBeNull();
    expect(s.events).toEqual([]);
  });

  it("config 不明を 48 時間で補わない (不正値は throw → BFF が unsupported にする)", () => {
    expect(() => stateAt(TS, user(), { cooldown_seconds: "" })).toThrow();
    expect(() => stateAt(TS, user(), { cooldown_seconds: "-1" })).toThrow();
    expect(() => stateAt(TS, user(), { share_price: "1.5" })).toThrow();
  });

  it("UserStake 不在は正常な空状態 (fresh / position null / event 0)", () => {
    expect(fixtureCooldownStateAbsent.data_status).toBe("fresh");
    expect(fixtureCooldownStateAbsent.position).toBeNull();
    expect(fixtureCooldownStateAbsent.events).toEqual([]);
  });

  it("unavailable / unsupported は量・日付・event を持たない", () => {
    for (const s of [fixtureCooldownStateUnavailable, fixtureCooldownStateUnsupported]) {
      expect(s.position).toBeNull();
      expect(s.events).toEqual([]);
      expect(s.observed_at).toBeNull();
      expect(s.slot).toBeNull();
    }
  });

  it("端末時刻だけでは ready にならない (chain Clock だけで判定)", () => {
    jest.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z") });
    try {
      const s = stateAt(UNLOCK - 1n);
      expect(s.position?.pending_status).toBe("cooling_down");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("R0-04 予定キー", () => {
  const base = stateAt(TS + 60n);
  const baseRev = base.events[0]!.schedule_revision;
  const baseId = base.events[0]!.event.id;

  it("形式は v1:<unstake_timestamp>:<cooldown_seconds>", () => {
    expect(baseRev).toBe(`v1:${TS}:${COOLDOWN}`);
    expect(scheduleRevision("001", "0172800")).toBe("v1:1:172800"); // 正規化済み整数 string
  });

  it("他人の操作 (share_price 変化) と Clock の進行・slot 変化では不変", () => {
    const otherShare = stateAt(TS + 60n, user(), { share_price: "1200000000" });
    const later = stateAt(TS + 9000n, user(), { slot: FIXTURE_SKR_SLOT + 5000 });
    const ready = stateAt(UNLOCK + 5n);
    for (const s of [otherShare, later, ready]) {
      expect(s.events[0]?.schedule_revision).toBe(baseRev);
      expect(s.events[0]?.event.id).toBe(baseId);
    }
    // share_price の変化は active 推定額にだけ出る
    expect(otherShare.position?.active_amount_estimate).toBe("1200000000000");
  });

  it("本人の timestamp / 適用 cooldown の変化で変わる (id は同じ)", () => {
    const newTs = stateAt(TS + 60n, user({ unstake_timestamp: (TS + 1n).toString() }));
    const newCd = stateAt(TS + 60n, user(), { cooldown_seconds: "259200" });
    expect(newTs.events[0]?.schedule_revision).not.toBe(baseRev);
    expect(newCd.events[0]?.schedule_revision).not.toBe(baseRev);
    expect(newTs.events[0]?.event.id).toBe(baseId);
    expect(newCd.events[0]?.event.id).toBe(baseId);
  });

  it("event id は lockup_end:<cluster>:<protocol>:<wallet>:<position_account> で時刻を含まない", () => {
    expect(baseId).toBe(
      `lockup_end:mainnet-beta:skr_staking:${FIXTURE_SKR_WALLET}:${FIXTURE_SKR_POSITION_ACCOUNT}`
    );
    expect(baseId).toBe(cooldownEventId("mainnet-beta", "skr_staking", FIXTURE_SKR_WALLET, FIXTURE_SKR_POSITION_ACCOUNT));
  });

  it("比較キーは source / cluster / wallet / event_id / revision を全部含む", () => {
    const live = cooldownScheduleKey({ source: "live", cluster: "mainnet-beta", wallet_address: "W" }, baseId, baseRev);
    const demo = cooldownScheduleKey({ source: "demo", cluster: "mainnet-beta", wallet_address: "W" }, baseId, baseRev);
    expect(live).not.toBe(demo);
    expect(live).toContain(baseId);
    expect(live).toContain(baseRev);
  });
});

describe("event の形 (R0-07 の前提)", () => {
  const ev = fixtureCooldownStateCoolingDown.events[0]!.event;

  it("actions 空 / positionRef null / agentReadable true / lockup_end", () => {
    expect(ev.actions).toEqual([]);
    expect(ev.positionRef).toBeNull();
    expect(ev.agentReadable).toBe(true);
    expect(ev.category).toBe("lockup_end");
    expect(ev.protocol).toBe("skr_staking");
    expect(ev.triggerAt).toBe(fixtureCooldownStateCoolingDown.position?.unlock_at);
  });

  it("metadata は source / observed_at / slot / pending_status だけ (量・価格・raw を含まない)", () => {
    expect(Object.keys(ev.metadata).sort()).toEqual(["observed_at", "pending_status", "slot", "source"]);
    expect(ev.metadata).toEqual({
      source: "live",
      observed_at: FIXTURE_SKR_OBSERVED_AT,
      slot: FIXTURE_SKR_SLOT,
      pending_status: "cooling_down",
    });
  });

  it("deriveCooldownEvents(null) は 0 件", () => {
    expect(deriveCooldownEvents(null)).toEqual([]);
    expect(deriveCooldownPosition(fixtureCooldownDeriveInput({ user: null }))).toBeNull();
  });
});

describe("金融値 (bigint で計算、精度を落とさない)", () => {
  it("u128 最大値の shares を扱える", () => {
    expect(computeActiveAmountEstimate(U128_MAX.toString(), "1000000000", "1000000000")).toBe(U128_MAX.toString());
    const s = stateAt(TS, user({ shares: U128_MAX.toString() }));
    expect(s.position?.shares).toBe("340282366920938463463374607431768211455");
  });

  it("u128 を超える shares / u64 を超える pending は拒否", () => {
    expect(() => stateAt(TS, user({ shares: (U128_MAX + 1n).toString() }))).toThrow(RangeError);
    expect(() => stateAt(TS, user({ pending_amount: (1n << 64n).toString() }))).toThrow(RangeError);
  });

  it("floor で切り捨てる", () => {
    expect(computeActiveAmountEstimate("3", "1500000000", "1000000000")).toBe("4"); // 4.5 → 4
  });
});
