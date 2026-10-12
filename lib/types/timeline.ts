/**
 * TimelineEvent — chain 非依存の時間イベント view model (docs/web/WORKLOG.md)
 *
 * Web の Calendar / Timeline、BFF の /eth/*、MCP Server の list_events が共有する。
 * Solana の UnifiedTimeEvent (§11.4) は `fromUnifiedTimeEventDTO` (lib/derive/timeline.ts)
 * で本型へ射影する。UnifiedTimeEvent 自体は変更しない。
 *
 * 3 つの event class を型で区別する (Ethereum v3 §1 "Never blend them"):
 * - protocol:  on-chain / protocol API から導出された事実
 * - user_plan: ユーザー (または Agent が代理で) 作成した予定。唯一編集可能
 * - executed:  アプリが組み立てた action の receipt を観測した実行履歴
 *
 * 数値表現規約 (CLAUDE.md §3):
 * - token amount は smallest unit の string + decimals
 * - USD は 8 decimals string。価格不明なら undefined (0 にしない)
 * - APY 等の比率 (0..1) は number でよい
 */

import type { ChainId } from "../config/chains";
import type { TimeEventCategory } from "./enums";

export const TIMELINE_EVENT_CLASSES = ["protocol", "user_plan", "executed"] as const;
export type TimelineEventClass = (typeof TIMELINE_EVENT_CLASSES)[number];

/** Ethereum v3 §4 の EventKind (snake_case 化)。Solana は TimeEventCategory をそのまま使う */
export const ETHEREUM_EVENT_KINDS = [
  "pt_maturity",
  "cooldown_end",
  "withdrawal_pending",
  "withdrawal_claimable",
  "auction_start",
  "auction_end",
  "auction_claim",
  "auction_refund",
  "strategy_review",
] as const;
export type EthereumEventKind = (typeof ETHEREUM_EVENT_KINDS)[number];

/** agent_proposal: Agent が提案し、人の承認を待っているリバランス (eth-agent-proposal.ts) */
export const USER_EVENT_KINDS = ["user_cashflow", "user_note", "action_executed", "agent_proposal"] as const;
export type UserEventKind = (typeof USER_EVENT_KINDS)[number];

export type TimelineEventKind = TimeEventCategory | EthereumEventKind | UserEventKind;

/**
 * 導出 status (Ethereum v3 §4): 保存せず `deriveTimelineStatus` で render 時に決める。
 * - upcoming: 未来
 * - due: 期日を過ぎて 24h 以内、かつ未処理の action がある
 * - overdue: 期日を 24h 以上過ぎ、未処理の action がある (満期 PT 未 redeem 等)
 * - done: 処理済み / 実行成功 / 期日を過ぎた情報イベント
 * - cancelled / failed
 */
export const TIMELINE_STATUSES = ["upcoming", "due", "overdue", "done", "cancelled", "failed"] as const;
export type TimelineStatus = (typeof TIMELINE_STATUSES)[number];

/** UI v2 §7 の表示 status (色 + 非色 cue で区別) */
export const TIMELINE_DISPLAY_STATUSES = ["upcoming", "planned", "completed", "warning", "failed"] as const;
export type TimelineDisplayStatus = (typeof TIMELINE_DISPLAY_STATUSES)[number];

export interface TokenAmountView {
  /** smallest unit (整数 string) */
  value: string;
  decimals: number;
  symbol: string;
}

/** 詳細カードに出す labeled metric。値は必ず label とセット (UI v2 §4) */
export type TimelineMetric =
  | { label: string; kind: "ratio"; value: number } // APY 等 0..1
  | { label: string; kind: "usd"; value: string } // 8 decimals string
  | { label: string; kind: "token"; value: TokenAmountView }
  | { label: string; kind: "text"; value: string };

export type TimelineActionAvailability =
  /** 今すぐ実行 (または unsigned plan 取得) 可能 */
  | "available"
  /** 時刻・状態が未到来 (例: cooldown 中の unstake) */
  | "not_yet"
  /** このクライアントでは未実装 / 未検証 — 実行済みのように見せない */
  | "unsupported";

export interface TimelineAction {
  /** snake_case。Solana は ActionType (lib/types/enums.ts)、Ethereum は v3 §10 の action を snake_case 化 */
  actionType: string;
  label: string;
  /** 接続 wallet (署名 or 所有者) が必要か */
  requiresWallet: boolean;
  availability: TimelineActionAvailability;
  /** availability が available 以外の理由 (UI にそのまま表示できる短文) */
  reason?: string;
  /** build_action に渡す protocol 固有パラメータ (すべて string) */
  params: Record<string, string>;
}

export interface TimelineLink {
  label: string;
  url: string;
}

export interface TimelineEvent {
  /** 安定 ID: `${chain}:${protocol}:${kind}:${ref}` (再導出時に id で merge) */
  id: string;
  /** null = chain 非依存 (ユーザーが Calendar に手入力した custom plan、`fromCustomEvent`) */
  chain: ChainId | null;
  class: TimelineEventClass;
  kind: TimelineEventKind;
  /** protocol id (pendle / ethena / lido / cca / kamino …)。user_plan は null */
  protocol: string | null;
  /** 表示名 (Pendle / Ethena …) */
  protocolName: string | null;
  title: string;
  /** asset / position の短い表記 (PT-sUSDe 27NOV2026、wstETH …) */
  asset?: string;
  /** ISO 8601。ETA 不明 (Lido 未 finalize 等) なら null */
  at: string | null;
  /** 日付のみで時刻を持たない予定 (custom plan)。at はその日の local 0 時。UI は時刻の代わりに "All day" */
  allDay?: boolean;
  /** custom plan の絵文字 marker (1 grapheme)。あれば droplet の代わりに出す */
  emoji?: string;
  /** block 推定などの概算時刻か (UI は "≈" を付ける) */
  atApprox: boolean;
  etaNote?: string;
  /** protocol 上の義務が完了済み (claim 済み / redeem 済み) */
  settled: boolean;
  /** protocol 側で取り消された (auction 不成立 等) */
  cancelled?: boolean;
  /** executed class の結果 */
  outcome?: "success" | "failed";
  amount?: TokenAmountView;
  /** 8 decimals USD string。価格不明なら undefined */
  usd?: string;
  metrics: TimelineMetric[];
  actions: TimelineAction[];
  /** false = wallet 非依存の公開イベント (未接続時に表示してよい) */
  requiresWallet: boolean;
  /** wallet 依存イベントの所有 address */
  owner?: string;
  links: TimelineLink[];
  /** データの出所 ("pendle-api", "susde.cooldowns", "helius_tx" …) */
  source: string;
  /** 観測時刻 (ISO) — Agent が鮮度を判断できるように必ず付ける */
  observedAt: string;
}

/** BFF /eth/events 等の response envelope */
export interface TimelineEventsResponse {
  events: TimelineEvent[];
  /** adapter ごとの成否 (部分失敗でも 200 で返す) */
  sources: Array<{ source: string; ok: boolean; error?: string; observedAt: string }>;
}
