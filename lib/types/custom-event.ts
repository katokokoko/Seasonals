/**
 * CustomEvent — ユーザーが Calendar 上に手動で作成する marker
 *
 * UnifiedTimeEvent (§11.4 protocol 由来) と異なり、user 手動入力。
 * lockup 期限・税務メモ・社内 notification 等の任意イベントを持つ。
 *
 * 永続化: Mobile 側で AsyncStorage (`seasonals.customEvents.v1` key)、Web は localStorage
 * (`seasonals-web-custom-events-v1`)。BFF / MCP には今のところ送らない (個人 metadata)。
 * Calendar / Timeline へは `fromCustomEvent` (lib/derive/timeline.ts) で TimelineEvent に射影する。
 */

import type { PositionCategory } from "./enums";

export type CustomEventMarker = "circle" | "square" | "star" | "emoji";

export interface CustomEvent {
  /** "ce_<timestamp>_<rand>" 形式の一意 ID */
  id: string;
  /** "yyyy-MM-dd" (ローカル日付) — UnifiedTimeEvent の triggerAt と異なり時刻なし */
  date: string;
  title: string;
  /** 予定のメモ (任意) */
  note?: string;
  /** USD 概算 (任意、null なら金額表示なし) */
  amount_usd?: number;
  /** §5.2 PositionCategory のいずれか (色分け用) */
  category: PositionCategory;
  /** marker shape — emoji を選んだ場合は emoji field 必須 */
  marker: CustomEventMarker;
  /** marker === "emoji" のときの絵文字 (1 grapheme) */
  emoji?: string;
  /** ISO 8601 */
  created_at: string;
}

/** 入力 form 用、id / created_at は生成側で付与 */
export type CustomEventInput = Omit<CustomEvent, "id" | "created_at">;
