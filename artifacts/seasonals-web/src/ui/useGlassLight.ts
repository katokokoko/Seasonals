/**
 * useGlassLight — glass の光沢縁 (CSS conic rim) の光源角度 `--glass-light-angle` を pointer に
 * 合わせて <html> に書く。water shader の uLight (画面中心 → pointer) と同じ向き。
 * CSS 角度 (0deg = 上、時計回り)。touch / reduced motion では既定 (左上) のまま。AppShell で 1 回呼ぶ。
 */
import { useEffect } from "react";

export function lightAngleDeg(dx: number, dyUp: number): number {
  const deg = (Math.atan2(dx, dyUp) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function useGlassLight() {
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const root = document.documentElement;
    let raf = 0;
    let p: { x: number; y: number } | null = null;
    const apply = () => {
      raf = 0;
      if (!p || reduce.matches) return;
      const dx = p.x - window.innerWidth / 2;
      const dy = window.innerHeight / 2 - p.y;
      if (Math.hypot(dx, dy) < 1) return;
      root.style.setProperty("--glass-light-angle", `${lightAngleDeg(dx, dy).toFixed(1)}deg`);
    };
    const onMove = (e: PointerEvent) => {
      p = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      root.style.removeProperty("--glass-light-angle");
    };
  }, []);
}
