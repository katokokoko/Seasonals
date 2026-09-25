/**
 * useQuietZones — `[data-water-quiet]` 要素の rect を追跡し、ref に最新の packed
 * Float32Array(16) と count を書く (docs/web/water-background-spec.md)。
 *
 * - ResizeObserver 1 個 (quiet 要素すべて) + scroll / resize (passive)
 * - MutationObserver (document.body subtree) で route 遷移・modal 開閉時に再 query
 * - 再計算は rAF で 1 frame 1 回に throttle (UI v2 §17)
 * - CSS transition 中の transform は RO に乗らないので、transitionend でも再計算する
 *
 * WaterBackground の frame loop はこの ref を読み、前回 upload と値が違う時だけ
 * uniform4fv する。
 */
import { useEffect, useRef } from "react";
import { collectQuietRects, packQuietRects } from "./quietZones";

export interface QuietZoneState {
  rects: Float32Array;
  count: number;
  /** 値が変わるたびに増える (still mode の再描画トリガ) */
  version: number;
}

export function useQuietZones(getDpr: () => number, onChange: () => void) {
  const state = useRef<QuietZoneState>({ rects: new Float32Array(16), count: 0, version: 0 });

  useEffect(() => {
    // jsdom 等 ResizeObserver の無い環境では quiet zone なし (背景自体も fallback になる)
    if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    let raf = 0;
    const observed = new Set<Element>();
    const ro = new ResizeObserver(() => schedule());

    function recompute() {
      raf = 0;
      const dpr = getDpr();
      const rects = collectQuietRects(document, { width: window.innerWidth, height: window.innerHeight }, dpr);
      const next = packQuietRects(rects);
      const cur = state.current;
      let changed = cur.count !== rects.length;
      for (let i = 0; i < 16 && !changed; i++) if (cur.rects[i] !== next[i]) changed = true;
      if (changed) {
        state.current = { rects: next, count: rects.length, version: cur.version + 1 };
        onChange();
      }

      // 監視対象の追加 / 削除
      const now = new Set(document.querySelectorAll("[data-water-quiet]"));
      now.forEach((el) => {
        if (!observed.has(el)) {
          ro.observe(el);
          observed.add(el);
        }
      });
      observed.forEach((el) => {
        if (!now.has(el)) {
          ro.unobserve(el);
          observed.delete(el);
        }
      });
    }
    function schedule() {
      if (!raf) raf = requestAnimationFrame(recompute);
    }

    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-water-quiet", "class", "style"] });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    document.addEventListener("transitionend", schedule, { passive: true });
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("transitionend", schedule);
    };
  }, [getDpr, onChange]);

  return state;
}
