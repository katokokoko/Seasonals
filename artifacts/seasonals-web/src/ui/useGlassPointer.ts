/**
 * useGlassPointer — glass surface の specular を pointer に追従させ、任意で軽い 3D tilt を付ける。
 * CSS 変数 (--gx / --gy / --tiltX / --tiltY) を rAF で 1 frame 1 回だけ書く。
 * touch (hover の無い端末) では何もしない。prefers-reduced-motion では tilt しない (specular のみ)。
 */
import { useEffect, useRef } from "react";

export function useGlassPointer<T extends HTMLElement>(maxTiltDeg = 0) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last: { x: number; y: number } | null = null;

    const apply = () => {
      raf = 0;
      if (!last) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const x = Math.min(Math.max((last.x - r.left) / r.width, 0), 1);
      const y = Math.min(Math.max((last.y - r.top) / r.height, 0), 1);
      el.style.setProperty("--gx", `${(x * 100).toFixed(1)}%`);
      el.style.setProperty("--gy", `${(y * 100).toFixed(1)}%`);
      if (maxTiltDeg > 0 && !reduce.matches) {
        el.style.setProperty("--tiltX", `${((0.5 - y) * 2 * maxTiltDeg).toFixed(2)}deg`);
        el.style.setProperty("--tiltY", `${((x - 0.5) * 2 * maxTiltDeg).toFixed(2)}deg`);
      }
    };
    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      last = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (const p of ["--gx", "--gy", "--tiltX", "--tiltY"]) el.style.removeProperty(p);
    };
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave);
    return () => {
      onLeave();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [maxTiltDeg]);
  return ref;
}
