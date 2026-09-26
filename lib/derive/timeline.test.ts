import type { CustomEvent } from "../types/custom-event";
import { PositionCategory } from "../types/enums";
import type { TimelineEvent } from "../types/timeline";
import type { UnifiedTimeEventDTO } from "../types/unified-time-event";
import {
  dayKey,
  deriveTimelineStatus,
  displayStatus,
  estimateBlockTime,
  fromCustomEvent,
  fromUnifiedTimeEventDTO,
  groupTimelineByDay,
  isCustomPlan,
  mergeTimelineEvents,
  monthGridDays,
  sortTimeline,
  windowTimeline,
} from "./timeline";

const NOW = new Date("2026-09-26T03:00:00.000Z");
const H = 3_600_000;

function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: over.id ?? "ethereum:pendle:pt_maturity:x",
    chain: "ethereum",
    class: "protocol",
    kind: "pt_maturity",
    protocol: "pendle",
    protocolName: "Pendle",
    title: "PT matures",
    at: new Date(NOW.getTime() + 48 * H).toISOString(),
    atApprox: false,
    settled: false,
    metrics: [],
    actions: [
      { actionType: "pendle_redeem", label: "Redeem PT", requiresWallet: true, availability: "available", params: {} },
    ],
    requiresWallet: true,
    links: [],
    source: "test",
    observedAt: NOW.toISOString(),
    ...over,
  };
}

describe("deriveTimelineStatus", () => {
  it("future → upcoming", () => {
    expect(deriveTimelineStatus(ev(), NOW)).toBe("upcoming");
  });
  it("past < 24h with open action → due", () => {
    expect(deriveTimelineStatus(ev({ at: new Date(NOW.getTime() - 2 * H).toISOString() }), NOW)).toBe("due");
  });
  it("past ≥ 24h with open action → overdue", () => {
    expect(deriveTimelineStatus(ev({ at: new Date(NOW.getTime() - 30 * H).toISOString() }), NOW)).toBe("overdue");
  });
  it("past without action → done (informational)", () => {
    expect(deriveTimelineStatus(ev({ at: new Date(NOW.getTime() - 30 * H).toISOString(), actions: [] }), NOW)).toBe("done");
  });
  it("only unsupported actions count as no action", () => {
    const e = ev({
      at: new Date(NOW.getTime() - 30 * H).toISOString(),
      actions: [{ actionType: "withdraw", label: "Withdraw", requiresWallet: true, availability: "unsupported", params: {} }],
    });
    expect(deriveTimelineStatus(e, NOW)).toBe("done");
  });
  it("settled → done, cancelled → cancelled", () => {
    expect(deriveTimelineStatus(ev({ settled: true, at: new Date(NOW.getTime() - 30 * H).toISOString() }), NOW)).toBe("done");
    expect(deriveTimelineStatus(ev({ cancelled: true }), NOW)).toBe("cancelled");
  });
  it("ETA unknown → upcoming", () => {
    expect(deriveTimelineStatus(ev({ at: null }), NOW)).toBe("upcoming");
  });
  it("user_plan: due within 24h, then done without action / overdue with action", () => {
    const past = (h: number) => new Date(NOW.getTime() - h * H).toISOString();
    expect(deriveTimelineStatus(ev({ class: "user_plan", at: past(2), actions: [] }), NOW)).toBe("due");
    expect(deriveTimelineStatus(ev({ class: "user_plan", at: past(30), actions: [] }), NOW)).toBe("done");
    expect(deriveTimelineStatus(ev({ class: "user_plan", at: past(30) }), NOW)).toBe("overdue");
  });
  it("executed → done / failed by outcome", () => {
    expect(deriveTimelineStatus(ev({ class: "executed", outcome: "success" }), NOW)).toBe("done");
    expect(deriveTimelineStatus(ev({ class: "executed", outcome: "failed" }), NOW)).toBe("failed");
  });
});

