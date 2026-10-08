/**
 * SKR cooldown の表示規則 (docs/skr-r0-implementation.md §3 / §4、R0-05 UI 部分)
 */
import {
  fixtureCooldownStateAbsent,
  fixtureCooldownStateCoolingDown,
  fixtureCooldownStateDemoCoolingDown,
  fixtureCooldownStateNone,
  fixtureCooldownStateReady,
  fixtureCooldownStateUnsupported,
} from "@workspace/lib/__fixtures__";
import { eventProtocolLabel } from "../calendar/event-display";
import { cooldownDisplay, isCooldownCalendarEvent, NOT_AVAILABLE } from "./cooldown-display";
import { viewOf } from "./cooldown-test-utils";

const BEFORE_UNLOCK = Date.parse(fixtureCooldownStateCoolingDown.position!.unlock_at!) - 60_000;

describe("cooldownDisplay", () => {
  it("cooling_down (fresh): 推定 stake と解除待ち量、終了予定", () => {
    const d = cooldownDisplay(viewOf(fixtureCooldownStateCoolingDown, "fresh"), BEFORE_UNLOCK);
    expect(d.kind).toBe("position");
    expect(d.stakedEstimate).toBe("1,141,844.79 SKR");
    expect(d.pending).toBe("250 SKR");
    expect(d.status).toMatch(/^Cooling down · ends /);
    expect(d.isDemo).toBe(false);
    expect(d.isStale).toBe(false);
  });

  it("ready (fresh) だけ「引き出し可能」と言う", () => {
    expect(cooldownDisplay(viewOf(fixtureCooldownStateReady, "fresh")).status).toBe(
      "Withdrawable on the official portal"
    );
  });

  it("stale の時は ready を断定しない / 観測時刻と awaiting update を出す", () => {
    const d = cooldownDisplay(viewOf(fixtureCooldownStateReady, "stale"));
    expect(d.status).not.toMatch(/Withdrawable/);
    expect(d.status).toBe("Checking withdrawal status…");
    expect(d.observed).toMatch(/· awaiting update$/);
    const c = cooldownDisplay(viewOf(fixtureCooldownStateCoolingDown, "stale"), BEFORE_UNLOCK);
    expect(c.status).toMatch(/\(last seen\)$/);
  });

  it("端末時刻が終了予定を過ぎても chain が cooling_down なら ready と言わない", () => {
    const after = Date.parse(fixtureCooldownStateCoolingDown.position!.unlock_at!) + 60_000;
    const d = cooldownDisplay(viewOf(fixtureCooldownStateCoolingDown, "fresh"), after);
    expect(d.status).toBe("Cooldown ending · waiting for on-chain confirmation");
    expect(d.status).not.toMatch(/Withdrawable/);
  });

  it("pending なし / stake なし / unsupported / 未取得", () => {
    expect(cooldownDisplay(viewOf(fixtureCooldownStateNone, "fresh"))).toMatchObject({
      kind: "position",
      pending: NOT_AVAILABLE,
      status: "No unstake pending",
    });
    expect(cooldownDisplay(viewOf(fixtureCooldownStateAbsent, "fresh"))).toMatchObject({
      kind: "empty",
      stakedEstimate: NOT_AVAILABLE,
    });
    expect(cooldownDisplay(viewOf(fixtureCooldownStateUnsupported, "unsupported")).kind).toBe("unsupported");
    expect(cooldownDisplay(viewOf(undefined, "unavailable")).kind).toBe("unavailable");
    expect(cooldownDisplay(viewOf(undefined, "loading")).kind).toBe("loading");
  });

  it("取得できない量は — (ゼロで埋めない)", () => {
    const s = structuredClone(fixtureCooldownStateCoolingDown);
    s.position!.active_amount_estimate = null;
    s.position!.pending_amount = null;
    const d = cooldownDisplay(viewOf(s, "fresh"), BEFORE_UNLOCK);
    expect(d.stakedEstimate).toBe(NOT_AVAILABLE);
    expect(d.pending).toBe(NOT_AVAILABLE);
  });

  it("demo source は必ず demo と分かる", () => {
    expect(cooldownDisplay(viewOf(fixtureCooldownStateDemoCoolingDown, "fresh")).isDemo).toBe(true);
  });
});

describe("Calendar 上の SKR event", () => {
  const ev = { ...fixtureCooldownStateCoolingDown.events[0]!.event };

  it("isCooldownCalendarEvent: SKR event だけ true (ActionModal に渡さない対象)", () => {
    expect(isCooldownCalendarEvent(ev)).toBe(true);
    expect(isCooldownCalendarEvent({ protocol: "kamino" })).toBe(false);
  });

  it("表示名は SKR staking。他 protocol は従来どおり id のまま", () => {
    expect(eventProtocolLabel(ev)).toBe("SKR staking");
    expect(eventProtocolLabel({ protocol: "kamino" })).toBe("kamino");
  });
});
