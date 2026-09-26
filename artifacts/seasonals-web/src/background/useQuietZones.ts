/**
 * useQuietZones — `[data-water-quiet]` / `[data-water-glass]` 要素の rect を shader 用に詰める
 * (docs/web/water-background-spec.md "Quiet zone contract" / "Glass lens")。
 *
 * - 座標は canvas の実 box 基準 (canvasFrame)。viewport / innerHeight / dpr を前提にしない
 * - `measure()` は WaterBackground の描画ループが **アニメーション中は毎フレーム** 呼ぶ。
 *   scroll / sticky / macOS の弾性スクロール / route 遷移 / WAAPI / HMR など、どんな動きでも
 *   次のフレームで追従し、古い rect が残らない (要素の一覧はキャッシュし、毎フレームは rect だけ読む)
 * - ループが止まる静止モード (reduced motion) 用に、イベント駆動の再計算も持つ:
 *   ResizeObserver (quiet / glass 要素 + canvas host) + scroll / resize (passive) +
 *   MutationObserver + transitionend + requestGlassTracking(ms)。変化があれば onChange() で 1 frame 描く
 * - 要素の一覧は MutationObserver の時だけ取り直す
 *
 * 値が変わった時だけ version を増やし、WaterBackground はその時だけ uniform を upload する。
 */
import { useEffect, useRef, type RefObject } from "react";
import { canvasFrame, collectGlassRects, collectQuietRects, GLASS_TRACKING_EVENT, packGlassRects, packQuietRects, sameRects } from "./quietZones";

export interface QuietZoneState {
  rects: Float32Array;
  count: number;
  glassRects: Float32Array;
  glassMeta: Float32Array;
  glassCount: number;
  /** 値が変わるたびに増える (uniform upload / still mode の再描画トリガ) */
  version: number;
}

export interface QuietZoneTracker {
  state: QuietZoneState;
  /** 今の DOM から rect を取り直す。変わっていれば true */
  measure: () => boolean;
}

const QUIET = "[data-water-quiet]";
const GLASS = "[data-water-glass]";

export function useQuietZones(
  getCanvas: () => HTMLCanvasElement | null,
  onChange: () => void,
  host?: RefObject<HTMLElement | null>
): RefObject<QuietZoneTracker> {
  const quietEls = useRef<HTMLElement[]>([]);
  const glassEls = useRef<HTMLElement[]>([]);
  const tracker = useRef<QuietZoneTracker>({
    state: {
      rects: new Float32Array(16),
      count: 0,
      glassRects: new Float32Array(24),
      glassMeta: new Float32Array(24),
      glassCount: 0,
      version: 0,
    },
    measure: () => false,
  });

  tracker.current.measure = () => {
    const canvas = getCanvas();
    if (!canvas) return false;
    const frame = canvasFrame(canvas);
    const rects = collectQuietRects(quietEls.current, frame);
    const glass = collectGlassRects(glassEls.current, frame);
    const next = packQuietRects(rects);
    const nextGlass = packGlassRects(glass);
    const cur = tracker.current.state;
    const changed =
      cur.count !== rects.length ||
      cur.glassCount !== glass.length ||
      !sameRects(cur.rects, next) ||
      !sameRects(cur.glassRects, nextGlass.rects) ||
      !sameRects(cur.glassMeta, nextGlass.meta);
    if (changed) {
      tracker.current.state = {
        rects: next,
        count: rects.length,
        glassRects: nextGlass.rects,
        glassMeta: nextGlass.meta,
        glassCount: glass.length,
        version: cur.version + 1,
      };
    }
    return changed;
  };

  useEffect(() => {
    const refreshElements = () => {
      quietEls.current = [...document.querySelectorAll<HTMLElement>(QUIET)];
      glassEls.current = [...document.querySelectorAll<HTMLElement>(GLASS)];
    };
    refreshElements();
    // jsdom 等 ResizeObserver の無い環境では要素一覧だけ (背景自体も fallback になる)
    if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    let raf = 0;
    let trackUntil = 0;
    let listDirty = false;
    const observed = new Set<Element>();
    const ro = new ResizeObserver(() => schedule());
    if (host?.current) ro.observe(host.current);

    function recompute() {
      raf = 0;
      if (performance.now() < trackUntil) schedule();
      if (listDirty) {
        listDirty = false;
        refreshElements();
        const now = new Set<Element>([...quietEls.current, ...glassEls.current]);
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
      if (tracker.current.measure()) onChange();
    }
    function schedule() {
      if (!raf) raf = requestAnimationFrame(recompute);
    }
    const onMutation = () => {
      listDirty = true;
      schedule();
    };
    const onTrack = (e: Event) => {
      const ms = Number((e as CustomEvent<number>).detail) || 0;
      trackUntil = Math.max(trackUntil, performance.now() + ms);
      schedule();
    };

    const mo = new MutationObserver(onMutation);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-water-quiet", "data-water-glass", "class", "style"],
    });
    window.addEventListener(GLASS_TRACKING_EVENT, onTrack);
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    document.addEventListener("transitionend", schedule, { passive: true });
    listDirty = true;
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener(GLASS_TRACKING_EVENT, onTrack);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("transitionend", schedule);
    };
  }, [onChange, host]);

  return tracker;
}