describe("displayStatus", () => {
  it("maps to UI v2 statuses", () => {
    expect(displayStatus(ev(), "upcoming")).toBe("upcoming");
    expect(displayStatus(ev(), "due")).toBe("upcoming");
    expect(displayStatus(ev(), "overdue")).toBe("warning");
    expect(displayStatus(ev(), "done")).toBe("completed");
    expect(displayStatus(ev(), "failed")).toBe("failed");
    expect(displayStatus(ev({ class: "user_plan" }), "upcoming")).toBe("planned");
    expect(displayStatus(ev({ class: "user_plan" }), "done")).toBe("completed");
  });
});

describe("sortTimeline", () => {
  it("ascending by time, null last, ties by protocol then title, stable", () => {
    const t = new Date(NOW.getTime() + H).toISOString();
    const a = ev({ id: "a", at: t, protocolName: "Lido", title: "b" });
    const b = ev({ id: "b", at: t, protocolName: "Ethena", title: "z" });
    const c = ev({ id: "c", at: new Date(NOW.getTime() - H).toISOString() });
    const d = ev({ id: "d", at: null });
    const e = ev({ id: "e", at: t, protocolName: "Lido", title: "a" });
    const f = ev({ id: "f", at: t, protocolName: "Lido", title: "a" });
    expect(sortTimeline([d, a, b, c, e, f]).map((x) => x.id)).toEqual(["c", "b", "e", "f", "a", "d"]);
  });
});

describe("windowTimeline", () => {
  const inWindow = ev({ id: "in", at: new Date(NOW.getTime() + 10 * 24 * H).toISOString() });
  const outWindow = ev({ id: "out", at: new Date(NOW.getTime() + 40 * 24 * H).toISOString() });
  const past = ev({ id: "past", at: new Date(NOW.getTime() - 3 * 24 * H).toISOString() });
  const pastDone = ev({ id: "pastDone", at: new Date(NOW.getTime() - 3 * 24 * H).toISOString(), settled: true });
  const pending = ev({ id: "pending", at: null });
  it("keeps [now, now+days] and pending", () => {
    expect(windowTimeline([inWindow, outWindow, past, pending], NOW, 30).map((e) => e.id)).toEqual(["in", "pending"]);
  });
  it("includeOpenPast keeps overdue but not settled", () => {
    expect(windowTimeline([past, pastDone], NOW, 30, { includeOpenPast: true }).map((e) => e.id)).toEqual(["past"]);
  });
});

describe("grouping and grid", () => {
  it("groups same local day together", () => {
    const d1 = new Date(2026, 9, 3, 9, 0);
    const d2 = new Date(2026, 9, 3, 18, 0);
    const d3 = new Date(2026, 9, 4, 9, 0);
    const g = groupTimelineByDay([
      ev({ id: "1", at: d1.toISOString() }),
      ev({ id: "2", at: d2.toISOString() }),
      ev({ id: "3", at: d3.toISOString() }),
      ev({ id: "4", at: null }),
    ]);
    expect(g.map((x) => [x.day, x.events.map((e) => e.id)])).toEqual([
      ["2026-10-03", ["1", "2"]],
      ["2026-10-04", ["3"]],
      ["unscheduled", ["4"]],
    ]);
  });
  it("monthGridDays returns 42 days starting on Monday", () => {
    const days = monthGridDays(new Date(2026, 8, 15));
    expect(days).toHaveLength(42);
    expect(days[0]!.getDay()).toBe(1);
    expect(dayKey(days[0]!)).toBe("2026-08-31");
    expect(days.some((d) => dayKey(d) === "2026-09-30")).toBe(true);
  });
  it("monthGridDays supports Sunday start", () => {
    const days = monthGridDays(new Date(2026, 8, 15), 0);
    expect(days[0]!.getDay()).toBe(0);
    expect(dayKey(days[0]!)).toBe("2026-08-30");
  });
});

