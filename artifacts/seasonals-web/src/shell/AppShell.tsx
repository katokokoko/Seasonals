/**
 * AppShell — 全画面共通の water 背景 + global floating nav (UI v2 §1, §12)。
 * Home は shader を full expression、work screen は calm preset (UI v2 §2)。
 */
import { Outlet, useLocation } from "react-router";
import { WaterBackground } from "../background/WaterBackground";
import { waterCalm, waterDefaults } from "../background/waterDefaults";
import { GlobalFloatingNav } from "./GlobalFloatingNav";
import { useEffect } from "react";
import { useTimeline } from "../services/queries";
import { EventDetailCard } from "../timeline/EventDetailCard";
import { useDetail } from "../timeline/detailStore";
import "./shell.css";

export function AppShell() {
  const { pathname } = useLocation();
  const isHome = pathname === "/";
  const { events } = useTimeline();
  const closeDetail = useDetail((s) => s.close);
  useEffect(() => closeDetail(), [pathname, closeDetail]);
  return (
    <>
      <WaterBackground className="water-canvas" params={isHome ? waterDefaults : waterCalm} />
      <div className={`ui-layer ${isHome ? "is-home" : "is-work"}`}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <GlobalFloatingNav />
        <main id="main" tabIndex={-1} className="app-main">
          <Outlet />
        </main>
      </div>
      <EventDetailCard events={events} />
    </>
  );
}
