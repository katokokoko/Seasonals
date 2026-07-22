/**
 * Exponent PT market registry — Mobile / BFF 共有 (Phase 8.33、§11.4 maturity / §32.2)
 *
 * PT (principal token) は固定 maturity を持つ SPL token。v1 は read-only 統合:
 * menu 表示 + 保有検出 + maturity time event のみで、売買実行経路は持たない
 * (Jupiter は PT mint を route しない / Exponent SDK は npm 未公開 — CLAUDE.md §10 backlog)。
 *
 * live source は api.exponent.finance/markets (BFF `fetchExponentFullMarkets` が優先)。
 * 本 registry は (a) offline / test の degrade 用 snapshot、(b) 満期後に live API の
 * active 一覧から消えた PT の解決用 backstop。market は 1〜4 ヶ月で世代交代するため、
 * snapshot は docs/confirm.md §D の期限 (最短 maturity) 毎に refresh する。
 *
 * mint / decimals は 2026-07-22 の live API 実測値 (捏造禁止)。
 * implied_apy / total_market_size は §3 display carve-out (表示専用 number)。
 */

export interface ExponentMarket {
  protocol_id: "exponent";
  /** menu pool_id と同一 (exponentPoolId で導出) */
  market_id: string;
  underlying_symbol: string;
  underlying_mint: string;
  underlying_decimals: number;
  pt_mint: string;
  yt_mint: string;
  /** PT/YT token の decimals (API top-level `decimals`) */
  pt_decimals: number;
  /** maturity unix 秒 (整数)。ISO 化は exponentMaturityIso */
  maturity_ts: number;
  /** PT 固定利回り (0..1、表示専用 §3 carve-out) */
  implied_apy: number;
  /**
   * market 規模 (API totalMarketSize、**quote 資産建て**。表示専用 §3 carve-out)。
   * USD 換算は quote_ticker 依存 — "USD"/stable → ×1、"SOL" → ×SOL 価格、他 → 換算不能
   */
  total_market_size: number;
  /** totalMarketSize の建て資産 (API quoteAsset.ticker) */
  quote_ticker: string;
}

/**
 * pool_id: "exponent_pt_usx_20260916"。ticker は英数小文字化。
 * `+` は "plus" に置換してから記号除去 — hyloSOL / hyloSOL+ が同 maturity で
 * 衝突しないため (pool_id は一意が前提: React key / dedup)。
 */
export function exponentPoolId(ticker: string, maturityTs: number): string {
  const t = ticker
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replace(/[^a-z0-9]/g, "");
  return `exponent_pt_${t}_${utcYyyymmdd(maturityTs)}`;
}

/** pool 表示名: "PT USX · 2026-09-16" (UTC 日付) */
export function exponentPoolName(ticker: string, maturityTs: number): string {
  const d = utcYyyymmdd(maturityTs);
  return `PT ${ticker} · ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** maturity unix 秒 → ISO 8601 (deriveTimeEvents の maturity_at 入力形式) */
export function exponentMaturityIso(maturityTs: number): string {
  return new Date(maturityTs * 1000).toISOString();
}

function utcYyyymmdd(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

const mk = (
  ticker: string,
  underlyingMint: string,
  underlyingDecimals: number,
  ptMint: string,
  ytMint: string,
  ptDecimals: number,
  maturityTs: number,
  impliedApy: number,
  totalMarketSize: number,
  quoteTicker: string
): ExponentMarket => ({
  protocol_id: "exponent",
  market_id: exponentPoolId(ticker, maturityTs),
  underlying_symbol: ticker,
  underlying_mint: underlyingMint,
  underlying_decimals: underlyingDecimals,
  pt_mint: ptMint,
  yt_mint: ytMint,
  pt_decimals: ptDecimals,
  maturity_ts: maturityTs,
  implied_apy: impliedApy,
  total_market_size: totalMarketSize,
  quote_ticker: quoteTicker,
});

/** 旗艦 4 market snapshot (2026-07-22 実測、market 規模順の上位 + eUSX は Solstice 連携枠) */
export const EXPONENT_MARKETS: ExponentMarket[] = [
  // USX (Solstice) — $47.6M、2026-09-16 満期
  mk(
    "USX",
    "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG",
    6,
    "6gUU7UXtGgJ3tmeb2gXxQcVeM2L82bg9MzRYxu2YUspu",
    "47gQiyWpVd13mmAFXemW1wVTd2e2GYKq5bLrdRXUfxsS",
    6,
    1789552700,
    0.056,
    47_593_494,
    "USD"
  ),
  // ONyc (OnRe) — $28.5M、2026-09-10 満期
  mk(
    "ONyc",
    "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
    9,
    "2W5zZccVq8AMdrg7P4b3NvBKJyzbdnytRy2CKEDHvhiJ",
    "HYHEZZ7GsPZbBfh2JVBxxSmqcqSPtPXPRqp5HJvhwh9Y",
    9,
    1789034299,
    0.1403,
    28_509_651,
    "USD"
  ),
  // xSOL (Hylo leveraged SOL) — $20.8M 相当、2026-08-12 満期 (snapshot 最短 = refresh 期限)
  mk(
    "xSOL",
    "4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs",
    6,
    "Af4kuyVwhoWK91YcsaoRQE4YbSknuWjwVM4xet7hRHB6",
    "7oWJhDLjFWoLA1v2gXj1EN6VnzqbmYNw8skdGTKh71U5",
    6,
    1786535900,
    0.3503,
    20_756_168,
    "xSOL" // quote が xSOL 自身 = USD 換算不能 (menu tvl は 0 表示)
  ),
  // eUSX (Solstice staked USX) — $5.9M、2026-09-16 満期
  mk(
    "eUSX",
    "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC",
    6,
    "2wZkuwSiDyHZuuZfS9C9kFkZNsgwHGjKtCxX3B6Ck6EX",
    "BKvVBAWWLB77yAbhm2Ctd62ewZ8yEvGXsZowBhDLKM6F",
    6,
    1789552700,
    0.0634,
    5_851_036,
    "USX" // ≈$1 stable quote
  ),
];

/** pt_mint → market (保有 PT の解決 — 満期後も引き続き解決できる backstop) */
export function findExponentMarketByPtMint(
  mint: string
): ExponentMarket | undefined {
  return EXPONENT_MARKETS.find((m) => m.pt_mint === mint);
}

/** yt_mint → market (保有 YT の maturity event 解決) */
export function findExponentMarketByYtMint(
  mint: string
): ExponentMarket | undefined {
  return EXPONENT_MARKETS.find((m) => m.yt_mint === mint);
}

/** 未満期 market のみ (menu 表示用 — 腐った snapshot が menu に出ないよう常に filter) */
export function activeExponentMarkets<T extends { maturity_ts: number }>(
  markets: T[],
  nowSec: number
): T[] {
  return markets.filter((m) => m.maturity_ts > nowSec);
}
