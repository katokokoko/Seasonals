/**
 * R0-09 境界 retry (docs/skr-r0-implementation.md §5)
 * - 同じ app 起動の同 schedule で境界 1 回 + 最大 6 回、境界から 20 分以内
 * - 予定変更 / 取消 / ready で終了。同じ予定は再開しない。過去の境界 (cold start) は何もしない
 */
import { fixtureCooldownStateCoolingDown, fixtureCooldownStateUnavailable } from "@workspace/lib/__fixtures__";

import { viewOf } from "../components/portfolio/cooldown-test-utils";
import { createBoundaryRetryController, type BoundaryTarget } from "./cooldown-boundary-retry";
import { boundaryTargetOf } from "./useCooldownBoundaryRetry";

/** 手動で進める時計と timer */
function harness(opts: { foreground?: boolean } = {}) {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const refetch = jest.fn();
  const controller = createBoundaryRetryController({
    refetch,
    now: () => now,
    isForeground: () => opts.foreground ?? true,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  });
  /** ms だけ進め、期限の来た timer を順に実行 */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { controller, refetch, advance, now: () => now, pending: () => timers.size };
}

const target = (over: Partial<BoundaryTarget> = {}, base = 1_000_000): BoundaryTarget => ({
  scheduleKey: "live|mainnet-beta|W|lockup_end:x|v1:1:172800",
  unlockAtMs: base + 60_000,
  pendingStatus: "cooling_down",
  ...over,
});

describe("createBoundaryRetryController", () => {
  it("境界で 1 回 + 15/30/60/120/300/600 秒の 6 回、それ以上はしない (RPC 失敗も回数に含む)", () => {
    const h = harness();
    h.controller.observe(target());
    h.advance(59_999);
    expect(h.refetch).toHaveBeenCalledTimes(0);
    h.advance(1);
    expect(h.refetch).toHaveBeenCalledTimes(1); // 境界
    const delays = [15, 30, 60, 120, 300, 600];
    for (const [i, d] of delays.entries()) {
      h.advance(d * 1000 - 1);
      expect(h.refetch).toHaveBeenCalledTimes(1 + i);
      h.advance(1);
      expect(h.refetch).toHaveBeenCalledTimes(2 + i);
    }
    h.advance(60 * 60_000);
    expect(h.refetch).toHaveBeenCalledTimes(7);
    expect(h.pending()).toBe(0);
  });

  it("ready を観測したら止まる", () => {
    const h = harness();
    h.controller.observe(target());
    h.advance(60_000 + 15_000);
    expect(h.refetch).toHaveBeenCalledTimes(2);
    h.controller.observe(target({ pendingStatus: "ready" }));
    h.advance(60 * 60_000);
    expect(h.refetch).toHaveBeenCalledTimes(2);
  });

  it("予定が変わったら旧 retry を止め、新しい境界で始め直す", () => {
    const h = harness();
    h.controller.observe(target());
    h.advance(60_000);
    expect(h.refetch).toHaveBeenCalledTimes(1);
    // 追加解除: 新しい revision、境界は 10 分後
    h.controller.observe(target({ scheduleKey: "k2", unlockAtMs: h.now() + 600_000 }));
    h.advance(599_999);
    expect(h.refetch).toHaveBeenCalledTimes(1); // 旧予定の 15 秒 retry は走らない
    h.advance(1);
    expect(h.refetch).toHaveBeenCalledTimes(2);
  });

  it("取消 (pending なし / null) で止まる", () => {
    const h = harness();
    h.controller.observe(target());
    h.controller.observe(target({ pendingStatus: "none" }));
    h.advance(60 * 60_000);
    expect(h.refetch).not.toHaveBeenCalled();
    h.controller.observe(target({ scheduleKey: "k3" }, h.now()));
    h.controller.observe(null);
    h.advance(60 * 60_000);
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it("同じ app 起動中に同じ予定の retry は再開しない", () => {
    const h = harness();
    h.controller.observe(target());
    h.controller.observe(null);
    h.controller.observe(target());
    h.advance(60 * 60_000);
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it("観測時点で境界が過ぎていれば何もしない (cold start は通常 read へ)", () => {
    const h = harness();
    h.controller.observe(target({ unlockAtMs: h.now() - 1 }));
    h.advance(60 * 60_000);
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it("境界の瞬間に背景なら retry しない (復帰時の read に任せる)", () => {
    const h = harness({ foreground: false });
    h.controller.observe(target());
    h.advance(60 * 60_000);
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it("dispose で止まる", () => {
    const h = harness();
    h.controller.observe(target());
    h.controller.dispose();
    h.advance(60 * 60_000);
    expect(h.refetch).not.toHaveBeenCalled();
  });
});

describe("boundaryTargetOf", () => {
  it("fresh な予定から scope 付きの予定キーと終了予定を取る", () => {
    const t = boundaryTargetOf(viewOf(fixtureCooldownStateCoolingDown, "fresh"));
    const e = fixtureCooldownStateCoolingDown.events[0]!;
    expect(t).toEqual({
      scheduleKey: `live|mainnet-beta|${fixtureCooldownStateCoolingDown.wallet_address}|${e.event.id}|${e.schedule_revision}`,
      unlockAtMs: Date.parse(e.event.triggerAt),
      pendingStatus: "cooling_down",
    });
  });

  it("unavailable / 未接続は対象なし", () => {
    expect(boundaryTargetOf(viewOf(fixtureCooldownStateUnavailable, "unavailable"))).toBeNull();
    expect(boundaryTargetOf({ ...viewOf(undefined, "loading"), scope: null })).toBeNull();
  });
});
