/**
 * Timeline derivation — TimelineEvent の status 導出 / 並べ替え / window / 日付 grouping、
 * Solana UnifiedTimeEvent からの射影、block → 時刻推定 (docs/web/WORKLOG.md)。
 *
 * 全関数 pure (now は引数で注入)。Web / BFF / MCP Server で共有する。
 */

import type { CustomEvent } from "../types/custom-event";
import type { UnifiedTimeEventDTO } from "../types/unified-time-event";
import type {
  TimelineAction,
  TimelineDisplayStatus,
  TimelineEvent,
  TimelineStatus,
} from "../types/timeline";

const DAY_MS = 86_400_000;

/** Ethereum v3 §4: due → overdue の境界 (期日から 24h) */
export const OVERDUE_AFTER_MS = DAY_MS;

/** Home Timeline の既定 window (UI v2 §7「default 30 days, configurable constant」) */
export const HOME_TIMELINE_WINDOW_DAYS = 30;

function hasOpenAction(event: TimelineEvent): boolean {
  return event.actions.some((a) => a.availability !== "unsupported");
}

/**
 * status を at / 状態 / now から導出する (保存しない、v3 §4)。
 */
export function deriveTimelineStatus(event: TimelineEvent, now: Date): TimelineStatus {
  if (event.class === "executed") {
    return event.outcome === "failed" ? "failed" : "done";
  }
  if (event.cancelled) return "cancelled";
  if (event.settled) return "done";
  if (event.at === null) return "upcoming"; // ETA 不明 (pending)
  const at = Date.parse(event.at);
  if (Number.isNaN(at)) return "upcoming";
  const diff = now.getTime() - at;
  if (diff < 0) return "upcoming";
  // user_plan: 当日中は due。action の無い予定 (custom plan のメモ等) は過ぎたら done、
  // action 付き (Aqua strategy review 等) は未処理として overdue
  if (event.class === "user_plan") return diff < DAY_MS ? "due" : event.actions.length === 0 ? "done" : "overdue";
  if (!hasOpenAction(event)) return "done";
  return diff < OVERDUE_AFTER_MS ? "due" : "overdue";
}

/**
 * UI v2 §7 の表示 status (色 + 非色 cue)。
 * - user_plan (未完了) → planned
 * - upcoming / due → upcoming
 * - overdue → warning
 * - done / cancelled → completed
 * - failed → failed
 */
export function displayStatus(event: TimelineEvent, status: TimelineStatus): TimelineDisplayStatus {
  if (status === "failed") return "failed";
  if (status === "done" || status === "cancelled") return "completed";
  if (event.class === "user_plan") return "planned";
  if (status === "overdue") return "warning";
  return "upcoming";
}

/**
 * 安定 chronological sort (UI v2 §7): at 昇順、ETA 不明は末尾、
 * 同時刻は protocol 名 → title で tie-break。
 */
