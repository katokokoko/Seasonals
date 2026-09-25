/** UI v2 §7 status: 色 + 非色 cue (icon) + 文字 */
import type { TimelineDisplayStatus } from "@workspace/lib/types";
import { IconCheck, IconClock, IconDropletOutline, IconTriangle, IconX } from "../ui/icons";
import { STATUS_LABEL } from "./labels";

const ICON = {
  upcoming: IconDropletOutline,
  planned: IconClock,
  completed: IconCheck,
  warning: IconTriangle,
  failed: IconX,
} as const;

export function StatusBadge({ status, compact = false, label }: { status: TimelineDisplayStatus; compact?: boolean; label?: string }) {
  const Icon = ICON[status];
  const text = label ?? STATUS_LABEL[status];
  return (
    <span className={`status-badge status-${status}${compact ? " compact" : ""}`} title={compact ? text : undefined}>
      <Icon size={13} />
      {compact ? <span className="sr-only">{text}</span> : text}
    </span>
  );
}
