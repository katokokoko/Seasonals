/**
 * useGlassDroplet — top bar の選択中項目の下に置く clear glass の "しずく" (Apple Liquid Glass の
 * tab bar 選択表示)。active な link (`.nav-link.is-active`、見えているもの) の位置と幅へ
 * ばねの動きで移動し、移動中はゼリーのように横へ伸びて縦に縮む。
 *
 * - 位置は `.nav-links` 基準の left + width (More ボタンは入れ子の positioned 要素の中に
 *   あるので offsetLeft ではなく rect の差で測る)。初回 / resize は animation 無しで合わせる
 * - 移動は transform ではなく left で animate する。transform の animation は compositor thread で
 *   進むので、route の lazy load などで main thread が詰まると DOM だけ先に動き、毎フレーム
 *   main thread で描く water shader のレンズが置いていかれる (left なら両方一緒に止まる)
 * - 移動中は requestGlassTracking で (静止モードでも) water shader のレンズを一緒に動かす
 * - reduced motion では animation せず位置だけ変える。active が無い画面では opacity 0
 * - link を押している間は少し膨らむ (`is-pressed`)
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { requestGlassTracking } from "../background/quietZones";

const MOVE_MS = 620;
const STRETCH_MS = 480;

/** 減衰ばね (ζ = 0.55) を CSS linear() easing に sample する。未対応環境は overshoot 付き cubic-bezier */
function springEasing(): string {
  const fallback = "cubic-bezier(0.34, 1.56, 0.64, 1)";
  if (typeof CSS === "undefined" || !CSS.supports?.("transition-timing-function", "linear(0, 1)")) return fallback;
  const zeta = 0.55;
  const w0 = 12;
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const pts: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const x = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    pts.push(x.toFixed(4));
  }
  pts[pts.length - 1] = "1";
  return `linear(${pts.join(", ")})`;
}

export function useGlassDroplet<C extends HTMLElement, D extends HTMLElement>(routeKey: string) {
  const containerRef = useRef<C>(null);
  const dropletRef = useRef<D>(null);
  const last = useRef<{ x: number; w: number } | null>(null);

  const place = (animate: boolean) => {
    const box = containerRef.current;
    const drop = dropletRef.current;
    if (!box || !drop) return;
    const active = [...box.querySelectorAll<HTMLElement>(".nav-link.is-active")].find((el) => el.offsetWidth > 0);
    if (!active) {
      drop.classList.add("is-hidden");
      return;
    }
    const next = { x: Math.round(active.getBoundingClientRect().left - box.getBoundingClientRect().left), w: active.offsetWidth };
    const prev = last.current;
    const wasHidden = drop.classList.contains("is-hidden");
    drop.classList.remove("is-hidden");
    drop.style.width = `${next.w}px`;
    drop.style.left = `${next.x}px`;
    last.current = next;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || !prev || wasHidden || reduce || typeof drop.animate !== "function") return;
    if (prev.x === next.x && prev.w === next.w) return;
    drop.animate(
      [
        { left: `${prev.x}px`, width: `${prev.w}px` },
        { left: `${next.x}px`, width: `${next.w}px` },
      ],
      { duration: MOVE_MS, easing: springEasing() }
    );
    // ゼリーの伸び縮み (移動方向に伸びて縦に縮む)
    drop.animate([{ scale: "1 1" }, { scale: "1.18 0.9", offset: 0.28 }, { scale: "0.97 1.04", offset: 0.62 }, { scale: "1 1" }], {
      duration: STRETCH_MS,
      easing: "ease-out",
    });
    requestGlassTracking(MOVE_MS + 80);
  };

  // route が変わったら (active link が変わる) ばねで移動
  useLayoutEffect(() => {
    place(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  // resize / font 読み込み / More への折り畳みは animation 無しで合わせる。押下で膨らむ
  useEffect(() => {
    const box = containerRef.current;
    const drop = dropletRef.current;
    if (!box || !drop) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => place(false)) : null;
    ro?.observe(box);
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".nav-link")) drop.classList.add("is-pressed");
    };
    const onUp = () => drop.classList.remove("is-pressed");
    box.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      ro?.disconnect();
      box.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, dropletRef };
}
