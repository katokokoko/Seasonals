/** 表示ラベル / 形状の対応 (presentation layer、値は lib の enum) */
import type { TimelineDisplayStatus, TimelineEvent, TimelineEventClass, TimelineEventKind, TimelineStatus } from "@workspace/lib/types";

export const KIND_LABEL: Record<TimelineEventKind, string> = {
  maturity: "Maturity",
  epoch: "Epoch",
  claim: "Claim",
  health: "Health",
  vesting_cliff: "Vesting cliff",
  vote_deadline: "Vote deadline",
  lockup_end: "Lockup end",
  forecast_marker: "Forecast",
  pt_maturity: "PT maturity",
  cooldown_end: "Cooldown end",
  withdrawal_pending: "Withdrawal pending",
  withdrawal_claimable: "Withdrawal claimable",
  auction_start: "Auction start",
  auction_end: "Auction end",
  auction_claim: "Auction claim",
  auction_refund: "Auction refund",
  strategy_review: "Strategy review",
  user_cashflow: "Cash flow",
  user_note: "Note",
  action_executed: "Executed",
  agent_proposal: "Agent proposal",
};

export const CLASS_LABEL: Record<TimelineEventClass, string> = {
  protocol: "Protocol event",
  user_plan: "Your plan",
  executed: "Executed",
};

export const STATUS_LABEL: Record<TimelineDisplayStatus, string> = {
  upcoming: "Upcoming",
  planned: "Planned",
  completed: "Completed",
  warning: "Needs attention",
  failed: "Failed",
};

export type DropletShape =
  | "maturity"
  | "lockup_end"
  | "epoch"
  | "claim"
  | "health"
  | "vesting_cliff"
  | "vote_deadline"
  | "forecast_marker"
  | "deposit_history";

/** droplet 形状 (docs/design-system.md §7)。Ethereum kind は意味の近い形状へ */
export function shapeForKind(kind: TimelineEventKind, cls: TimelineEventClass): DropletShape {
  if (cls === "executed") return "deposit_history";
  switch (kind) {
    case "pt_maturity":
      return "maturity";
    case "cooldown_end":
      return "lockup_end";
    case "withdrawal_pending":
    case "strategy_review":
    case "user_cashflow":
    case "user_note":
      return "forecast_marker";
    case "withdrawal_claimable":
    case "auction_claim":
    case "auction_refund":
      return "claim";
    case "auction_start":
      return "epoch";
    case "auction_end":
      return "vote_deadline";
    case "action_executed":
      return "deposit_history";
    case "agent_proposal":
      return "forecast_marker";
    default:
      return kind;
  }
}

/** status badge の文言を event の文脈で具体化する (色 / icon は表示 status のまま) */
export function statusText(e: TimelineEvent, status: TimelineStatus): string | undefined {
  if (status === "due") {
    return e.actions.some((a) => a.availability === "available" && /claim|unstake/.test(a.actionType)) ? "Claimable now" : "Due today";
  }
  if (status === "overdue") return "Overdue";
  if (status === "upcoming" && e.at === null) return "Pending";
  if (status === "cancelled") return "Cancelled";
  return undefined;
}
