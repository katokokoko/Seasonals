/**
 * AppShell — 全画面共通の water 背景 + global floating nav (UI v2 §1, §12)。
 * Home は shader を full expression、work screen は calm preset (UI v2 §2)。
 */
import { Outlet, useLocation } from "react-router";
import { WaterBackground } from "../background/WaterBackground";
import { waterCalm, waterDefaults } from "../background/waterDefaults";
import { GlobalFloatingNav } from "./GlobalFloatingNav";
import { GlassDebugOverlay } from "../background/GlassDebugOverlay";
import { useEffect, useState } from "react";
import { useTimeline } from "../services/queries";
import { EventDetailCard } from "../timeline/EventDetailCard";
import { useDetail } from "../timeline/detailStore";
import { useGlassLight } from "../ui/useGlassLight";
import "./shell.css";

export function AppShell() {
  const { pathname } = useLocation();
  const isHome = pathname === "/";
  const { events } = useTimeline();
  const closeDetail = useDetail((s) => s.close);
  useEffect(() => closeDetail(), [pathname, closeDetail]);
  useGlassLight();
  // ?glass-debug で開いた時だけ、WebGL の glass と DOM の枠の重なりを診断表示する (route を移っても維持)
  const [glassDebug] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has("glass-debug");
    } catch {
      return false;
    }
  });
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
      {glassDebug && <GlassDebugOverlay />}
    </>
  );
}
