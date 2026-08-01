/**
 * pyth-history — 過去の実価格 (Phase 8.58)
 *
 * Pyth Benchmarks は任意の unix 時刻の価格を返す。oracle.ts が使っている
 * Hermes (latest) と**同じ feed id** をそのまま使えるので、価格の出所が
 * 現在と過去で一致する (§4.6 Pyth primary の一貫性)。
 *
 * 実測メモ (2026-08-01):
 *   - クエリは `ids=<feed>&ids=<feed>`。**`ids[]=` は 422**
 *   - 400 日前まで取得できた (SOL: 1d $74.92 / 180d $102.29 / 400d $139.18)
 *   - User-Agent 無しだと Cloudflare が 403 を返すことがある (python urllib で再現)。
 *     undici (fetchWithTimeout) + 明示 UA で回避する。
 *     — solend-sdk が global fetch を node-fetch に差し替えて Orca/Meteora が
 *       403 になった 8.38 の件と同種の落とし穴
 *
 * §4.5: 価格は USD 8 decimals string。expo は負 (例 -8) で返るため
 * **文字列操作で小数点を入れる** (Number を経由しない)。
 */

import { fetchWithTimeout } from "./http";

const BENCHMARKS_URL = "https://benchmarks.pyth.network/v1/updates/price";
const FETCH_TIMEOUT_MS = 12_000;
/** 過去価格は不変なのでキャッシュに TTL は不要。件数だけ上限を設ける */
const CACHE_MAX_ENTRIES = 2_000;

interface ParsedPrice {
  id: string;
  price: { price: string; expo: number; publish_time: number };
}

/** feedId → USD 8-dec string。取得できなかった feed は **含めない** */
export type HistoricalPrices = Map<string, string>;

const cache = new Map<string, HistoricalPrices>();

export function _clearPythHistoryCacheForTest(): void {
  cache.clear();
}

/**
 * Pyth の `price` (整数 string) と `expo` (負) を USD 8-dec string にする。
 * 例: price="7492000000", expo=-8 → "74.92000000"
 */
export function pythPriceToUsd8(price: string, expo: number): string | null {
  if (!/^-?[0-9]+$/.test(price)) return null;
  const negative = price.startsWith("-");
  const digits = negative ? price.slice(1) : price;
  const decimals = -expo;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  // 8 decimals に揃える (足りなければ 0 埋め、多ければ切り捨て)
  const padded = digits.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals) || "0";
  const fracRaw = decimals > 0 ? padded.slice(padded.length - decimals) : "";
  const frac = (fracRaw + "00000000").slice(0, 8);
  return `${negative ? "-" : ""}${intPart}.${frac}`;
}

/**
 * 指定時刻の実価格を取得する。同じ (時刻, feed 群) は 1 回しか叩かない。
 * 失敗 / 未収載の feed は Map に載せない (0 で埋めない = 呼び手が「不明」と扱える)。
 */
export async function fetchHistoricalPrices(
  feedIds: string[],
  unixSeconds: number
): Promise<HistoricalPrices> {
  if (feedIds.length === 0) return new Map();
  const sorted = [...feedIds].sort();
  const cacheKey = `${unixSeconds}|${sorted.join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const query = sorted.map((id) => `ids=${encodeURIComponent(id)}`).join("&");
  const url = `${BENCHMARKS_URL}/${unixSeconds}?${query}&parsed=true&encoding=hex`;
  const out: HistoricalPrices = new Map();
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          // Cloudflare 対策 (UA 無しだと 403 になることがある)
          "user-agent": "seasonals-bff/1.0",
        },
      },
      FETCH_TIMEOUT_MS
    );
    if (!res.ok) return out;
    const json = (await res.json()) as { parsed?: ParsedPrice[] };
    for (const item of json.parsed ?? []) {
      const raw = item?.price;
      if (!raw || typeof raw.price !== "string") continue;
      const usd8 = pythPriceToUsd8(raw.price, raw.expo);
      if (usd8 === null) continue;
      // Benchmarks の id は 0x 無し、registry 側は 0x 付き。両方で引けるようにする
      const bare = item.id.startsWith("0x") ? item.id.slice(2) : item.id;
      out.set(`0x${bare}`, usd8);
      out.set(bare, usd8);
    }
  } catch {
    /* noop — 取れない日はその日を落とす (呼び手が判断する) */
  }
  cache.set(cacheKey, out);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return out;
}
