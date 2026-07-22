/**
 * rates — share token → underlying の交換レート取得 (Phase 8.15.x earnings 実値化)
 *
 * LST (jitoSOL/mSOL/INF): Sanctum extra-api の sol-value (lamports per 1 LST)。
 * USD* (Perena): Jupiter lite-api quote (1 USD* → USDC out) を rate として使用。
 *
 * 規約 (§4.5): 値は bigint / integer string で扱い、Number() で parse しない。
 * 失敗は throw → 呼び出し側 (positions/earn) が graceful degrade する。60s cache。
 */

const SANCTUM_BASE = "https://extra-api.sanctum.so";
const JUP_BASE = "https://lite-api.jup.ag";

const CACHE_TTL_MS = 60_000;

// ── Sanctum sol-value (LST → lamports per whole token) ───────────────────────

let sanctumCache: { at: number; values: Map<string, bigint> } | null = null;

/**
 * LST symbol 群の sol value (lamports per 1 LST、整数 bigint) を取得。
 * 返り値は **symbol キー** (呼び出し側で share_mint に対応付ける)。
 */
export async function fetchSanctumSolValues(
  symbols: string[]
): Promise<Map<string, bigint>> {
  if (sanctumCache && Date.now() - sanctumCache.at < CACHE_TTL_MS) {
    return sanctumCache.values;
  }
  const qs = symbols.map((s) => `lst=${encodeURIComponent(s)}`).join("&");
  const res = await fetch(`${SANCTUM_BASE}/v1/sol-value/current?${qs}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Sanctum sol-value HTTP ${res.status}`);
  }
  const json = (await res.json()) as { solValues?: Record<string, string> };
  const out = new Map<string, bigint>();
  for (const [sym, v] of Object.entries(json.solValues ?? {})) {
    if (typeof v === "string" && /^[0-9]+$/.test(v)) {
      out.set(sym, BigInt(v));
    }
  }
  sanctumCache = { at: Date.now(), values: out };
  return out;
}

// ── Jupiter quote rate (probe smallest in → out smallest) ────────────────────

const jupRateCache = new Map<string, { at: number; out: bigint }>();

/**
 * probeSmallest (整数 string) を input→output で quote した outAmount (bigint)。
 * underlying = shares × out / probe で換算する (呼び出し側)。
 */
