/**
 * FloatingFriends — Home の水面に浮かぶキャラクター 2 匹 (装飾、Home の時だけ mount)。
 *
 * - 水面 canvas (fixed, z0) の上、glass layer / UI の下の fixed 層に置く
 * - 泳ぐ範囲は左右の列の「上の portal card の下端 〜 下の portal card の上端」の空き水面。
 *   毎フレーム DOM から測り (card の hover の浮き上がりで跳ねないよう少し平滑化)、空きが
 *   キャラより狭い時 (縦積みのレイアウト) は出さない
 * - 動きは周期の違う sin の和でゆっくり漂う (1 周 20–40 秒、水面 spec の「15 秒未満で 1 周しない」)
 *   + 小さな上下の揺れと回転。ポインターが近づくとふわっと逃げて、また漂いに戻る
 * - prefers-reduced-motion では空きの中央に静止
 * - `data-water-floater` を付けて水面 shader に位置を渡し、周りの波紋と水底の影を描かせる
 */
import { useEffect, useRef } from "react";
import chara1 from "../assets/characters/chara1.webp";
import chara2 from "../assets/characters/chara2.webp";
import "./floating.css";

interface Friend {
  src: string;
  /** 左右どちらの列の空きを泳ぐか (上の card, 下の card) */
  zone: [string, string];
  /** 漂いの周期 (秒) と位相 */
  tx: [number, number];
  ty: [number, number];
  phase: number;
}

const FRIENDS: Friend[] = [
  { src: chara1, zone: [".portal-card.slot-agent", ".portal-card.slot-setting"], tx: [29, 41], ty: [23, 37], phase: 0.4 },
  { src: chara2, zone: [".portal-card.slot-menu", ".portal-card.slot-dashboard"], tx: [33, 47], ty: [26, 31], phase: 2.1 },
];

const MAX_SIZE = 100;
const MIN_SIZE = 72;
const MARGIN = 18;
const FLEE_RADIUS = 140;
const TAU = Math.PI * 2;

interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function measureZone(f: Friend): Zone | null {
  const top = document.querySelector(f.zone[0])?.getBoundingClientRect();
  const bottom = document.querySelector(f.zone[1])?.getBoundingClientRect();
  if (!top || !bottom) return null;
  const zone = {
    x0: Math.min(top.left, bottom.left) + MARGIN,
    x1: Math.max(top.right, bottom.right) - MARGIN,
    y0: top.bottom + MARGIN,
    y1: bottom.top - MARGIN,
  };
  return zone.x1 - zone.x0 >= MIN_SIZE && zone.y1 - zone.y0 >= MIN_SIZE ? zone : null;
}

export function FloatingFriends() {
  const refs = useRef<(HTMLImageElement | null)[]>([]);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const smooth: (Zone | null)[] = FRIENDS.map(() => null);
    const push = FRIENDS.map(() => ({ x: 0, y: 0 }));
    let pointer: { x: number; y: number } | null = null;
    let raf = 0;
    let last = performance.now();
    const t0 = last;

    const onPointer = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
    };
    const onLeave = () => {
      pointer = null;
    };

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const still = reduce?.matches ?? false;
      const t = still ? 0 : (now - t0) / 1000;
      FRIENDS.forEach((f, i) => {
        const el = refs.current[i];
        if (!el) return;
        const zone = measureZone(f);
        if (!zone) {
          el.classList.remove("is-ready");
          smooth[i] = null;
          return;
        }
        // card の hover の浮き上がり等で範囲が跳ねないよう平滑化
        const prev = smooth[i];
        const k = prev ? 1 - Math.exp(-dt / 0.3) : 1;
        const z = (smooth[i] = prev
          ? { x0: prev.x0 + (zone.x0 - prev.x0) * k, x1: prev.x1 + (zone.x1 - prev.x1) * k, y0: prev.y0 + (zone.y0 - prev.y0) * k, y1: prev.y1 + (zone.y1 - prev.y1) * k }
          : zone);
        const size = Math.round(Math.min(MAX_SIZE, (z.x1 - z.x0) * 0.38, (z.y1 - z.y0) * 0.42));
        const ax = Math.max(0, (z.x1 - z.x0 - size) / 2);
        const ay = Math.max(0, (z.y1 - z.y0 - size) / 2);
        const cx = (z.x0 + z.x1) / 2;
        const cy = (z.y0 + z.y1) / 2;
        const p = f.phase;
        let x = cx + ax * (0.62 * Math.sin((TAU * t) / f.tx[0] + p) + 0.38 * Math.sin((TAU * t) / f.tx[1] + p * 1.7));
        let y = cy + ay * (0.6 * Math.sin((TAU * t) / f.ty[0] + p * 0.6) + 0.4 * Math.sin((TAU * t) / f.ty[1] + p * 2.3));
        y += still ? 0 : 4 * Math.sin((TAU * t) / 5.2 + p);
        const rot = still ? 0 : 5 * Math.sin((TAU * t) / 17 + p * 1.3);

        // ポインターが近いとふわっと逃げる (減衰付きで漂いに戻る)
        const target = { x: 0, y: 0 };
        if (pointer && !still) {
          const dx = x + push[i]!.x - pointer.x;
          const dy = y + push[i]!.y - pointer.y;
          const d = Math.hypot(dx, dy);
          if (d < FLEE_RADIUS && d > 0.001) {
            const s = ((FLEE_RADIUS - d) / FLEE_RADIUS) * 70;
            target.x = (dx / d) * s;
            target.y = (dy / d) * s;
          }
        }
        const kp = 1 - Math.exp(-dt / (target.x || target.y ? 0.35 : 1.4));
        push[i]!.x += (target.x - push[i]!.x) * kp;
        push[i]!.y += (target.y - push[i]!.y) * kp;
        x = Math.min(Math.max(x + push[i]!.x, z.x0 + size / 2), z.x1 - size / 2);
        y = Math.min(Math.max(y + push[i]!.y, z.y0 + size / 2), z.y1 - size / 2);

        el.style.width = `${size}px`;
        el.style.transform = `translate(${(x - size / 2).toFixed(1)}px, ${(y - size / 2).toFixed(1)}px) rotate(${rot.toFixed(2)}deg)`;
        el.classList.add("is-ready");
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
      {FRIENDS.map((f, i) => (
        <img
          key={f.src}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="floater"
          src={f.src}
          alt=""
          draggable={false}
          data-water-floater=""
        />
      ))}
    </div>
  );
}
