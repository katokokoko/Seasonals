/**
 * event-action — カレンダーイベント起点の action 起動 (Phase 8.20、§29.1)
 *
 * UnifiedTimeEvent の ActionDescriptor tap から ActionModal 用の synthetic
 * AgentPlan を組む純関数。BFF の claim イベント (lib deriveTimeEvents) が
 * event.metadata に詰めた synthetic plan 用フィールド (protocol_id / share_mint /
 * shares / decimals) を読む — MenuDrawer の handleWithdrawPosition と同形。
 *
 * metadata が揃っていなければ null (呼び手は fixture plan lookup に fallback)。
 */
import { AgentPlanStatus } from "@workspace/lib/types";
import type {
  ActionDescriptor,
  AgentPlan,
  UnifiedTimeEvent,
} from "@workspace/lib/types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * withdraw 系イベント action → synthetic withdraw plan。
 * 対応: claim イベントの "Withdraw & claim" (LP fee は withdraw で回収される)。
 */
export function syntheticPlanFromEventAction(
  event: UnifiedTimeEvent,
  action: ActionDescriptor
): AgentPlan | null {
  if (action.actionType !== "withdraw") return null;
  const md = event.metadata ?? {};
  const protocol = str(md.protocol_id);
  const asset = str(md.asset_symbol);
  const shares = str(md.shares);
  const shareMint = str(md.share_mint);
  const shareDecimals = num(md.share_decimals);
  const underlyingDecimals = num(md.underlying_decimals);
  const underlyingAmount = str(md.underlying_amount);
  if (
    !protocol ||
    !asset ||
    !shares ||
    !shareMint ||
    shareDecimals === null ||
    underlyingDecimals === null ||
    !underlyingAmount
  ) {
    return null;
  }
  return {
    plan_id: `synthetic_event_${event.id}_${Date.now()}`,
    status: AgentPlanStatus.PendingUser,
    objective: "rebalance",
    candidate_actions: [],
    selected_action: {
      protocol,
      asset,
      action_type: "withdraw",
      // amount = shares smallest unit (全量 withdraw 起点、ActionModal で編集可)
      amount: shares,
      metadata: {
        share_mint: shareMint,
        share_decimals: shareDecimals,
        underlying_decimals: underlyingDecimals,
        underlying_amount: underlyingAmount,
      },
    },
    simulation_result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as AgentPlan;
}
