import type { TimelineEvent } from "@workspace/lib/types";

const OWNER = "0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5";
const events: TimelineEvent[] = [];
const readContract = jest.fn();
const call = jest.fn();

jest.mock("./events", () => ({ getUserEvents: jest.fn(async () => ({ events, sources: [] })) }));
jest.mock("./client", () => {
  const actual = jest.requireActual("./client");
  return { ...actual, getEthClient: () => ({ readContract, call }), getJson: jest.fn(async () => ({ data: { smaApr: 2.5 } })) };
});

import { buildActionPlan, PlanError } from "./plans";
import { buildProposal } from "./proposals";
import { deriveLidoEvents } from "./lido";

beforeEach(() => {
  events.length = 0;
  readContract.mockReset();
  call.mockReset();
});

function lidoEvent(finalized: boolean): TimelineEvent {
  return deriveLidoEvents(OWNER, [{ requestId: 136731n, amountOfStETH: 2n * 10n ** 18n, timestamp: 1_790_000_000n, isFinalized: finalized, isClaimed: false }], new Date().toISOString())[0]!;
}

describe("buildActionPlan", () => {
  it("builds an unsigned claimWithdrawal plan, simulated with eth_call, never broadcast", async () => {
    const e = lidoEvent(true);
    events.push(e);
    readContract.mockResolvedValue([{ amountOfStETH: 2n * 10n ** 18n, owner: OWNER, isFinalized: true, isClaimed: false }]);
    call.mockResolvedValue({ data: "0x" });
    const plan = await buildActionPlan({ owner: OWNER, eventId: e.id, actionType: "lido_claim" });
    expect(plan.broadcast).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.to).toBe("0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1");
    // claimWithdrawal(uint256) selector 0xf8444436 + 136731 (0x2161b)
    expect(plan.steps[0]!.data).toBe("0xf8444436" + (136731).toString(16).padStart(64, "0"));
    expect(plan.simulation).toMatchObject({ ran: true, ok: true });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ account: OWNER }));
  });

  it("re-checks on-chain state: another owner → rejected", async () => {
    const e = lidoEvent(true);
    events.push(e);
    readContract.mockResolvedValue([{ amountOfStETH: 1n, owner: "0x000000000000000000000000000000000000dEaD", isFinalized: true, isClaimed: false }]);
    await expect(buildActionPlan({ owner: OWNER, eventId: e.id, actionType: "lido_claim" })).rejects.toMatchObject({ code: "action_not_available" });
  });

  it("not-yet actions are refused before touching the chain", async () => {
    const e = lidoEvent(false);
    events.push(e);
    await expect(buildActionPlan({ owner: OWNER, eventId: e.id, actionType: "lido_claim" })).rejects.toBeInstanceOf(PlanError);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("unknown event → event_not_found", async () => {
    await expect(buildActionPlan({ owner: OWNER, eventId: "nope", actionType: "lido_claim" })).rejects.toMatchObject({ code: "event_not_found" });
  });

  it("reports a revert from eth_call without sending anything", async () => {
    const e = lidoEvent(true);
    events.push(e);
    readContract.mockResolvedValue([{ amountOfStETH: 1n, owner: OWNER, isFinalized: true, isClaimed: false }]);
    call.mockRejectedValue(new Error("execution reverted: RequestAlreadyClaimed at https://mainnet.infura.io/v3/secret"));
    const plan = await buildActionPlan({ owner: OWNER, eventId: e.id, actionType: "lido_claim" });
    expect(plan.simulation.ok).toBe(false);
    expect(plan.simulation.error).not.toContain("infura");
  });
});

describe("buildProposal", () => {
  it("claimable Lido withdrawal → schema-valid rule-based proposal", async () => {
    const e = lidoEvent(true);
    events.push(e);
    const p = await buildProposal(OWNER, e.id);
    expect(p?.generator).toBe("rule-based");
    expect(p?.options.map((o) => o.id)).toEqual(["A", "B"]);
    expect(p?.options[1]!.currentYield).toBeCloseTo(0.025);
    expect(p?.facts.join(" ")).toContain("2 stETH");
  });
  it("pending withdrawal → no proposal", async () => {
    const e = lidoEvent(false);
    events.push(e);
    expect(await buildProposal(OWNER, e.id)).toBeNull();
  });
});
