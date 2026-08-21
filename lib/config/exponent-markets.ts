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
 * mint / decimals は 2026-08-21 の live API 実測値 (捏造禁止)。
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
  /** Exponent vault account (API `vaultAddress`。redeem tx 構築 8.34 で使用) */
  vault_address: string;
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
  vaultAddress: string,
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
  vault_address: vaultAddress,
  pt_decimals: ptDecimals,
  maturity_ts: maturityTs,
  implied_apy: impliedApy,
  total_market_size: totalMarketSize,
  quote_ticker: quoteTicker,
});

/**
 * live 全 market snapshot の full mirror + 満期済み旧世代 (2026-08-21 実測、17 entries)。
 * 初版 (2026-07-22) は規模上位の旗艦 4 のみだったが、backstop 目的 (b) — 満期後に
 * live から消えた PT の redeem 解決 — には保有され得る全 market が必要なため全量に
 * 切り替えた (8.90)。**満期を過ぎても entry は削除しない** (backstop がこの registry の
 * 存在理由)。menu 表示は activeExponentMarkets が常に filter するので死蔵 entry は出ない。
 *
 * 8.94 (2026-08-21 probe): 旧世代 4 件 (xSOL / hyloSOL / hyloSOL+ / hyUSD = 08-12 満期、
 * stSLX = 08-21 満期) が live から消え、同 5 ticker の次世代 market が出現 → 末尾に追記。
 */
