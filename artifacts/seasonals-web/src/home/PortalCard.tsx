/**
 * LobbyPortalCard — カード全体が 1 つの Link (UI v2 §3, §4)。
 * 中身は icon / title / 1 行説明 / chevron のみ (sub-item を並べない)。
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { IconChevronRight } from "../ui/icons";

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
  return (
    <Link to={to} className={`portal-card slot-${slot}`} data-water-quiet={column}>
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
