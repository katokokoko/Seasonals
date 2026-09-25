/** DropletMarker の DOM 版 (mobile components/calendar/DropletMarker.tsx の path を移植) */
import type { DropletShape } from "./labels";

export function Droplet({ shape, color, size = 10, label }: { shape: DropletShape; color: string; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ flex: "none" }}
    >
      {renderShape(shape, color)}
    </svg>
  );
}

function renderShape(shape: DropletShape, c: string) {
  switch (shape) {
    case "maturity":
      return <path d="M 4 12 Q 12 4 18 12 Q 12 20 4 12 Z" fill={c} />;
    case "lockup_end":
      return <path d="M 4 12 Q 12 4 18 12 Q 12 20 4 12 Z" fill="none" stroke={c} strokeWidth={2.4} />;
    case "epoch":
      return <circle cx={12} cy={12} r={8} fill={c} />;
    case "claim":
      return <path d="M 4 14 A 8 8 0 0 1 20 14 Z" fill={c} />;
    case "health":
      return <rect x={3} y={9} width={18} height={6} rx={3} fill={c} />;
    case "vesting_cliff":
      return <path d="M 12 2 L 22 12 L 12 22 L 2 12 Z" fill={c} />;
    case "vote_deadline":
      return (
        <>
          <path d="M 5 2 L 5 22" stroke={c} strokeWidth={2.4} />
          <path d="M 6 4 L 19 8 L 6 12 Z" fill={c} />
        </>
      );
    case "forecast_marker":
      return <circle cx={12} cy={12} r={7} fill="none" stroke={c} strokeWidth={2.4} strokeDasharray="3 2.5" />;
    case "deposit_history":
      return <path d="M 20 12 Q 12 4 6 12 Q 12 20 20 12 Z" fill={c} />;
  }
}
