/**
 * Phase 8.16: カレンダーイベント表示解決の純関数検証。
 */
import { TimeEventCategory, Urgency } from "@workspace/lib/types";
import {
  dropletShapeForEvent,
  eventDirectionLabel,
  eventHeadline,
  sortEventsByUrgency,
} from "./event-display";

describe("dropletShapeForEvent", () => {
  it("tx 履歴イベント (source=helius_tx) は deposit_history 形状", () => {
    expect(
      dropletShapeForEvent({
        category: TimeEventCategory.Epoch,
        metadata: { source: "helius_tx", direction: "deposit" },
      })
    ).toBe("deposit_history");
  });
  it("それ以外は category そのまま (実 epoch / health / fixture)", () => {
    expect(
      dropletShapeForEvent({
        category: TimeEventCategory.Epoch,
        metadata: { source: "epoch_info" },
      })
    ).toBe(TimeEventCategory.Epoch);
    expect(
      dropletShapeForEvent({ category: TimeEventCategory.Health, metadata: {} })
    ).toBe(TimeEventCategory.Health);
    expect(
      dropletShapeForEvent({ category: TimeEventCategory.Maturity })
    ).toBe(TimeEventCategory.Maturity);
  });
});

describe("eventDirectionLabel", () => {
  it("tx 履歴イベントは Deposit/Withdraw", () => {
    expect(
      eventDirectionLabel({
        category: TimeEventCategory.Epoch,
        metadata: { source: "helius_tx", direction: "deposit" },
      })
    ).toBe("Deposit");
    expect(
      eventDirectionLabel({
        category: TimeEventCategory.Epoch,
        metadata: { source: "helius_tx", direction: "withdraw" },
      })
    ).toBe("Withdraw");
  });
  it("それ以外は null (CATEGORY_LABELS に委ねる)", () => {
    expect(
      eventDirectionLabel({
        category: TimeEventCategory.Epoch,
        metadata: { source: "epoch_info" },
      })
    ).toBeNull();
    expect(
      eventDirectionLabel({ category: TimeEventCategory.Claim })
    ).toBeNull();
  });
});

describe("sortEventsByUrgency (§5.3、8.21)", () => {
  it("critical → watch → info、同 urgency は元順維持 (安定 sort)", () => {
    const events = [
      { id: "a", urgency: Urgency.Info },
      { id: "b", urgency: Urgency.Watch },
      { id: "c", urgency: Urgency.Critical },
      { id: "d", urgency: Urgency.Info },
      { id: "e", urgency: Urgency.Critical },
    ];
    const sorted = sortEventsByUrgency(events);
    expect(sorted.map((e) => e.id)).toEqual(["c", "e", "b", "a", "d"]);
    // 元配列は破壊しない
    expect(events.map((e) => e.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("eventHeadline", () => {
  it("string の headline を返し、無ければ null", () => {
    expect(
      eventHeadline({
        category: TimeEventCategory.Epoch,
        metadata: { headline: "Deposited 1.5 jlUSDC on Jupiter Lend" },
      })
    ).toBe("Deposited 1.5 jlUSDC on Jupiter Lend");
    expect(
      eventHeadline({ category: TimeEventCategory.Epoch, metadata: {} })
    ).toBeNull();
    expect(
      eventHeadline({
        category: TimeEventCategory.Epoch,
        metadata: { headline: "" },
      })
    ).toBeNull();
  });
});
