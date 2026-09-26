/**
 * friendsMotion — Home の水面に浮かぶキャラクターの動き (pure、FloatingFriends から毎フレーム呼ぶ)。
 *
 * 一生: in (浮かび上がる) → drift (流れに乗って漂う) → out (沈むように消える) → away (待つ) → in …
 * - 出てくる場所は左右の列の空き水面 (card の間)。もう片方が居る空きは避ける
 * - drift はゆっくりした流れ (5–11 px/s) で、向きがゆるく曲がる。card の下や画面の外へ
 *   流れていってもよい (画面の外に出たら out へ)。20–40 秒で out
 * - ポインターは「避ける」のではなく「水をかき混ぜる」: 近くで動かすと、その向きに
 *   ゆっくり押され (慣性あり)、数秒かけて元の流れに戻る。速く逃げたりはしない
 */

export interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Phase = "in" | "drift" | "out" | "away";

export interface FriendState {
  phase: Phase;
  /** phase に入ってからの秒数 */
  t: number;
  /** 中心 (viewport CSS px) */
  x: number;
  y: number;
  /** 流れの速度 (px/s) と、ポインターにかき混ぜられた分の速度 */
  vx: number;
  vy: number;
  px: number;
  py: number;
  /** drift の長さ / away で待つ長さ (秒) */
  life: number;
  wait: number;
  /** 出てきた空き水面 (0 = 左, 1 = 右) */
  zone: number;
}

export interface Pointer {
  x: number;
  y: number;
  /** ポインターの速度 (px/s、平滑化済み) */
  vx: number;
  vy: number;
}

export interface Env {
  zones: (Zone | null)[];
  viewport: { w: number; h: number };
  size: number;
  pointer: Pointer | null;
  /** もう片方が今居る空き (避ける) */
  busyZone: number | null;
  rand: () => number;
}

export const IN_S = 1.8;
export const OUT_S = 2.6;
const SPEED = [5, 11] as const;
const LIFE = [20, 40] as const;
const WAIT = [5, 12] as const;
const TURN = 0.18; // rad/s 程度でゆるく向きが曲がる
const STIR_RADIUS = 170;
const STIR_GAIN = 0.5; // ポインター速度 → 押される速度 (1/s)
const STIR_RELAX_S = 3; // かき混ぜの速度が抜ける時定数
const STIR_MAX = 28; // px/s
const EDGE = 24;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const range = (r: readonly [number, number], rand: () => number) => lerp(r[0], r[1], rand());

/** 空き水面の中から出てくる場所と、最初の流れを決める。空きが無ければ null */
export function spawn(env: Env, preferZone: number): FriendState | null {
  const order = [preferZone, 1 - preferZone].filter((z) => z !== env.busyZone);
  const zone = order.find((z) => env.zones[z]);
  if (zone === undefined) return null;
  const z = env.zones[zone]!;
  const inset = env.size / 2 + EDGE;
  const x = z.x1 - z.x0 > 2 * inset ? lerp(z.x0 + inset, z.x1 - inset, env.rand()) : (z.x0 + z.x1) / 2;
  const y = z.y1 - z.y0 > 2 * inset ? lerp(z.y0 + inset, z.y1 - inset, env.rand()) : (z.y0 + z.y1) / 2;
  const a = env.rand() * Math.PI * 2;
  const s = range(SPEED, env.rand);
  return { phase: "in", t: 0, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, px: 0, py: 0, life: range(LIFE, env.rand), wait: 0, zone };
}

function offscreen(s: FriendState, env: Env): boolean {
  const m = env.size;
  return s.x < -m || s.y < -m || s.x > env.viewport.w + m || s.y > env.viewport.h + m;
}

/** 1 フレーム進める (dt 秒) */
export function stepFriend(s: FriendState, dt: number, env: Env): FriendState {
  const n = { ...s, t: s.t + dt };
  if (n.phase === "away") {
    if (n.t < n.wait) return n;
    return spawn(env, 1 - s.zone) ?? { ...n, t: 0, wait: 2 }; // 空きが無ければ少し待って再挑戦
  }

  // 流れ: 速さを保ったまま向きがゆるく曲がる
  const turn = TURN * Math.sin(n.t * 0.23 + n.zone * 1.7) * dt;
  const c = Math.cos(turn);
  const sn = Math.sin(turn);
  [n.vx, n.vy] = [n.vx * c - n.vy * sn, n.vx * sn + n.vy * c];

  // ポインターが水をかき混ぜる (その向きにゆっくり押され、数秒で抜ける)
  const relax = Math.exp(-dt / STIR_RELAX_S);
  n.px *= relax;
  n.py *= relax;
  const p = env.pointer;
  if (p) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < STIR_RADIUS) {
      const f = (1 - d / STIR_RADIUS) ** 2;
      n.px += p.vx * STIR_GAIN * f * dt;
      n.py += p.vy * STIR_GAIN * f * dt;
      const m = Math.hypot(n.px, n.py);
      if (m > STIR_MAX) {
        n.px *= STIR_MAX / m;
        n.py *= STIR_MAX / m;
      }
    }
  }
  n.x += (n.vx + n.px) * dt;
  n.y += (n.vy + n.py) * dt;

  if (n.phase === "in" && n.t >= IN_S) return { ...n, phase: "drift", t: 0 };
  if (n.phase === "drift" && (n.t >= n.life || offscreen(n, env))) return { ...n, phase: "out", t: 0 };
  if (n.phase === "out" && n.t >= OUT_S) return { ...n, phase: "away", t: 0, wait: range(WAIT, env.rand) };
  return n;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/** 見た目: 浮かび上がり / 沈み込みの不透明度と大きさ */
export function appearance(s: FriendState): { opacity: number; scale: number } {
  if (s.phase === "away") return { opacity: 0, scale: 0.9 };
  if (s.phase === "in") {
    const k = ease(Math.min(s.t / IN_S, 1));
    return { opacity: k, scale: lerp(0.9, 1, k) };
  }
  if (s.phase === "out") {
    const k = ease(Math.min(s.t / OUT_S, 1));
    return { opacity: 1 - k, scale: lerp(1, 0.88, k) };
  }
  return { opacity: 1, scale: 1 };
}
