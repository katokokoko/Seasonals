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

interface CssRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function collectQuietRects(
  root: ParentNode,
  viewport: { width: number; height: number },
  dpr: number
): QuietRect[] {
  const groups = new Map<string, CssRect>();
  let anon = 0;
  root.querySelectorAll<HTMLElement>("[data-water-quiet]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
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
  });
  return [...groups.values()]
    .map((r) => ({
      x: r.left * dpr,
      y: (viewport.height - r.bottom) * dpr,
      w: (r.right - r.left) * dpr,
      h: (r.bottom - r.top) * dpr,
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