export const EXPONENT_MARKETS: ExponentMarket[] = [
  // USX (Solstice) — $33.9M、2026-09-16 満期
  mk(
    "USX",
    "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG",
    6,
    "6gUU7UXtGgJ3tmeb2gXxQcVeM2L82bg9MzRYxu2YUspu",
    "47gQiyWpVd13mmAFXemW1wVTd2e2GYKq5bLrdRXUfxsS",
    "CdUviheAUJaXUryT7JCRDUoNdPXdVvkxNQY1okC6uY8S",
    6,
    1789552700,
    0.0424,
    33_930_766,
    "USD"
  ),
  // ONyc (OnRe) — $34.6M、2026-09-10 満期 (snapshot 最短 active = refresh 期限)
  mk(
    "ONyc",
    "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
    9,
    "2W5zZccVq8AMdrg7P4b3NvBKJyzbdnytRy2CKEDHvhiJ",
    "HYHEZZ7GsPZbBfh2JVBxxSmqcqSPtPXPRqp5HJvhwh9Y",
    "66R3TcKjaUqxQwYV31BS4nD2s7YH4V7ENuvdwYbQMXCm",
    9,
    1789034299,
    0.1537,
    34_649_710,
    "USD"
  ),
  // xSOL (Hylo leveraged SOL) — 24.6M xSOL 建て、2026-08-12 **満期済**。
  // 08-21 probe で live から消滅を確認 (backstop として保持)。次世代 12-12 は末尾
  mk(
    "xSOL",
    "4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs",
    6,
    "Af4kuyVwhoWK91YcsaoRQE4YbSknuWjwVM4xet7hRHB6",
    "7oWJhDLjFWoLA1v2gXj1EN6VnzqbmYNw8skdGTKh71U5",
    "FwhwvRNJRVAEG22dTveRuXkPsQjATTeWvYXmnxokSK8t",
    6,
    1786535900,
    0.3652,
    24_621_819,
    "xSOL" // quote が xSOL 自身 = USD 換算不能 (menu tvl は 0 表示)
  ),
  // eUSX (Solstice staked USX) — $5.8M、2026-09-16 満期
  mk(
    "eUSX",
    "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC",
    6,
    "2wZkuwSiDyHZuuZfS9C9kFkZNsgwHGjKtCxX3B6Ck6EX",
    "BKvVBAWWLB77yAbhm2Ctd62ewZ8yEvGXsZowBhDLKM6F",
    "B78XAMSpB5KQqykw9oEec1nFSPeRqYtbTmsxo9EPwAUW",
    6,
    1789552700,
    0.0524,
    5_443_068,
    "USX" // ≈$1 stable quote
  ),
  // ── 以下 2026-08-09 probe で追加 (maturity 順) ──
  // hyloSOL (Hylo staked SOL) — 6,918 SOL 建て、2026-08-12 **満期済** (次世代は末尾)
  mk(
    "hyloSOL",
    "hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT",
    9,
    "2jSne8C9vMkMZC5Wj1Q3SsD7T5RTZx7pzsgZrXPYoWoB",
    "F9vgvj5cbGvc7eAoW7dWogwvG3L59RMLVXb4JPrSWPRX",
    "4WkAEiz4SB5137JpWLZHNfHjjYuhynpHmBpQUf7nwScn",
    9,
    1786535899,
    0.139,
    6_918,
    "SOL"
  ),
  // hyloSOL+ (Hylo boosted) — 2,278 SOL 建て、2026-08-12 **満期済** (次世代は末尾)
  // pool_id は "+" → "plus" 置換で hyloSOL と衝突しない (exponentPoolId 参照)
  mk(
    "hyloSOL+",
    "hy1opf2bqRDwAxoktyWAj6f3UpeHcLydzEdKjMYGs2u",
    9,
    "AwW1hyR9VpCr14Sbk8fYNbyAxVZZpEGphaLT7To1CRgB",
    "HkpPfYTTD8xCNzQ7ZVHo9EE2t8AHaxTqvo4Pid6qSH72",
    "FR1sT8SBqRdumRrGFUXcAgtiYLMvHdBUXdgwbyZnHZJi",
    9,
    1786535900,
    0.4032,
    2_278,
    "SOL"
  ),
  // hyUSD (Hylo stable) — $0.48M、2026-08-12 **満期済** (次世代は末尾)
  mk(
    "hyUSD",
    "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E",
    6,
    "EgCjHHmF2SRGwoqjHCicoZkbzJbPgZRN7h3eeuNZWndK",
    "Gr1oiVcbMEDhtXRv1xowqFW4psfEsL59ALGJrXzDZkAE",
    "EiZdj4VQtvjvHyeVJjfA1qiuveyfFwCeMVdT4a4PM8u5",
    6,
    1786535900,
    0.1511,
    482_538,
    "USD"
  ),
  // stSLX (Solstice staked SLX) — 3.06M SLX 建て、2026-08-21 **満期済** (次世代は末尾)
  mk(
    "stSLX",
    "GxHksENo754dKj6kv5d2z7ey9KwE7YSRYgRCtoFYd2yq",
    6,
    "4Qpo3XBmDDzZKPGbkbAADy48z4eTBKZed4F4n2PDyL9K",
    "9abefXRdJXc6zApQgC1ssdcwaTV7t9nZVvKAxnWbyzjg",
    "CyvHPGvWJEbCZ6eVB7C3zVtMMU8X6STx32C2JC44LcmW",
    6,
    1787306399,
    0.234,
    3_063_179,
    "SLX" // 非 USD quote = 換算不能 (menu tvl は 0 表示)
  ),
  // srONyc (OnRe senior tranche) — $0.93M、2026-09-10 満期
  mk(
    "srONyc",
    "9J8VvigcjFTkN3jhZH2ieTi2hdGVBVpEXbcA1JDo7QpA",
    9,
    "BKP9Rt3pwh96cCoCp3bkh1zxXZpZez17xA6w64LuMJQy",
    "DXoFWjJramdQzf847fnSkA8BR7iqsW8v5EBG9s7rhajy",
    "FLWUHWccnouW4EkB4dgczX9ZkSTA4FTnADiKSCkJvLp5",
    9,
    1789034280,
    0.1253,
    932_593,
    "USD"
  ),
  // BulkSOL — 140k SOL 建て、2026-10-31 満期 (旧世代 78MLjM… vault の次世代)
  mk(
    "BulkSOL",
    "BULKoNSGzxtCqzwTvg5hFJg8fx6dqZRScyXe5LYMfxrn",
    9,
    "HgyWqTZ6JdGYF5TfrYmScTyvsyuopwYRJXwqA2LzCrz6",
    "2rrtAYXZTB6vmCn8WGhZeBF2NDmyMqPV32oSfeqKgHZJ",
    "BwBn7Sro6RzDp3A59cDC7WoxWdT7yTaWuaHwvR7Gvypa",
    9,
    1793440800,
    0.0635,
    139_705,
    "SOL"
  ),
  // rkuSOL (Rakurai) — 34k SOL 建て、2026-10-31 満期
  mk(
    "rkuSOL",
    "rkubjTrZYioRSeXwDnhwGQzvW3qkcin72JSxUt3WMVp",
    9,
    "58XmRhDKVsCEt6dD3zxqHth8uzMY8BHhEyeAiUa5UPw9",
    "3bVyq1RKtEA8BkF21NU82Dk6erSXQbWnkhM4TsGgiD9i",
    "5PvEneipr7VLDoPXdQBY7G2J3Wtzrdhg7WU181J9eXBy",
    9,
    1793440800,
    0.0663,
    33_703,
    "SOL"
  ),
  // fragSOL (Fragmetric restaked SOL / Jito Restaking) — 6.5k SOL 建て、2026-12-15 満期
  mk(
    "fragSOL",
    "WFRGSWjaz8tbAxsJitmbfRuFV2mSNwy7BMWcCwaA28U",
    9,
    "EpnRnWgUHjihKDkq2HjpCRWPQka1danSnMhorSGd99Lt",
    "6QfCZms1AaNSopVwNtmFxYMhXf66sCNHDe1SYeJNi4Rs",
    "4VSKfVxMnnNGLhf5NgZDvnKi6DUPk3gXULkx9Mnfwwss",
    9,
    1797332300,
    0.0766,
    6_521,
    "SOL"
  ),
  // ── 以下 2026-08-21 probe で追加 (次世代 5 件、maturity 順) ──
  // stSLX 次世代 — 558k SLX 建て、2026-12-04 満期
  mk(
    "stSLX",
    "GxHksENo754dKj6kv5d2z7ey9KwE7YSRYgRCtoFYd2yq",
    6,
    "D7jEo9hPMFiz9yNYSFVoqH5fMsjPren7UvEJjjzpBLk",
    "GvJ8HtPYqaNDTn21NVjzvGwAGtASPCWctSMhQJ9uQzZb",
    "CBiRdkydZnSP1FUfWknnwg2JrdkidVZ9CKnVFac5NGxo",
    6,
    1796378400,
    0.2037,
    557_880,
    "SLX" // 非 USD quote = 換算不能 (menu tvl は 0 表示)
  ),
  // xSOL 次世代 — 5.65M xSOL 建て、2026-12-12 満期 (8.90 で「未出現」だったもの)
  mk(
    "xSOL",
    "4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs",
    6,
    "3bFbFU1dtap35fgBY6ityikjv41YSyxHCWnJkAiEteWR",
    "4BsEMum8uxSgZZ5THRiiHomPwy4vKXAMfxvHn5GgevUe",
    "ETZmEX6eH1FaRStkPMXiW2jocK8nRGfa9AkeDbRjo1un",
    6,
    1797069600,
    0.2214,
    5_651_202,
    "xSOL" // quote が xSOL 自身 = USD 換算不能 (menu tvl は 0 表示)
  ),
  // hyloSOL 次世代 — 2,123 SOL 建て、2026-12-12 満期
  mk(
    "hyloSOL",
    "hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT",
    9,
    "6gE8vCsnmF37e2cT6PTafNLP5MtPhChfJHJbckAXsq6r",
    "n2Wvw1GQVSNvj7BYvq2NGfjuT69nSr2xPcJDKQMtVZc",
    "Ciz4yqREYbMH4dtQvB3Rc2mSVEGMs8jFfE97qj6nXAPu",
    9,
    1797069600,
    0.0818,
    2_123,
    "SOL"
  ),
  // hyloSOL+ 次世代 — 1,119 SOL 建て、2026-12-12 満期
  mk(
    "hyloSOL+",
    "hy1opf2bqRDwAxoktyWAj6f3UpeHcLydzEdKjMYGs2u",
    9,
    "8aUSDnpp5kjCuWtJqaAahNGtvC8HSgFQpUR731CNwMVd",
    "ABGshYCjgD6hAtcnj9F69ccuLpR7KVUeGz6eEnxXwHv3",
    "DNPKdJwQ7bcBivrVDBHt7McQtiZyMU7FC53hguQwVMgT",
    9,
    1797069600,
    0.1026,
    1_119,
    "SOL"
  ),
  // hyUSD 次世代 — $0.19M、2026-12-12 満期
  mk(
    "hyUSD",
    "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E",
    6,
    "6Q8t9F7Ygv5kUjV5Gj2DfszL6Y33qCSKNYa7MKSsVeUJ",
    "2i7LpCeTpeAqw6M3i7JSEez2SJEM8gjxjJwsRyLWqpV5",
    "DCeWUSsQ89tE6i6oVtampERVBHbSEivuKzf6ANqtFtmw",
    6,
    1797069600,
    0.0943,
    185_029,
    "USD"
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
