/**
 * wallet 由来データの鮮度ラベル (API 効率化計画 §4.0「接続状態と取得済みデータの保持を分ける」)
 *
 * 接続状態は表示の ON/OFF と署名権限だけを決め、wallet 由来データは address 別の cache に
 * 残る。cache から古い値を先に出す時に「最新」に見せないための純関数。
 * 文言は SKR の `components/portfolio/cooldown-display.ts` ("Observed 14:21 · awaiting update")
 * に揃える。判定順:
 *
 *   1. 失敗 (isError、旧値は残る)          → failed     "Updated 14:21 · awaiting update"
 *   2. 取得中 (isFetching)                 → refreshing "Updated 14:21 · updating…"
 *   3. staleAfterMs 超過                   → stale      "Updated 14:21 · awaiting update"
 *   4. それ以外                            → fresh      "Updated 14:21"
 *
 * foreground 復帰 (`resumedAt`) は `lib/derive/cooldown-client.ts` と同じく「復帰した瞬間を
 * 時計の 1 tick とみなす」: background 中は表示側の interval が止まり nowMs が古いままになり得る
 * ので、`max(nowMs, resumedAt)` で判定する (古い値が復帰直後に fresh を名乗らない)。
 * SKR (staleTime 0、復帰で必ず再取得) と違い wallet 系 query は staleTime 内の復帰では再取得
 * しないので、「復帰したら無条件に stale」にはしない — 来ない更新を "awaiting update" と
 * 言い続けることになるため。
 */

export type DataFreshnessKind = "fresh" | "refreshing" | "stale" | "failed";

/**
 * query 1 本 (または combineQueryFreshness で合成した複数本) の取得状態。
 * TanStack Query の同名 field をそのまま写す。Mobile の props 型もこれを使う (§1: ローカル定義しない)
 */
export interface QueryFreshnessStatus {
  /** 表示中の値を受け取った時刻 (ms)。0 以下 = まだ一度も取得していない */
  dataUpdatedAt: number;
  isFetching: boolean;
  /** 直近の取得が失敗した (TanStack は旧値を残したまま error にする) */
  isError: boolean;
}

export interface DataFreshnessInput extends QueryFreshnessStatus {
  /** app が foreground に戻った時刻 (ms)。無ければ null / undefined */
  resumedAt?: number | null;
  /** 判定時刻 (ms) */
  nowMs: number;
  /** これを超えた値は stale (wallet 系は query の staleTime と同じ 60 秒) */
  staleAfterMs: number;
}

export interface DataFreshness {
  kind: DataFreshnessKind;
  label: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** 端末ローカル時刻の "14:21"。判定時刻と日付が違えば "Oct 11 14:21" */
export function formatUpdatedTime(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const hm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? hm : `${MONTHS[at.getMonth()]} ${at.getDate()} ${hm}`;
}

export function describeDataFreshness(input: DataFreshnessInput): DataFreshness {
  const { dataUpdatedAt, isFetching, isError, resumedAt, nowMs, staleAfterMs } = input;

  if (!(dataUpdatedAt > 0)) {
    // 一度も取れていない: 時刻を出せない
    if (isError) return { kind: "failed", label: "Couldn't load · awaiting update" };
    if (isFetching) return { kind: "refreshing", label: "Updating…" };
    return { kind: "stale", label: "Awaiting update" };
  }

  const base = `Updated ${formatUpdatedTime(dataUpdatedAt, nowMs)}`;
  if (isError) return { kind: "failed", label: `${base} · awaiting update` };
  if (isFetching) return { kind: "refreshing", label: `${base} · updating…` };

  const effectiveNow = Math.max(nowMs, resumedAt ?? 0);
  if (effectiveNow - dataUpdatedAt > staleAfterMs) {
    return { kind: "stale", label: `${base} · awaiting update` };
  }
  return { kind: "fresh", label: base };
}

/**
 * 複数 query をまとめて 1 本のラベルにする時の保守的な合成:
 * 最も古い dataUpdatedAt (未取得の query は除外)、どれか取得中、どれか失敗。
 */
export function combineQueryFreshness(
  queries: readonly QueryFreshnessStatus[]
): QueryFreshnessStatus {
  let oldest = 0;
  let isFetching = false;
  let isError = false;
  for (const q of queries) {
    if (q.dataUpdatedAt > 0 && (oldest === 0 || q.dataUpdatedAt < oldest)) {
      oldest = q.dataUpdatedAt;
    }
    isFetching = isFetching || q.isFetching;
    isError = isError || q.isError;
  }
  return { dataUpdatedAt: oldest, isFetching, isError };
}
