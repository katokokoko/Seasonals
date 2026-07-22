/**
 * Phase 8.20: event-action — カレンダーイベント起点 synthetic plan のテスト。
 */
import { AgentPlanStatus, TimeEventCategory, Urgency } from "@workspace/lib/types";
import type { ActionDescriptor, UnifiedTimeEvent } from "@workspace/lib/types";

import { syntheticPlanFromEventAction } from "./event-action";

const WITHDRAW_ACTION: ActionDescriptor = {
  actionType: "withdraw",
  label: "Withdraw & claim",
  requiresApproval: true,
  riskLevel: "medium",
};

function claimEvent(metadata: Record<string, unknown>): UnifiedTimeEvent {
  return {
    id: "claim_Mint111",
    protocol: "orca",
    category: TimeEventCategory.Claim,
    triggerAt: new Date("2026-07-10T00:00:00.000Z"),
    urgency: Urgency.Info,
    walletAddress: "WaLLet111",
    positionRef: "Mint111",
    actions: [WITHDRAW_ACTION],
    agentReadable: true,
    metadata,
  };
}

const FULL_METADATA = {
  source: "lp_fee",
  protocol_id: "orca",
  asset_symbol: "USDC",
  shares: "2000000",
  share_mint: "Mint111",
  share_decimals: 6,
  underlying_decimals: 6,
  underlying_amount: "2000000",
};

describe("syntheticPlanFromEventAction", () => {
  it("8.34: maturity イベントの Redeem action → exponent withdraw synthetic plan", () => {
    const redeemAction: ActionDescriptor = {
      actionType: "withdraw",
      label: "Redeem",
      requiresApproval: true,
      riskLevel: "medium",
    };
    const event: UnifiedTimeEvent = {
      id: "maturity_PtMint111",
      protocol: "exponent",
      category: TimeEventCategory.Maturity,
      triggerAt: new Date("2026-07-01T00:00:00.000Z"),
      urgency: Urgency.Critical,
      walletAddress: "WaLLet111",
      positionRef: "PtMint111",
      actions: [redeemAction],
      agentReadable: true,
      metadata: {
        source: "exponent_pt",
        protocol_id: "exponent",
        asset_symbol: "PT-USX",
        shares: "5000000",
        share_mint: "PtMint111",
        share_decimals: 6,
        underlying_decimals: 6,
        underlying_amount: "5000000",
      },
    };
    const plan = syntheticPlanFromEventAction(event, redeemAction)!;
    expect(plan).not.toBeNull();
    const sel = plan.selected_action as unknown as {
      protocol: string;
      action_type: string;
      amount: string;
      metadata: Record<string, unknown>;
    };
    expect(sel.protocol).toBe("exponent");
    expect(sel.action_type).toBe("withdraw");
    expect(sel.amount).toBe("5000000");
    expect(sel.metadata.share_mint).toBe("PtMint111"); // ActionModal が PT redeem に解決
  });

  it("claim イベント → withdraw synthetic plan (handleWithdrawPosition と同形)", () => {
    const plan = syntheticPlanFromEventAction(claimEvent(FULL_METADATA), WITHDRAW_ACTION)!;
    expect(plan).not.toBeNull();
    expect(plan.status).toBe(AgentPlanStatus.PendingUser);
    expect(plan.plan_id).toContain("synthetic_event_claim_Mint111");
    const sel = plan.selected_action as unknown as {
      protocol: string;
      asset: string;
      action_type: string;
      amount: string;
      metadata: Record<string, unknown>;
    };
    expect(sel.protocol).toBe("orca");
    expect(sel.asset).toBe("USDC");
    expect(sel.action_type).toBe("withdraw");
    expect(sel.amount).toBe("2000000");
    expect(sel.metadata.share_mint).toBe("Mint111");
    expect(sel.metadata.share_decimals).toBe(6);
    expect(sel.metadata.underlying_amount).toBe("2000000");
  });

  it("metadata 不足 (share_mint 無し等) は null → fixture lookup へ fallback", () => {
    const { share_mint: _omit, ...rest } = FULL_METADATA;
    expect(
      syntheticPlanFromEventAction(claimEvent(rest), WITHDRAW_ACTION)
    ).toBeNull();
    expect(syntheticPlanFromEventAction(claimEvent({}), WITHDRAW_ACTION)).toBeNull();
  });

  it("withdraw 以外の actionType は null", () => {
    expect(
      syntheticPlanFromEventAction(claimEvent(FULL_METADATA), {
        ...WITHDRAW_ACTION,
        actionType: "vote",
      })
    ).toBeNull();
  });
});
