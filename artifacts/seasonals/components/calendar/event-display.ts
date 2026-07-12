/**
 * event-display — カレンダーイベントの表示解決 (Phase 8.16、純関数で test 容易)。
 *
 * wallet tx 履歴由来のイベント (metadata.source === "helius_tx") は category に
 * Epoch を流用しているため、droplet 形状とラベルは metadata から解決する:
 *   - 形状: deposit_history (右向き droplet、DropletShape に実装済)
 *   - ラベル: "Deposit" / "Withdraw" (direction 由来)
 * category 8 種の enum は不変 (§32.2 整合)。
 */
import { URGENCIES } from "@workspace/lib/types";
import type { TimeEventCategory, Urgency } from "@workspace/lib/types";
import type { DropletShape } from "./DropletMarker";

interface EventLike {
  category: TimeEventCategory;
  metadata?: Record<string, unknown>;
}

/** droplet 形状: tx 履歴イベントは deposit_history、それ以外は category そのまま。 */
export function dropletShapeForEvent(event: EventLike): DropletShape {
  if (event.metadata?.source === "helius_tx") return "deposit_history";
  return event.category;
}

/**
 * EventCard のカテゴリラベル。tx 履歴イベントは direction で "Deposit"/"Withdraw"、
 * それ以外は既存の category ラベル (呼び出し側の CATEGORY_LABELS) に委ねるため null。
 */
export function eventDirectionLabel(event: EventLike): string | null {
  if (event.metadata?.source !== "helius_tx") return null;
  const direction = event.metadata?.direction;
  if (direction === "deposit") return "Deposit";
  if (direction === "withdraw") return "Withdraw";
  return null;
}

/** metadata.headline (string のときのみ)。tx 履歴・epoch・health イベントが持つ。 */
export function eventHeadline(event: EventLike): string | null {
  const h = event.metadata?.headline;
  return typeof h === "string" && h.length > 0 ? h : null;
}

/**
 * Phase 8.21 (§5.3): urgency-first の安定 sort — critical → watch → info。
 * 同 urgency は元の順序を維持 (Array.prototype.sort は安定)。MonthGrid の
 * marker slice / EventDayModal のリスト順が「critical が 4 件目で隠れる」のを防ぐ。
 */
export function sortEventsByUrgency<T extends { urgency: Urgency }>(
  events: readonly T[]
): T[] {
  // URGENCIES = [info, watch, critical] — 降順 (index 大が先)
  const rank = new Map(URGENCIES.map((u, i) => [u, i]));
  return [...events].sort(
    (a, b) => (rank.get(b.urgency) ?? 0) - (rank.get(a.urgency) ?? 0)
  );
}
