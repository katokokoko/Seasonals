/**
 * portfolio history — 実測スナップショットの純関数 (Phase 8.56)
 *
 * 8.4 で偽の APY カーブを撤去した結果、chart は「現在値を左右 2 点に置いた
 * 水平線」になっていた。8.56 は **観測した値だけ**を貯めて描く方針に変える:
 * 端末に 1 日 1 点だけ実測を記録し、2 点以上たまったら線にする。
 * 過去に遡って点を捏造しない (start 側の点は作らない)。
 *
 * store (AsyncStorage 永続) は stores/portfolioHistory.ts。ここは range の
 * 絞り込みと系列組み立てだけを持つ (単体テスト可能な純関数)。
 */

/** 1 日 1 点の実測。SOL 建てで持ち、USDC 表示は換算で導出する */
export interface PortfolioSnapshot {
  /** ローカル日付 "YYYY-MM-DD" (同じ日は上書き) */
  day: string;
  /** その日のポートフォリオ SOL 評価額 */
  sol: number;
}

/** ALL range = 730 日。これを超えた古い点は捨てる */
export const MAX_SNAPSHOT_DAYS = 730;

/** Date → ローカル日付キー ("YYYY-MM-DD")。UTC 変換しない (端末の日付で 1 日 1 点) */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → ローカル 0 時の Date */
export function dayKeyToDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/**
 * 同じ日を上書きしつつ追記し、日付昇順・上限 `MAX_SNAPSHOT_DAYS` に正規化する。
 * 保存側 (store) と復元側 (hydrate) の両方から使う。
 */
export function upsertSnapshot(
  snapshots: PortfolioSnapshot[],
  next: PortfolioSnapshot
): PortfolioSnapshot[] {
  const merged = snapshots.filter((s) => s.day !== next.day);
  merged.push(next);
  merged.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return merged.length > MAX_SNAPSHOT_DAYS
    ? merged.slice(merged.length - MAX_SNAPSHOT_DAYS)
    : merged;
}

/** 永続化された unknown を安全に snapshot 配列へ (壊れた JSON は空で degrade) */
export function parseSnapshots(raw: unknown): PortfolioSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: PortfolioSnapshot[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { day, sol } = item as { day?: unknown; sol?: unknown };
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (typeof sol !== "number" || !Number.isFinite(sol)) continue;
    out.push({ day, sol });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** range 内 (today から `days` 日前以降) の snapshot だけ返す */
export function snapshotsInRange(
  snapshots: PortfolioSnapshot[],
  days: number,
  today: Date
): PortfolioSnapshot[] {
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  const fromKey = dayKey(from);
  const todayKey = dayKey(today);
  return snapshots.filter((s) => s.day >= fromKey && s.day <= todayKey);
}
