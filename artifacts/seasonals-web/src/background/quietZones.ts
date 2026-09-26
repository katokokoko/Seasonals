/**
 * Quiet zone collector (docs/web/water-background-spec.md "Quiet zone contract").
 *
 * `data-water-quiet` 属性を持つ要素の矩形を集め、device px / bottom-left origin の
 * vec4 (x, y, w, h) × 最大 4 個として返す。
 *
 * 拡張: 属性値が空でない要素は同じ値ごとに外接矩形へ union する
 * (例: Home の左列 portal card 2 枚を `data-water-quiet="lobby-left"` で 1 rect にする。
 *  shader は 4 rect までなので、nav + 中央 + 左列 + 右列 で 4 に収める — WORKLOG #7)。
 * 候補が 4 を超えたら面積の大きい順に 4 個を残す。
 */

export const MAX_QUIET_RECTS = 4;

export interface QuietRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * canvas の実 box (CSS px) と、CSS px → drawing buffer px の倍率。
 * rect の座標変換は必ずこれを基準にする (viewport / innerHeight / dpr を前提にしない):
 *   x = (r.left - left) * scale、y = (bottom - r.bottom) * scale (bottom-left origin)
 */
export interface CanvasFrame {
  left: number;
  bottom: number;
  scale: number;
}

export function canvasFrame(canvas: HTMLCanvasElement): CanvasFrame {
  const b = canvas.getBoundingClientRect();
  return { left: b.left, bottom: b.bottom, scale: b.height > 0 ? canvas.height / b.height : 1 };
}

/** root から探すか、キャッシュ済みの要素列をそのまま使う (毎フレーム計測で querySelectorAll を避ける) */
function elementsOf(src: ParentNode | Iterable<HTMLElement>, selector: string): Iterable<HTMLElement> {
  return "querySelectorAll" in src ? (src as ParentNode).querySelectorAll<HTMLElement>(selector) : src;
}

interface CssRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function collectQuietRects(src: ParentNode | Iterable<HTMLElement>, frame: CanvasFrame): QuietRect[] {
  const groups = new Map<string, CssRect>();
  let anon = 0;
  for (const el of elementsOf(src, "[data-water-quiet]")) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const key = el.dataset.waterQuiet ? `g:${el.dataset.waterQuiet}` : `a:${anon++}`;
    const prev = groups.get(key);
    groups.set(
      key,
      prev
        ? {
            left: Math.min(prev.left, r.left),
            top: Math.min(prev.top, r.top),
            right: Math.max(prev.right, r.right),
            bottom: Math.max(prev.bottom, r.bottom),
          }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    );
  }
  return [...groups.values()]
    .map((r) => ({
      x: (r.left - frame.left) * frame.scale,
      y: (frame.bottom - r.bottom) * frame.scale,
      w: (r.right - r.left) * frame.scale,
      h: (r.bottom - r.top) * frame.scale,
    }))
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, MAX_QUIET_RECTS);
}

/** uniform4fv 用の Float32Array(16) に詰める (未使用 slot は 0) */
export function packQuietRects(rects: readonly QuietRect[], out = new Float32Array(16)): Float32Array {
  out.fill(0);
  rects.slice(0, MAX_QUIET_RECTS).forEach((r, i) => {
    out[i * 4] = r.x;
    out[i * 4 + 1] = r.y;
    out[i * 4 + 2] = r.w;
    out[i * 4 + 3] = r.h;
  });
  return out;
}

export function sameRects(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── glass surfaces (liquid glass lens、docs/web/water-background-spec.md "Glass lens") ──

export const MAX_GLASS_RECTS = 6;

/**
 * glass の種類 (Apple Liquid Glass の variant)。`data-water-glass` の値で指定し、空は regular。
 * - clear: 中央が透けて縁の屈折が強い (top bar / 選択しずく)
 * - regular: すりガラス寄り (Home の portal card)
 */
export const GLASS_VARIANTS = {
  clear: { lens: 1.5, frost: 0.3 },
  regular: { lens: 1, frost: 1 },
} as const;
export type GlassVariant = keyof typeof GLASS_VARIANTS;

export function glassVariant(value: string | undefined): GlassVariant {
  return value === "clear" ? "clear" : "regular";
}

/** 回転を持つ角丸矩形。device px、中心は bottom-left origin、angle は CSS rotate と同じ向き (rad、時計回り正) */
export interface GlassRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  radius: number;
  angle: number;
  /** 屈折の強さ (中央の拡大と縁の曲がり) */
  lens: number;
  /** すりガラス度 (0 = 透明、1 = caustic がぼける) */
  frost: number;
}

