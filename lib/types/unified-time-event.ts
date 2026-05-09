/**
 * UnifiedTimeEvent — 仕様書 §11.4
 *
 * Seasonals の中核データ型。8 種の TimeEventCategory を統一表現する。
 * CalendarEvent はこの型の view-layer projection。
 *
 * §32.2 整合性チェック: "8 categories of time" → TimeEventCategory が
 * §11.4 / §25.2 / §26 で同一であることを担保する。
 */

import type { TimeEventCategory, Urgency } from "./enums";

/**
 * ActionDescriptor — UnifiedTimeEvent.actions の各要素 (§24.9 / §26)
 *
 * v0.2.6 で `type/description` から `actionType/label/requiresApproval/riskLevel`
 * へ整合化された (Adapter SDK の ActionDescriptor 型と同一)。
 */
export type RiskLevel = "low" | "medium" | "high";

export interface ActionDescriptor {
  /** action の種別。仕様書 §5.7 / §24.9 の 12 種 ActionType */
  actionType: string; // ActionType だが Adapter 拡張を許容するため string
  /** UI 表示用ラベル ("Re-deposit (include yield)" 等)。snake_case の actionType と独立 */
  label: string;
  /** ユーザー承認が必要か (signing が走るアクション、すなわち資金移動を伴うものは true) */
  requiresApproval: boolean;
  /** action のリスクレベル */
  riskLevel: RiskLevel;
  /** action 固有の追加メタデータ (任意) */
  metadata?: Record<string, unknown>;
}

/**
 * UnifiedTimeEvent — 8 種の時間イベントを統一表現する核データ型 (§11.4)
 *
 * - 1 つの time event は必ずどれか 1 つの TimeEventCategory に属する
 * - position に紐付かない system イベント (forecast_marker 等) は positionRef = null
 * - agentReadable = true のイベントのみ MCP Resource として expose される
 *
 * 数値表現規約 (§4.5):
 * - amount を表すフィールドは存在しない (UnifiedTimeEvent 自体は時間軸の定義)
 * - 関連 amount は Position 経由で参照 (positionRef → Position.principal_amount 等)
 *
 * シリアライズ規約:
 * - JSON 化時は `triggerAt` を ISO 8601 string にする (`new Date(iso)` で復元可能)
 * - lib/utils/numeric.ts の serializeDate / parseDate を使用
 */
export interface UnifiedTimeEvent {
  /** event の一意 ID (ULID 推奨) */
  id: string;

  /** 発生元 protocol (Kamino / Jito / Streamflow 等) */
  protocol: string;

  /** 8 種のいずれか */
  category: TimeEventCategory;

  /** いつ発火するか */
  triggerAt: Date;

  /** 緊急度 (info / watch / critical) */
  urgency: Urgency;

  /** どのウォレット由来か */
  walletAddress: string;

  /** 関連 position への参照 (なければ null。例: forecast_marker は null) */
  positionRef: string | null;

  /** この時点で取りうる on-chain action 一覧 */
  actions: ActionDescriptor[];

  /** MCP 経由で expose するか (agentReadable = false なら Mobile UI のみ表示) */
  agentReadable: boolean;

  /** カテゴリ固有の補足情報 (例: epoch 番号、claim 期限残り日数) */
  metadata: Record<string, unknown>;
}

/**
 * UnifiedTimeEvent の JSON wire format。
 * BFF / MCP Server から Mobile / Agent に送る際の serialized 表現。
 */
export interface UnifiedTimeEventDTO
  extends Omit<UnifiedTimeEvent, "triggerAt"> {
  /** ISO 8601 string */
  triggerAt: string;
}

export function toDTO(event: UnifiedTimeEvent): UnifiedTimeEventDTO {
  return {
    ...event,
    triggerAt: event.triggerAt.toISOString(),
  };
}

export function fromDTO(dto: UnifiedTimeEventDTO): UnifiedTimeEvent {
  return {
    ...dto,
    triggerAt: new Date(dto.triggerAt),
  };
}

/**
 * CalendarEvent — UnifiedTimeEvent の view-layer projection (§11.4)
 *
 * presentation 属性 (色 / shape / display_label 等) を付加した表示用型。
 * Mobile UI 専用で、API レスポンスには UnifiedTimeEventDTO を使う。
 */
export interface CalendarEvent extends UnifiedTimeEvent {
  /** UI 表示用ラベル (i18n 済み、例: "Kamino USDC 満期") */
  displayLabel: string;

  /** カレンダーセル内の droplet shape (§9.3 の 8 形状 + 預入日) */
  dropletShape:
    | "left_pointed_filled"
    | "left_pointed_outline"
    | "right_pointed_filled"
    | "circle"
    | "half_circle"
    | "triangle"
    | "diamond"
    | "flag"
    | "dotted_circle";

  /** marker の表示色 (DS.color.* token name 推奨) */
  markerColor: string;
}
