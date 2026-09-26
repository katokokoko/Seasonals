/**
 * LobbyPortalCard — カード全体が 1 つの Link (UI v2 §3, §4)。
 * 中身は icon / title / 1 行説明 / chevron のみ (sub-item を並べない)。
 * 面は liquid glass (ui/glass.css + water shader の lens)、pointer で specular と軽い tilt。
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { IconChevronRight } from "../ui/icons";
import { useGlassPointer } from "../ui/useGlassPointer";

export function PortalCard({
  to,
  title,
  description,
  icon,
  slot,
}: {
  to: string;
  title: string;
  description: string;
  icon: ReactNode;
  slot: "agent" | "menu" | "setting" | "dashboard";
}) {
  const column = slot === "agent" || slot === "setting" ? "lobby-left" : "lobby-right";
  const glassRef = useGlassPointer<HTMLAnchorElement>(3);
  return (
    <Link ref={glassRef} to={to} className={`portal-card glass slot-${slot}`} data-water-quiet={column} data-water-glass="regular">
      <span className="portal-icon">{icon}</span>
      <span className="portal-text">
        <span className="portal-title">{title}</span>
        <span className="portal-desc">{description}</span>
      </span>
      <span className="portal-chevron" aria-hidden="true">
        <IconChevronRight size={18} />
      </span>
    </Link>
  );
}