describe("estimateBlockTime", () => {
  it("adds 12s per block", () => {
    expect(estimateBlockTime(110, { block: 100, timestampSec: 1_000_000 })).toBe(new Date(1_000_120_000).toISOString());
    expect(estimateBlockTime(90, { block: 100, timestampSec: 1_000_000 })).toBe(new Date(999_880_000).toISOString());
  });
});

describe("fromUnifiedTimeEventDTO", () => {
  const base: UnifiedTimeEventDTO = {
    id: "e1",
    protocol: "kamino",
    category: "maturity",
    triggerAt: "2026-10-01T00:00:00.000Z",
    urgency: "watch",
    walletAddress: "So11111111111111111111111111111111111111112",
    positionRef: null,
    actions: [{ actionType: "withdraw", label: "Redeem", requiresApproval: true, riskLevel: "low" }],
    agentReadable: true,
    metadata: { source: "maturity", headline: "PT matures" },
  };
  it("protocol event keeps Seeker actions but marks them unsupported on web", () => {
    const t = fromUnifiedTimeEventDTO(base, NOW.toISOString());
    expect(t.chain).toBe("solana");
    expect(t.class).toBe("protocol");
    expect(t.title).toBe("PT matures");
    expect(t.protocolName).toBe("Kamino");
    expect(t.actions).toHaveLength(1);
    expect(t.actions[0]!.availability).toBe("unsupported");
  });
  it("helius_tx → executed with Solscan link", () => {
    const t = fromUnifiedTimeEventDTO(
      { ...base, category: "epoch", actions: [], metadata: { source: "helius_tx", signature: "sig123", headline: "Deposited 1 kUSDC" } },
      NOW.toISOString()
    );
    expect(t.class).toBe("executed");
    expect(t.outcome).toBe("success");
    expect(t.links[0]!.url).toBe("https://solscan.io/tx/sig123");
  });
});

describe("mergeTimelineEvents", () => {
  it("dedupes by id, later wins", () => {
    const merged = mergeTimelineEvents([ev({ id: "x", title: "old" })], [ev({ id: "x", title: "new" }), ev({ id: "y" })]);
    expect(merged.map((e) => [e.id, e.title])).toEqual([
      ["x", "new"],
      ["y", "PT matures"],
    ]);
  });
});

describe("fromCustomEvent", () => {
  const ce: CustomEvent = {
    id: "ce_1_abc",
    date: "2026-10-03",
    title: "Jupiter TGE",
    note: "Check claim site",
    category: PositionCategory.Other,
    marker: "emoji",
    emoji: "🚀",
    created_at: NOW.toISOString(),
  };
  it("projects to a chain-agnostic all-day user_plan", () => {
    const t = fromCustomEvent(ce, NOW.toISOString());
    expect(t).toMatchObject({
      id: "custom:ce_1_abc",
      chain: null,
      class: "user_plan",
      kind: "user_note",
      protocol: null,
      title: "Jupiter TGE",
      allDay: true,
      emoji: "🚀",
      requiresWallet: false,
      actions: [],
    });
    expect(dayKey(new Date(t.at!))).toBe("2026-10-03");
    expect(t.metrics).toEqual([{ label: "Note", kind: "text", value: "Check claim site" }]);
    expect(isCustomPlan(t)).toBe(true);
    expect(isCustomPlan(ev())).toBe(false);
  });
  it("omits emoji for non-emoji markers and note metric when empty", () => {
    const t = fromCustomEvent({ ...ce, marker: "circle", note: undefined }, NOW.toISOString());
    expect(t.emoji).toBeUndefined();
    expect(t.metrics).toEqual([]);
  });
  it("past custom plans read as done, not overdue", () => {
    const t = fromCustomEvent({ ...ce, date: "2026-09-20" }, NOW.toISOString());
    expect(deriveTimelineStatus(t, NOW)).toBe("done");
  });
});
