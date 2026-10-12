/**
 * SKR cooldown の表示文言 (docs/skr-r0-implementation.md §3 / §4)。Staking row と Calendar 詳細が共有する純関数。
 *
 * 規則:
 * - 取得できない量・元本・収益・USD・ROI は "—" (ゼロで埋めない)
 * - stale / unavailable / unsupported の時に「引き出し可能」と断定しない。取消済みとも解釈しない
 * - 端末時刻だけで ready にしない (chain Clock が cooling_down なら「確認待ち」)
 * - 金額は lib/utils/numeric の formatTokenAmount を UI 直前でだけ使う
 */
import { SKR_STAKING_PROTOCOL_ID } from "@workspace/lib/config/skr-staking";
import {
  CooldownPendingStatus,
  CooldownSource,
  type CooldownPositionView,
  type UnifiedTimeEvent,
} from "@workspace/lib/types";
import { formatTokenAmount } from "@workspace/lib/utils/numeric";

import type { SkrStakingView } from "../../services/useSkrStakingView";

export const NOT_AVAILABLE = "—";

export type CooldownDisplayKind =
  | "loading"
  | "unavailable"
  | "unsupported"
  | "empty"
  | "position";

export type CooldownStatusTone = "neutral" | "positive" | "muted";

export interface CooldownDisplay {
  kind: CooldownDisplayKind;
  /** source=demo (録画用) なら必ず "Demo" を表示する */
  isDemo: boolean;
  /** 観測値が古い / 再取得失敗 (表示は残すが断定しない) */
  isStale: boolean;
  /** 「ステーク中（推定）」 */
  stakedEstimate: string;
  /** 「解除待ち」の量 */
  pending: string;
  status: string;
  statusTone: CooldownStatusTone;
  /** "Observed 14:21" (+ "· awaiting update") */
  observed: string | null;
}

function amount(v: string | null, p: CooldownPositionView): string {
  if (v === null) return NOT_AVAILABLE;
  return `${formatTokenAmount(v, p.asset_decimals, { maxFractionDigits: 2 })} ${p.asset_symbol}`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function statusFor(
  p: CooldownPositionView,
  stale: boolean,
  nowMs: number
): { status: string; tone: CooldownStatusTone } {
  switch (p.pending_status) {
    case CooldownPendingStatus.None:
      return { status: "No unstake pending", tone: "muted" };
    case CooldownPendingStatus.Unknown:
      return { status: "Unlock time unavailable", tone: "muted" };
    case CooldownPendingStatus.Ready:
      return stale
        ? { status: "Checking withdrawal status…", tone: "muted" }
        : { status: "Withdrawable on the official portal", tone: "positive" };
    case CooldownPendingStatus.CoolingDown: {
      if (!p.unlock_at) return { status: "Cooling down", tone: "neutral" };
      const ends = shortTime(p.unlock_at);
      if (stale) return { status: `Cooling down · ends ${ends} (last seen)`, tone: "muted" };
      // chain Clock はまだ cooling_down。端末時刻が過ぎていても ready とは言わない
      if (nowMs >= Date.parse(p.unlock_at)) {
        return { status: `Cooldown ending · waiting for on-chain confirmation`, tone: "neutral" };
      }
      return { status: `Cooling down · ends ${ends}`, tone: "neutral" };
    }
  }
}

export function cooldownDisplay(view: SkrStakingView, nowMs: number = Date.now()): CooldownDisplay {
  const state = view.state;
  const isDemo = (state?.source ?? view.scope?.source) === CooldownSource.Demo;
  const isStale = view.freshness === "stale";
  const base = {
    isDemo,
    isStale,
    stakedEstimate: NOT_AVAILABLE,
    pending: NOT_AVAILABLE,
    observed: state?.observed_at
      ? `Observed ${shortTime(state.observed_at)}${isStale ? " · awaiting update" : ""}`
      : null,
  };

  if (!state) {
    if (view.freshness === "unavailable") {
      return { ...base, kind: "unavailable", status: "Couldn't load · awaiting update", statusTone: "muted" };
    }
    return { ...base, kind: "loading", status: "Loading…", statusTone: "muted" };
  }
  if (view.freshness === "unavailable") {
    return { ...base, kind: "unavailable", status: "Couldn't load · awaiting update", statusTone: "muted" };
  }
  if (view.freshness === "unsupported") {
    return { ...base, kind: "unsupported", status: "This staking setup isn't supported yet", statusTone: "muted" };
  }
  const p = state.position;
  if (!p) {
    return { ...base, kind: "empty", status: "No SKR staked in this pool", statusTone: "muted" };
  }
  const { status, tone } = statusFor(p, isStale, nowMs);
  return {
    ...base,
    kind: "position",
    stakedEstimate: amount(p.active_amount_estimate, p),
    pending: p.pending_status === CooldownPendingStatus.None ? NOT_AVAILABLE : amount(p.pending_amount, p),
    status,
    statusTone: tone,
  };
}

/** SKR cooldown の calendar event か (actions 空。ActionModal へ渡さない) */
export function isCooldownCalendarEvent(event: Pick<UnifiedTimeEvent, "protocol">): boolean {
  return event.protocol === SKR_STAKING_PROTOCOL_ID;
}