export async function fetchJupiterRateOut(
  inputMint: string,
  outputMint: string,
  probeSmallest: string
): Promise<bigint> {
  const key = `${inputMint}:${outputMint}:${probeSmallest}`;
  const hit = jupRateCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.out;
  const url =
    `${JUP_BASE}/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}` +
    `&amount=${encodeURIComponent(probeSmallest)}&slippageBps=50`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Jupiter rate quote HTTP ${res.status}`);
  }
  const json = (await res.json()) as { outAmount?: string };
  if (!json.outAmount || !/^[0-9]+$/.test(json.outAmount)) {
    throw new Error("Jupiter rate quote: invalid outAmount");
  }
  const out = BigInt(json.outAmount);
  jupRateCache.set(key, { at: Date.now(), out });
  return out;
}

// ── LST APY (Phase 8.23、menu / positions 表示用) ────────────────────────────

const LST_APY_TTL_MS = 10 * 60_000; // epoch 単位でしか動かないため 10min
let lstApyCache: { at: number; values: Map<string, number> } | null = null;

async function fetchSanctumApyEndpoint(
  path: "latest" | "inception",
  symbols: string[]
): Promise<Record<string, number>> {
  const qs = symbols.map((s) => `lst=${encodeURIComponent(s)}`).join("&");
  const res = await fetch(`${SANCTUM_BASE}/v1/apy/${path}?${qs}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Sanctum apy/${path} HTTP ${res.status}`);
  }
  const json = (await res.json()) as { apys?: Record<string, number> };
  return json.apys ?? {};
}

/**
 * LST symbol → APY (0..1 fraction、§4.5 適用外の表示用比率)。
 * latest は epoch 境界直後に全 0.0 を返すことがある (live 実測 2026-07-10) ため、
 * 0/欠損の symbol は inception (通算 APY) で補完する 2 段構え。
 */
export async function fetchLstApys(
  symbols: string[]
): Promise<Map<string, number>> {
  if (lstApyCache && Date.now() - lstApyCache.at < LST_APY_TTL_MS) {
    return lstApyCache.values;
  }
  const latest = await fetchSanctumApyEndpoint("latest", symbols);
  const out = new Map<string, number>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const v = latest[sym];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out.set(sym, v);
    } else {
      missing.push(sym);
    }
  }
  if (missing.length > 0) {
    const inception = await fetchSanctumApyEndpoint("inception", missing).catch(
      () => ({}) as Record<string, number>
    );
    for (const sym of missing) {
      const v = inception[sym];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        out.set(sym, v);
      }
    }
  }
  lstApyCache = { at: Date.now(), values: out };
  return out;
}

// ── Exponent underlyingApy (Phase 8.24 — eUSX 等 yield token の実測 APY) ──────

const EXPONENT_MARKETS_URL = "https://api.exponent.finance/markets";
const EXPONENT_TTL_MS = 10 * 60_000;

interface ExponentMarketEntry {
  underlyingAsset?: {
    ticker?: string;
    mint?: string;
    decimals?: number;
  };
  quoteAsset?: { ticker?: string };
  underlyingApy?: number;
  syExchangeRate?: number;
  // Phase 8.33: PT market data (read-only 統合用)
  ptMint?: string;
  ytMint?: string;
  decimals?: number;
  maturityDateUnixTs?: number;
  impliedApy?: number;
  totalMarketSize?: number;
  ptPriceInAsset?: number;
  marketStatus?: string;
}

let exponentCache: { at: number; markets: ExponentMarketEntry[] } | null = null;

/** Exponent markets 生 entries (10min cache)。apy / syRate の派生元。 */
async function fetchExponentMarkets(): Promise<ExponentMarketEntry[]> {
  if (exponentCache && Date.now() - exponentCache.at < EXPONENT_TTL_MS) {
    return exponentCache.markets;
  }
  const res = await fetch(EXPONENT_MARKETS_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Exponent markets HTTP ${res.status}`);
  }
  const json = (await res.json()) as ExponentMarketEntry[];
  const markets = Array.isArray(json) ? json : [];
  exponentCache = { at: Date.now(), markets };
  return markets;
}

/**
 * Exponent (yield trading protocol) の markets から underlying yield token の
 * 実測 APY (underlyingApy、0..1 fraction) を ticker キーで返す。
 * underlyingApy が 0/null の market (非利回り token) は skip。
 * eUSX (Solstice) の APY ソースとして使用 (Phase 8.24 調査で確定)。
 */
export async function fetchExponentApys(): Promise<Map<string, number>> {
  const markets = await fetchExponentMarkets();
  const out = new Map<string, number>();
  for (const m of markets) {
    const ticker = m.underlyingAsset?.ticker;
    const apy = m.underlyingApy;
    if (
      typeof ticker === "string" &&
      typeof apy === "number" &&
      Number.isFinite(apy) &&
      apy > 0
    ) {
      out.set(ticker, apy);
    }
  }
  return out;
}

/**
 * Phase 8.33: PT market の検証済み full entry (read-only 統合用)。
 * implied_apy / total_market_size / pt_price_in_asset は §3 display carve-out。
 */
export interface ExponentFullMarket {
  ticker: string;
  underlying_mint: string;
  underlying_decimals: number;
  pt_mint: string;
  yt_mint: string;
  pt_decimals: number;
  /** maturity unix 秒 (整数) */
  maturity_ts: number;
  implied_apy: number;
  underlying_apy: number | null;
  /** API totalMarketSize (quote_ticker 建て — USD ではない market あり) */
  total_market_size: number;
  /** totalMarketSize の建て資産 (quoteAsset.ticker、"USD" / "SOL" / token 名) */
  quote_ticker: string;
  pt_price_in_asset: number;
  market_status: string;
}

/**
 * Phase 8.33: PT market 一覧 (10min cache 共有)。フィールド欠落/不正 entry は
 * skip (fail-closed — API shape drift 耐性)。menu / positions / time-events が
 * 消費し、live 取得失敗時は呼び手が lib registry snapshot へ degrade する。
 */