/** computed transform ("matrix(...)" / "matrix3d(...)" / "none") → 2D 回転角 (rad) */
export function transformAngle(transform: string | null | undefined): number {
  const m = /^matrix(3d)?\(([^)]+)\)$/.exec((transform ?? "").trim());
  if (!m) return 0;
  const v = m[2]!.split(",").map((x) => Number.parseFloat(x));
  const a = v[0] ?? 1;
  const b = v[1] ?? 0;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.atan2(b, a) : 0;
}

/**
 * `[data-water-glass]` 要素を回転付き角丸矩形として集める。
 * 回転している portal card は bounding box が膨らむので、中心だけ bbox から取り、
 * 大きさは layout size (offsetWidth / offsetHeight)、角度は computed transform から取る。
 */
export function collectGlassRects(src: ParentNode | Iterable<HTMLElement>, frame: CanvasFrame): GlassRect[] {
  const out: GlassRect[] = [];
  const k = frame.scale;
  for (const el of elementsOf(src, "[data-water-glass]")) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    const w = el.offsetWidth || r.width;
    const h = el.offsetHeight || r.height;
    const radius = Math.min(Number.parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2);
    // 透明 (opacity 0) の面は shader にも出さない (例: active link が無い画面の選択しずく)
    if (Number.parseFloat(cs.opacity || "1") === 0) continue;
    out.push({
      ...GLASS_VARIANTS[glassVariant(el.dataset.waterGlass)],
      cx: (r.left + r.width / 2 - frame.left) * k,
      cy: (frame.bottom - (r.top + r.height / 2)) * k,
      w: w * k,
      h: h * k,
      radius: radius * k,
      angle: transformAngle(cs.transform),
    });
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, MAX_GLASS_RECTS);
}

/** uGlassRects (vec4 × 6: cx, cy, w, h) / uGlassMeta (vec4 × 6: radius, angle, lens, frost) 用に詰める */
export function packGlassRects(
  rects: readonly GlassRect[],
  out = { rects: new Float32Array(MAX_GLASS_RECTS * 4), meta: new Float32Array(MAX_GLASS_RECTS * 4) }
): { rects: Float32Array; meta: Float32Array } {
  out.rects.fill(0);
  out.meta.fill(0);
  rects.slice(0, MAX_GLASS_RECTS).forEach((g, i) => {
    out.rects.set([g.cx, g.cy, g.w, g.h], i * 4);
    out.meta.set([g.radius, g.angle, g.lens, g.frost], i * 4);
  });
  return out;
}

/**
 * glass 面を Web Animations 等で動かす時に呼ぶ。WAAPI は style 属性を変えないので
 * MutationObserver では拾えない。受け取った useQuietZones が ms の間 rAF ごとに rect を取り直す。
 */
export const GLASS_TRACKING_EVENT = "seasonals:glass-tracking";
export function requestGlassTracking(ms: number): void {
  window.dispatchEvent(new CustomEvent(GLASS_TRACKING_EVENT, { detail: ms }));
}

// ── floaters (Home の水面に浮かぶキャラクター、docs/web/water-background-spec.md "Floaters") ──

export const MAX_FLOATERS = 2;

/** 水面に浮かぶもの。device px、中心は bottom-left origin。radius は体の半径 */
export interface Floater {
  cx: number;
  cy: number;
  radius: number;
  /** 波紋と影の強さ (0..1、`data-water-floater` の値。空なら 1) */
  strength: number;
}

/**
 * `[data-water-floater]` 要素を水面の floater として集める。中心は bbox の中心、半径は
 * layout size (回転で bbox が膨らむのを避ける) の短辺の半分。見えていない (opacity 0) ものは
 * 出さず、fade 中は強さに opacity を掛ける。
 */
export function collectFloaters(src: ParentNode | Iterable<HTMLElement>, frame: CanvasFrame): Floater[] {
  const out: Floater[] = [];
  const k = frame.scale;
  for (const el of elementsOf(src, "[data-water-floater]")) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const w = el.offsetWidth || r.width;
    const h = el.offsetHeight || r.height;
    const opacity = Number.parseFloat(getComputedStyle(el).opacity || "1");
    if (!(opacity > 0)) continue;
    const v = Number.parseFloat(el.dataset.waterFloater ?? "");
    out.push({
      cx: (r.left + r.width / 2 - frame.left) * k,
      cy: (frame.bottom - (r.top + r.height / 2)) * k,
      radius: (Math.min(w, h) / 2) * k,
      strength: (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1) * Math.min(opacity, 1),
    });
    if (out.length === MAX_FLOATERS) break;
  }
  return out;
}

/** uFloaters (vec4 × 2: cx, cy, radius, strength) 用に詰める */
export function packFloaters(floaters: readonly Floater[], out = new Float32Array(MAX_FLOATERS * 4)): Float32Array {
  out.fill(0);
  floaters.slice(0, MAX_FLOATERS).forEach((f, i) => out.set([f.cx, f.cy, f.radius, f.strength], i * 4));
  return out;
}
