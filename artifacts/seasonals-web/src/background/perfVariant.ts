/**
 * 発熱対策 (2026-10-06、docs/web/water-background-spec.md "Runtime rules") の比較用スイッチ。dev server でだけ効く。
 *
 *   ?water-perf=none        対策なし (対策前の挙動)
 *   ?water-perf=1,3         対策 1 と 3 だけ
 *   ?water-perf=all         1〜5 全部
 *   ?water-perf=default     スイッチを解除して既定 (DEFAULT_MEASURES) に戻す
 *
 * 選んだ値は sessionStorage に残すので、SPA の遷移や reload でも同じ組み合わせが続く。
 *
 *   1: 描画を 30 fps に間引く (120 Hz の画面で GPU の仕事が 1/4)
 *   2: 作業画面 (calm preset) の水は静止画。preset の切り替えと quiet zone の変化の時だけ描く
 *   3: DPR 上限を 1.25 → 1.0 (描く画素が 36 % 減る)
 *   4: glass layer は glass の外接矩形だけ描く (scissor)
 *   5: Home のキャラクターの動きを 30 fps に (毎フレームの rect 計測と style 書き込みを減らす)
 */
export type PerfMeasure = 1 | 2 | 3 | 4 | 5;
const ALL: readonly PerfMeasure[] = [1, 2, 3, 4, 5];
/** 既定で入れる対策。3 は見た目 (砂の粒) が変わるのでユーザーの判断待ち */
export const DEFAULT_MEASURES: ReadonlySet<PerfMeasure> = new Set<PerfMeasure>([1, 2, 4, 5]);

const KEY = "water-perf";

function parse(v: string): Set<PerfMeasure> {
  if (v === "all") return new Set(ALL);
  if (v === "none") return new Set();
  return new Set(
    v
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n): n is PerfMeasure => (ALL as readonly number[]).includes(n)),
  );
}

function readVariant(): Set<PerfMeasure> | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get(KEY);
    if (q === "default") {
      window.sessionStorage.removeItem(KEY);
      return null;
    }
    if (q !== null) window.sessionStorage.setItem(KEY, q);
    const v = q ?? window.sessionStorage.getItem(KEY);
    return v === null ? null : parse(v);
  } catch {
    return null;
  }
}

/** 比較中の組み合わせ (無ければ null = 既定) */
export const perfVariant: ReadonlySet<PerfMeasure> | null = readVariant();

export function perfOn(m: PerfMeasure): boolean {
  return (perfVariant ?? DEFAULT_MEASURES).has(m);
}

/** 画面の隅に出す表示用の名前 */
export function perfVariantLabel(): string | null {
  if (!perfVariant) return null;
  return perfVariant.size ? `water-perf: ${[...perfVariant].sort().join(",")}` : "water-perf: none";
}
