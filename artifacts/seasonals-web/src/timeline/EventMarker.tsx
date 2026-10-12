/**
 * EventMarker — event の小さな marker。ユーザーが手入力した予定は選んだ絵文字、
 * それ以外は kind に応じた droplet (docs/design-system.md §7)。
 */
import type { TimelineDisplayStatus, TimelineEvent } from "@workspace/lib/types";
import { STATUS_COLOR } from "../styles/tokens";
import "../calendar/plan.css";
import { Droplet } from "./Droplet";
import { shapeForKind } from "./labels";

export function EventMarker({
  event,
  status,
  size = 10,
}: {
  event: Pick<TimelineEvent, "kind" | "class" | "emoji">;
  status: TimelineDisplayStatus;
  size?: number;
}) {
  if (event.emoji) {
    return (
      <span className="emoji-marker" aria-hidden="true" style={{ fontSize: Math.round(size * 1.25) }}>
        {event.emoji}
      </span>
    );
  }
  return <Droplet shape={shapeForKind(event.kind, event.class)} color={STATUS_COLOR[status]} size={size} />;
}