export function sortTimeline<T extends TimelineEvent>(events: readonly T[]): T[] {
  const key = (e: TimelineEvent) => (e.at === null ? Number.POSITIVE_INFINITY : Date.parse(e.at));
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ka = key(a.e);
      const kb = key(b.e);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const pa = a.e.protocolName ?? "";
      const pb = b.e.protocolName ?? "";
      if (pa !== pb) return pa < pb ? -1 : 1;
      if (a.e.title !== b.e.title) return a.e.title < b.e.title ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

/**
 * 今から days 日先までの event (Home Timeline: 過去は含めない、UI v2 §7)。
 * `includeOpenPast` = true なら期日を過ぎても未処理の event (due / overdue) を残す
 * (v3 §4「OVERDUE を最初に見せる」)。ETA 不明の pending は window 内として扱う。
 */
export function windowTimeline<T extends TimelineEvent>(
  events: readonly T[],
  now: Date,
  days: number,
  opts: { includeOpenPast?: boolean } = {}
): T[] {
  const end = now.getTime() + days * DAY_MS;
  return events.filter((e) => {
    if (e.at === null) return e.class !== "executed" && !e.settled;
    const t = Date.parse(e.at);
    if (t >= now.getTime() && t <= end) return true;
    if (t < now.getTime() && opts.includeOpenPast) {
      const s = deriveTimelineStatus(e, now);
      return s === "due" || s === "overdue";
    }
    return false;
  });
}

/** local 日付 key (yyyy-MM-dd)。Date#getFullYear 等は実行環境の local TZ */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface TimelineDayGroup<T> {
  /** yyyy-MM-dd (local)、ETA 不明は "unscheduled" */
  day: string;
  events: T[];
}

/** 同日の event を 1 グループにまとめる (入力順を保持、UI v2 §7 Grouping) */
export function groupTimelineByDay<T extends TimelineEvent>(events: readonly T[]): TimelineDayGroup<T>[] {
  const groups: TimelineDayGroup<T>[] = [];
  const index = new Map<string, TimelineDayGroup<T>>();
  for (const e of events) {
    const key = e.at === null ? "unscheduled" : dayKey(new Date(e.at));
    let g = index.get(key);
    if (!g) {
      g = { day: key, events: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups;
}

/** day key → その日の event (Calendar grid 用索引) */
export function indexTimelineByDay<T extends TimelineEvent>(events: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const e of events) {
    if (e.at === null) continue;
    const k = dayKey(new Date(e.at));
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  }
  return m;
}

/**
 * 月 grid の日リスト。常に 6 週 (42 日) を返し、月送りで grid 高さが変わらない
 * (mobile MonthGrid.tsx の gridDaysOfMonth と同じ規約、DST 安全に日付単位で加算)。
 */
export function monthGridDays(month: Date, weekStartsOn: 0 | 1 = 1): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const out: Date[] = [];
  for (let i = 0; i < 42; i++) {
    out.push(new Date(first.getFullYear(), first.getMonth(), 1 - offset + i));
  }
  return out;
}

/**
 * block 番号から時刻を推定する (CCA は block 単位、v3 §17: 12 s/block、概算表示)。
 * block 番号は金融値ではないので number で扱う (CLAUDE.md §3 適用外)。
 */
export function estimateBlockTime(
  targetBlock: number,
  current: { block: number; timestampSec: number },
  secondsPerBlock = 12
): string {
  const sec = current.timestampSec + (targetBlock - current.block) * secondsPerBlock;
  return new Date(sec * 1000).toISOString();
}

const PROTOCOL_DISPLAY: Record<string, string> = {
  kamino: "Kamino",
  jupiter: "Jupiter",
  "jupiter-lend": "Jupiter Lend",
  orca: "Orca",
  meteora: "Meteora",
  save: "Save",
  exponent: "Exponent",
  solana: "Solana",
  jito: "Jito",
  marinade: "Marinade",
};

function protocolDisplayName(protocol: string): string {
  const key = protocol.toLowerCase();
  return PROTOCOL_DISPLAY[key] ?? protocol.charAt(0).toUpperCase() + protocol.slice(1);
}

/**
 * Solana UnifiedTimeEventDTO → TimelineEvent。
 * - metadata.source === "helius_tx" (wallet tx 履歴) は executed class
 * - それ以外は protocol class
 * - Seeker と同じく action は event.actions から取る。Web には MWA 署名経路が無いので
 *   availability は "unsupported" (実行済みのように見せない)
 */
export function fromUnifiedTimeEventDTO(dto: UnifiedTimeEventDTO, observedAt: string): TimelineEvent {
  const meta = dto.metadata ?? {};
  const isTx = meta.source === "helius_tx";
  const headline = typeof meta.headline === "string" ? meta.headline : null;
  const actions: TimelineAction[] = dto.actions.map((a) => ({
    actionType: a.actionType,
    label: a.label,
    requiresWallet: true,
    availability: "unsupported",
    reason: "Solana signing runs on the Seeker app (MWA). Web shows it read-only.",
    params: {},
  }));
  const signature = typeof meta.signature === "string" ? meta.signature : null;
  return {
    id: `solana:${dto.protocol}:${dto.category}:${dto.id}`,
    chain: "solana",
    class: isTx ? "executed" : "protocol",
    kind: dto.category,
    protocol: dto.protocol.toLowerCase(),
    protocolName: protocolDisplayName(dto.protocol),
    title: headline ?? `${protocolDisplayName(dto.protocol)} ${dto.category.replace(/_/g, " ")}`,
    at: dto.triggerAt,
    atApprox: false,
    settled: false,
    ...(isTx ? { outcome: "success" as const } : {}),
    metrics: [],
    actions,
    requiresWallet: true,
    owner: dto.walletAddress,
    links: signature ? [{ label: "View on Solscan", url: `https://solscan.io/tx/${signature}` }] : [],
    source: typeof meta.source === "string" ? meta.source : "seasonals-bff",
    observedAt,
  };
}

export const CUSTOM_EVENT_SOURCE = "local:custom";

/** Calendar に手入力した予定か (編集 / 削除できるのはこれだけ) */
export function isCustomPlan(event: TimelineEvent): boolean {
  return event.source === CUSTOM_EVENT_SOURCE;
}

/**
 * ユーザーが手入力した CustomEvent → TimelineEvent (user_plan)。
 * 日付のみの予定なので at はその日の local 0 時、allDay = true。chain 非依存 (null)。
 */
export function fromCustomEvent(ce: CustomEvent, observedAt: string): TimelineEvent {
  const [y, m, d] = ce.date.split("-").map(Number) as [number, number, number];
  return {
    id: `custom:${ce.id}`,
    chain: null,
    class: "user_plan",
    kind: "user_note",
    protocol: null,
    protocolName: null,
    title: ce.title,
    at: new Date(y, m - 1, d).toISOString(),
    allDay: true,
    atApprox: false,
    settled: false,
    ...(ce.marker === "emoji" && ce.emoji ? { emoji: ce.emoji } : {}),
    metrics: ce.note ? [{ label: "Note", kind: "text", value: ce.note }] : [],
    actions: [],
    requiresWallet: false,
    links: [],
    source: CUSTOM_EVENT_SOURCE,
    observedAt,
  };
}

/** 再導出時の merge (v3 §4: id で上書き、重複を溜めない) */
export function mergeTimelineEvents(...lists: ReadonlyArray<readonly TimelineEvent[]>): TimelineEvent[] {
  const m = new Map<string, TimelineEvent>();
  for (const list of lists) for (const e of list) m.set(e.id, e);
  return [...m.values()];
}
