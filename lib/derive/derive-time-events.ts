/**
 * deriveTimeEvents — 決定的な時間イベント導出 (Phase 8.20、§26.2 / §13.1)
 *
 * 仕様 §26.2 の adapter `deriveTimeEvents(position)` の lib 実装。
 * Mobile / BFF / MCP Server が同じ導出規則を import する ("same source of truth")。
 *
 * 決定性 (§26.3 / §29.1 golden test):
 *   時刻依存の判定は **すべて DeriveContext.now に閉じる** — 同じ
 *   (snapshot, ctx) には常に同じ UnifiedTimeEvent[] を返す。Date.now() 禁止。
 *
 * PositionSnapshot は §26.2 NormalizedPosition の v1 subset。live protocol が
 * 埋められるフィールドだけを任意で持ち、有るものからイベントを導出する:
 *   health          → health (Kamino obligation 等)
 *   claimable       → claim (LP feeOwed 等、withdraw 経路があれば action 付き)
 *   maturity_at     → maturity      (Loopscale 等の固定満期 — adapter 未実装、規則先行)
 *   unlock_at       → lockup_end    (native stake 解除 / Streamflow unlock)
 *   vesting_cliff_at→ vesting_cliff (Streamflow — adapter 未実装、規則先行)
 *   vote_deadline_at→ vote_deadline (governance — adapter 未実装、規則先行)
 *   forecast        → forecast_marker
 *   ctx.epoch       → epoch (wallet 単位で 1 回 — deriveAllTimeEvents が付与)
 *
 * §4.5: claimable.amount は smallest-unit string。表示は toHumanReadable 経由。
 */

import { TimeEventCategory, Urgency } from "../types/enums";
import type {
  ActionDescriptor,
  UnifiedTimeEvent,
} from "../types/unified-time-event";
import { toHumanReadable } from "../utils/numeric";

/** §26.2 NormalizedPosition の v1 subset (導出入力) */
export interface PositionSnapshot {
  /** protocol_id ("kamino" / "orca" / "meteora" / "solana" 等) */
  protocol: string;
  /** obligation address / position mint / stake account 等 (event id の suffix) */
  position_ref: string | null;
  /** LTV ベースの health (borrow がある lending position のみ) */
  health?: { ltv: number; liquidation_ltv: number };
  /** 未請求報酬 (LP feeOwed 等)。amount は smallest-unit string (§4.5) */
  claimable?: {
    amount: string;
    symbol: string;
    decimals: number;
    /**
     * Phase 8.21: これ以上なら urgency を watch に上げる閾値 (smallest string、
     * 「回収する価値がある」シグナル)。未指定なら常に info。
     */
    watch_amount?: string;
    /** withdraw で claim できる場合の synthetic plan 用フィールド (mobile が使う) */
    withdraw?: {
      share_mint: string;
      share_decimals: number;
      underlying_decimals: number;
      underlying_amount: string;
      shares: string;
      asset_symbol: string;
    };
  };
  /** 固定満期 (ISO 8601) */
  maturity_at?: string;
  /**
   * Phase 8.34: 満期到達後に redeem (withdraw) できる場合の synthetic plan 用
   * フィールド (claimable.withdraw と同形、mobile が使う)。指定時のみ maturity
   * イベントに Redeem action が付く (未指定 = read-only、fail-closed)。
   */
  maturity_redeem?: {
    share_mint: string;
    share_decimals: number;
    underlying_decimals: number;
    underlying_amount: string;
    shares: string;
    asset_symbol: string;
  };
  /** lock 解除 / stake deactivation 完了 (ISO 8601)。過去日 = 解除済 (withdrawable) */
  unlock_at?: string;
  /** vesting cliff (ISO 8601) */
  vesting_cliff_at?: string;
  /** governance 投票期限 (ISO 8601) */
  vote_deadline_at?: string;
  /** forecast 通過点 (§14) */
  forecast?: { at: string; headline: string };
  /** event.metadata へ merge する追加情報 (source の上書きも可) */
  metadata?: Record<string, unknown>;
}