export async function fetchExponentFullMarkets(): Promise<ExponentFullMarket[]> {
  const markets = await fetchExponentMarkets();
  const out: ExponentFullMarket[] = [];
  for (const m of markets) {
    const u = m.underlyingAsset;
    if (
      typeof u?.ticker !== "string" ||
      typeof u.mint !== "string" ||
      u.mint.length === 0 ||
      !Number.isInteger(u.decimals) ||
      typeof m.ptMint !== "string" ||
      m.ptMint.length === 0 ||
      typeof m.ytMint !== "string" ||
      m.ytMint.length === 0 ||
      !Number.isInteger(m.decimals) ||
      typeof m.maturityDateUnixTs !== "number" ||
      !Number.isFinite(m.maturityDateUnixTs) ||
      m.maturityDateUnixTs <= 0 ||
      typeof m.impliedApy !== "number" ||
      !Number.isFinite(m.impliedApy)
    ) {
      continue;
    }
    out.push({
      ticker: u.ticker,
      underlying_mint: u.mint,
      underlying_decimals: u.decimals as number,
      pt_mint: m.ptMint,
      yt_mint: m.ytMint,
      pt_decimals: m.decimals as number,
      maturity_ts: Math.floor(m.maturityDateUnixTs),
      implied_apy: m.impliedApy,
      underlying_apy:
        typeof m.underlyingApy === "number" && Number.isFinite(m.underlyingApy)
          ? m.underlyingApy
          : null,
      total_market_size:
        typeof m.totalMarketSize === "number" &&
        Number.isFinite(m.totalMarketSize)
          ? m.totalMarketSize
          : 0,
      quote_ticker:
        typeof m.quoteAsset?.ticker === "string" ? m.quoteAsset.ticker : "",
      pt_price_in_asset:
        typeof m.ptPriceInAsset === "number" &&
        Number.isFinite(m.ptPriceInAsset) &&
        m.ptPriceInAsset > 0
          ? m.ptPriceInAsset
          : 1,
      market_status: typeof m.marketStatus === "string" ? m.marketStatus : "",
    });
  }
  return out;
}

/**
 * Phase 8.26: ticker → syExchangeRate (underlying 1 token あたりの base 価値、
 * eUSX なら ≈USD)。Solstice TVL (供給 × rate) の換算に使用。表示専用 Number。
 */
export async function fetchExponentSyRates(): Promise<Map<string, number>> {
  const markets = await fetchExponentMarkets();
  const out = new Map<string, number>();
  for (const m of markets) {
    const ticker = m.underlyingAsset?.ticker;
    const rate = m.syExchangeRate;
    if (
      typeof ticker === "string" &&
      typeof rate === "number" &&
      Number.isFinite(rate) &&
      rate > 0
    ) {
      out.set(ticker, rate);
    }
  }
  return out;
}

// ── Perena USD* APY (Phase 8.25) ─────────────────────────────────────────────

const PERENA_APY_URL = "https://api.perena.org/api/usdstar/apy?period=7d";
const PERENA_APY_TTL_MS = 10 * 60_000;
let perenaApyCache: { at: number; apy: number } | null = null;

/**
 * Perena USD* の 7d APY (0..1 fraction)。
 *
 * **非公開 endpoint** — 公式ドキュメントは無く、app.perena.org の JS bundle
 * (perena-*.js chunk の `/api/usdstar/apy` fetch) から特定した (2026-07-10)。
 * app 本体が使う endpoint のため当面安定と期待するが、消えた場合は呼び手の
 * allSettled degrade で fixture 値に自然 fallback する。
 * 応答は **% 単位** ({"period":"7d","apy":9.3}) — /100 で fraction 化。
 * period=30d は API 側バグで 500 を返すため 7d 固定。
 */
export async function fetchPerenaUsdStarApy(): Promise<number> {
  if (perenaApyCache && Date.now() - perenaApyCache.at < PERENA_APY_TTL_MS) {
    return perenaApyCache.apy;
  }
  const res = await fetch(PERENA_APY_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Perena usdstar/apy HTTP ${res.status}`);
  }
  const json = (await res.json()) as { apy?: number };
  if (typeof json.apy !== "number" || !Number.isFinite(json.apy) || json.apy <= 0) {
    throw new Error("Perena usdstar/apy: invalid apy");
  }
  const apy = json.apy / 100; // % → fraction
  perenaApyCache = { at: Date.now(), apy };
  return apy;
}

/** test 用: cache クリア */
export function _clearRatesCacheForTest(): void {
  sanctumCache = null;
  jupRateCache.clear();
  lstApyCache = null;
  exponentCache = null;
  perenaApyCache = null;
}
