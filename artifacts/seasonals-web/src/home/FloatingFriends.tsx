/**
 * FloatingFriends — Home の水面に浮かぶキャラクター 2 匹 (装飾、Home の時だけ mount)。
 *
 * - 水面 canvas (fixed, z0) の上、glass layer / UI の下の fixed 層に置く
 * - 動きは friendsMotion.ts: 空き水面 (左右の列の card の間) に浮かび上がり、ゆっくり流れて
 *   (card の下や画面の外へ流れていってもよい)、沈むように消え、しばらくして別の所に現れる。
 *   ポインターは避ける対象ではなく、近くで動かすと水がかき混ぜられてゆっくり押される
 * - 上下の揺れと回転は見た目だけ (位置の計算とは別)
 * - prefers-reduced-motion では空きの中央に静止
 * - `data-water-floater` を付けて水面 shader に位置を渡し、波紋と水底の影を描かせる
 *   (不透明度に合わせて波紋と影も薄くなる)
 */
import { useEffect, useRef } from "react";
import chara1 from "../assets/characters/chara1.webp";
import chara2 from "../assets/characters/chara2.webp";
import { appearance, spawn, stepFriend, type Env, type FriendState, type Pointer, type Zone } from "./friendsMotion";
import "./floating.css";

const SOURCES = [chara1, chara2];
/** 空き水面 = 上の card の下端 〜 下の card の上端 (左列 / 右列) */
const ZONES: [string, string][] = [
  [".portal-card.slot-agent", ".portal-card.slot-setting"],
  [".portal-card.slot-menu", ".portal-card.slot-dashboard"],
];
const MAX_SIZE = 100;
const MIN_ZONE = 72;
const MARGIN = 18;
const TAU = Math.PI * 2;

function measureZone([topSel, bottomSel]: [string, string]): Zone | null {
  const top = document.querySelector(topSel)?.getBoundingClientRect();
  const bottom = document.querySelector(bottomSel)?.getBoundingClientRect();
  if (!top || !bottom) return null;
  const zone = {
    x0: Math.min(top.left, bottom.left) + MARGIN,
    x1: Math.max(top.right, bottom.right) - MARGIN,
    y0: top.bottom + MARGIN,
    y1: bottom.top - MARGIN,
  };
  return zone.x1 - zone.x0 >= MIN_ZONE && zone.y1 - zone.y0 >= MIN_ZONE ? zone : null;
}

export function FloatingFriends() {
  const refs = useRef<(HTMLImageElement | null)[]>([]);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const states: (FriendState | null)[] = SOURCES.map(() => null);
    let pointer: Pointer | null = null;
    let lastPointer: { x: number; y: number; t: number } | null = null;
    let raf = 0;
    let last = performance.now();
    const t0 = last;

    const onPointer = (e: PointerEvent) => {
      const now = performance.now();
      if (lastPointer) {
        const dt = Math.max((now - lastPointer.t) / 1000, 1 / 240);
        const vx = (e.clientX - lastPointer.x) / dt;
        const vy = (e.clientY - lastPointer.y) / dt;
        // 速度は平滑化 (1 回の大きな跳びで強く押さない)
        pointer = { x: e.clientX, y: e.clientY, vx: (pointer?.vx ?? 0) * 0.7 + vx * 0.3, vy: (pointer?.vy ?? 0) * 0.7 + vy * 0.3 };
      }
      lastPointer = { x: e.clientX, y: e.clientY, t: now };
    };
    const onLeave = () => {
      pointer = null;
      lastPointer = null;
    };

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const t = (now - t0) / 1000;
      const zones = ZONES.map(measureZone);
      const open = zones.filter((z): z is Zone => z !== null);
      const size = open.length
        ? Math.round(Math.min(MAX_SIZE, ...open.map((z) => Math.min((z.x1 - z.x0) * 0.38, (z.y1 - z.y0) * 0.42))))
        : MAX_SIZE;
      const still = reduce?.matches ?? false;
      // ポインターが止まっていれば速度を抜く
      if (pointer && lastPointer && now - lastPointer.t > 80) pointer = { ...pointer, vx: pointer.vx * 0.8, vy: pointer.vy * 0.8 };

      SOURCES.forEach((_, i) => {
        const el = refs.current[i];
        if (!el) return;
        let x: number;
        let y: number;
        let opacity: number;
        let scale = 1;
        let rot = 0;
        if (still) {
          const z = zones[i];
          if (!z) {
            el.style.opacity = "0";
            return;
          }
          x = (z.x0 + z.x1) / 2;
          y = (z.y0 + z.y1) / 2;
          opacity = 1;
        } else {
          const other = states[1 - i];
          const env: Env = {
            zones,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            size,
            pointer,
            busyZone: other && other.phase !== "away" ? other.zone : null,
            rand: Math.random,
          };
          // 最初の 1 回だけ、2 匹目の漂う時間をずらして同時に沈まないようにする
          const first = states[i] ? null : spawn(env, i);
          const cur = states[i] ?? (first && i === 1 ? { ...first, life: first.life + 12 } : first);
          if (!cur) {
            el.style.opacity = "0";
            return;
          }
          const s = (states[i] = stepFriend(cur, dt, env));
          const a = appearance(s);
          x = s.x;
          y = s.y + 3 * Math.sin((TAU * t) / 5.2 + i * 2.1); // ぷかぷか
          rot = 5 * Math.sin((TAU * t) / 17 + i * 1.3);
          opacity = a.opacity;
          scale = a.scale;
        }
        el.style.width = `${size}px`;
        el.style.opacity = opacity.toFixed(3);
        el.style.transform = `translate(${(x - size / 2).toFixed(1)}px, ${(y - size / 2).toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      });
      raf = requestAnimationFrame(frame);
    };

    window.addEventListener("pointermove", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div className="floating-friends" aria-hidden="true">
      {SOURCES.map((src, i) => (
        <img
          key={src}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="floater"
          src={src}
          alt=""
          draggable={false}
          data-water-floater=""
        />
      ))}
    </div>
  );
}