export interface DeriveContext {
  /** 決定性のため呼び手が渡す (Date.now() を関数内で呼ばない) */
  now: Date;
  /** イベントの帰属 wallet */
  wallet: string;
  /** epoch 境界イベント (wallet 単位 1 回、deriveAllTimeEvents が付与) */
  epoch?: { epoch: number; endsAtIso: string; holdsLst: boolean };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 期日イベントの draft urgency: ≤1日 (過去含む) critical / ≤7日 watch / info */
function proximityUrgency(at: Date, now: Date): Urgency {
  const ms = at.getTime() - now.getTime();
  if (ms <= DAY_MS) return Urgency.Critical;
  if (ms <= 7 * DAY_MS) return Urgency.Watch;
  return Urgency.Info;
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function baseEvent(
  id: string,
  category: TimeEventCategory,
  p: PositionSnapshot,
  ctx: DeriveContext,
  triggerAt: Date,
  urgency: Urgency,
  headline: string,
  extra: Record<string, unknown>,
  actions: ActionDescriptor[] = []
): UnifiedTimeEvent {
  return {
    id,
    protocol: p.protocol,
    category,
    triggerAt,
    urgency,
    walletAddress: ctx.wallet,
    positionRef: p.position_ref,
    actions,
    agentReadable: true,
    // snapshot.metadata を最後に spread — 呼び手が source 等を上書きできる
    metadata: { headline, ...extra, ...(p.metadata ?? {}) },
  };
}

/**
 * 1 position snapshot → UnifiedTimeEvent[] (決定的)。
 * epoch イベントは position 由来でないためここでは返さない (deriveAllTimeEvents)。
 */
export function deriveTimeEvents(
  p: PositionSnapshot,
  ctx: DeriveContext
): UnifiedTimeEvent[] {
  const out: UnifiedTimeEvent[] = [];
  const ref = p.position_ref ?? p.protocol;

  // health — 既存 BFF 閾値を継承: ratio ≥0.9 critical / ≥0.7 watch / 未満は出さない
  if (p.health && p.health.liquidation_ltv > 0) {
    const ratio = p.health.ltv / p.health.liquidation_ltv;
    if (ratio >= 0.7) {
      out.push(
        baseEvent(
          `health_${ref}`,
          TimeEventCategory.Health,
          p,
          ctx,
          ctx.now,
          ratio >= 0.9 ? Urgency.Critical : Urgency.Watch,
          `${capitalize(p.protocol)} LTV ${(p.health.ltv * 100).toFixed(1)}% (liquidation at ${(p.health.liquidation_ltv * 100).toFixed(1)}%)`,
          {
            source: "health",
            loan_to_value: p.health.ltv,
            liquidation_ltv: p.health.liquidation_ltv,
          }
          // actions は fail-closed で空 (repay 経路が実装されるまで)
        )
      );
    }
  }

  // claim — 未請求報酬 > 0。withdraw 経路があれば event-driven action (§29.1)
  if (p.claimable && /^[0-9]+$/.test(p.claimable.amount) && BigInt(p.claimable.amount) > 0n) {
    const human = toHumanReadable(p.claimable.amount, p.claimable.decimals);
    const actions: ActionDescriptor[] = p.claimable.withdraw
      ? [
          {
            actionType: "withdraw",
            label: "Withdraw & claim",
            requiresApproval: true,
            riskLevel: "medium",
          },
        ]
      : [];
    // Phase 8.21: 閾値以上の fee は watch (回収する価値があるシグナル)
    const watchAmount = p.claimable.watch_amount;
    const claimUrgency =
      watchAmount &&
      /^[0-9]+$/.test(watchAmount) &&
      BigInt(p.claimable.amount) >= BigInt(watchAmount)
        ? Urgency.Watch
        : Urgency.Info;
    out.push(
      baseEvent(
        `claim_${ref}`,
        TimeEventCategory.Claim,
        p,
        ctx,
        ctx.now,
        claimUrgency,
        `${human} ${p.claimable.symbol} fees claimable on ${capitalize(p.protocol)}`,
        {
          source: "claimable",
          claim_amount: p.claimable.amount,
          claim_symbol: p.claimable.symbol,
          claim_decimals: p.claimable.decimals,
          // synthetic withdraw plan 用 (mobile handleActionPress が読む)
          ...(p.claimable.withdraw
            ? { protocol_id: p.protocol, ...p.claimable.withdraw }
            : {}),
        },
        actions
      )
    );
  }

  // 期日系 4 カテゴリ — ISO 日付 → proximity urgency
  if (p.maturity_at) {
    const at = new Date(p.maturity_at);
    // Phase 8.34: 満期済 + redeem 情報があれば Redeem action (claim 分岐と同型、
    // actionType は canonical "withdraw" — enum 追加はしない §32.2)
    const matured = at.getTime() <= ctx.now.getTime();
    const actions: ActionDescriptor[] =
      matured && p.maturity_redeem
        ? [
            {
              actionType: "withdraw",
              label: "Redeem",
              requiresApproval: true,
              riskLevel: "medium",
            },
          ]
        : [];
    out.push(
      baseEvent(
        `maturity_${ref}`,
        TimeEventCategory.Maturity,
        p,
        ctx,
        at,
        proximityUrgency(at, ctx.now),
        `${capitalize(p.protocol)} position matures`,
        {
          source: "maturity",
          // synthetic plan 用 metadata (mobile syntheticPlanFromEventAction が読む)
          ...(matured && p.maturity_redeem
            ? { protocol_id: p.protocol, ...p.maturity_redeem }
            : {}),
        },
        actions
      )
    );
  }
  if (p.unlock_at) {
    const at = new Date(p.unlock_at);
    const unlocked = at.getTime() <= ctx.now.getTime();
    out.push(
      baseEvent(
        `lockup_end_${ref}`,
        TimeEventCategory.LockupEnd,
        p,
        ctx,
        at,
        // 解除済は「行動可能」の watch (critical にはしない — 資金は安全)
        unlocked ? Urgency.Watch : proximityUrgency(at, ctx.now),
        unlocked
          ? `${capitalize(p.protocol)} stake withdrawable now`
          : `${capitalize(p.protocol)} lockup ends`,
        { source: "lockup", unlocked }
      )
    );
  }
  if (p.vesting_cliff_at) {
    const at = new Date(p.vesting_cliff_at);
    out.push(
      baseEvent(
        `vesting_cliff_${ref}`,
        TimeEventCategory.VestingCliff,
        p,
        ctx,
        at,
        proximityUrgency(at, ctx.now),
        `${capitalize(p.protocol)} vesting cliff`,
        { source: "vesting" }
      )
    );
  }
  if (p.vote_deadline_at) {
    const at = new Date(p.vote_deadline_at);
    out.push(
      baseEvent(
        `vote_deadline_${ref}`,
        TimeEventCategory.VoteDeadline,
        p,
        ctx,
        at,
        proximityUrgency(at, ctx.now),
        `${capitalize(p.protocol)} vote deadline`,
        { source: "governance" }
      )
    );
  }

  // forecast_marker — 情報提供の通過点 (§14)
  if (p.forecast) {
    out.push(
      baseEvent(
        `forecast_${ref}`,
        TimeEventCategory.ForecastMarker,
        p,
        ctx,
        new Date(p.forecast.at),
        Urgency.Info,
        p.forecast.headline,
        { source: "forecast" }
      )
    );
  }

  return out;
}

/**
 * wallet の全 snapshot → イベント集約 + epoch 境界イベント (1 回だけ)。
 * epoch は position 由来でない wallet-scoped イベントのため、LST を保持して
 * いれば snapshot が 0 件でも出る。
 */
export function deriveAllTimeEvents(
  snapshots: PositionSnapshot[],
  ctx: DeriveContext
): UnifiedTimeEvent[] {
  const out = snapshots.flatMap((p) => deriveTimeEvents(p, ctx));
  if (ctx.epoch?.holdsLst) {
    out.push({
      id: `epoch_${ctx.epoch.epoch}`,
      protocol: "solana",
      category: TimeEventCategory.Epoch,
      triggerAt: new Date(ctx.epoch.endsAtIso),
      urgency: Urgency.Info,
      walletAddress: ctx.wallet,
      positionRef: null,
      actions: [],
      agentReadable: true,
      metadata: {
        source: "epoch_info",
        epoch: ctx.epoch.epoch,
        headline: `Epoch ${ctx.epoch.epoch} ends — staking rewards finalize`,
      },
    });
  }
  return out;
}
