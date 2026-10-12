/**
 * swap-earn market registry — Mobile / BFF 共有 (Phase 8.15、§32.2 same source of truth)
 *
 * "swap-routable earn" protocol の market 定義。deposit = Jupiter Swap で
 * underlying_mint → share_mint をルート、withdraw = 逆。Jupiter Lend で実証済の
 * パターンを protocol 非依存に一般化したもの (新規 tx コード不要で onboard 可能)。
 *
 * 収録:
 *   - Jupiter Lend 7 markets (既存、server.ts の UNDERLYING_TO_JL_SHARE_MINT を包含)
 *   - Jito (SOL→jitoSOL) / Marinade (SOL→mSOL) / Sanctum (SOL→INF) / Perena (USDC→USD*)
 *     ※ いずれも Jupiter routability を実地検証済 (lite-api quote)
 *
 * 注: LST/share mint・Jupiter routability は実装時に検証済の値のみ収録する。
 *     share mint は上流で移行されることがある (2026-10 の Perena USD*)。`verify:tx` が検知点。
 *     Hylo hyUSD 等 mint 未確証のものは確認後に追加 (silent に壊れた market を載せない)。
 */

import type { EarnPosition } from "../types/earn-position";
import type { Position } from "../types/position";

/**
 * 2026-10-13: market の underlying 以外で deposit を支払える token (funding token)。
 * Jupiter が funding → share を 1 tx で route できると実地検証したペアだけを載せる。
 * oracle gate は funding と underlying の両方を引き、BFF は cross-asset fair-value guard を掛ける
 * (`fairOut = in × P_funding / P_underlying ÷ exchange_rate`)。funding は underlying ではないので
 * `findMarketByProtocolAsset(protocol, funding.symbol)` には出てこない (別 market と曖昧化しない)。
 */
export interface SwapEarnFundingToken {
  symbol: string;
  mint: string;
  decimals: number;
}

export interface SwapEarnMarket {
  /** Seasonals 内 protocol_id (menu entry / fixtureProtocols と一致させる) */
  protocol_id: string;
  /** deposit する underlying asset symbol */
  underlying_symbol: string;
  underlying_mint: string;
  underlying_decimals: number;
  /** 受け取る share / yield token symbol */
  share_symbol: string;
  share_mint: string;
  share_decimals: number;
  /** underlying 以外の支払い token (allowlist)。無ければ underlying のみ */
  funding?: SwapEarnFundingToken[];
}

/** deposit の入力 token (underlying か funding のどちらか) */
export interface SwapEarnDepositInput {
  mint: string;
  symbol: string;
  decimals: number;
  /** true = funding token 経由 (BFF は両 mint の oracle + cross-asset fair value を掛ける) */
  isFunding: boolean;
}

// ── 既知 mint (定数化して可読性を上げる) ───────────────────────────────────────
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const EURC = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
const USDS = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
const USDG = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const JUPUSD = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";

export const SWAP_EARN_MARKETS: SwapEarnMarket[] = [
  // ── Jupiter Lend (Phase 8.5-8.6、既存 7 markets) ──
  { protocol_id: "jupiter_lend", underlying_symbol: "USDC", underlying_mint: USDC, underlying_decimals: 6, share_symbol: "jlUSDC", share_mint: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", share_decimals: 6 },
  { protocol_id: "jupiter_lend", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "jlWSOL", share_mint: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU", share_decimals: 9 },
  { protocol_id: "jupiter_lend", underlying_symbol: "USDT", underlying_mint: USDT, underlying_decimals: 6, share_symbol: "jlUSDT", share_mint: "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A", share_decimals: 6 },
  { protocol_id: "jupiter_lend", underlying_symbol: "EURC", underlying_mint: EURC, underlying_decimals: 6, share_symbol: "jlEURC", share_mint: "GcV9tEj62VncGithz4o4N9x6HWXARxuRgEAYk9zahNA8", share_decimals: 6 },
  { protocol_id: "jupiter_lend", underlying_symbol: "USDS", underlying_mint: USDS, underlying_decimals: 6, share_symbol: "jlUSDS", share_mint: "j14XLJZSVMcUYpAfajdZRpnfHUpJieZHS4aPektLWvh", share_decimals: 6 },
  { protocol_id: "jupiter_lend", underlying_symbol: "USDG", underlying_mint: USDG, underlying_decimals: 6, share_symbol: "jlUSDG", share_mint: "9fvHrYNw1A8Evpcj7X2yy4k4fT7nNHcA9L6UsamNHAif", share_decimals: 6 },
  // 2026-10-13: USDC を支払って jlJupUSD を受け取る funding deposit。Jupiter lite-api で
  // USDC → jlJupUSD (1 USDC → 0.960781、SolFi V2 → … → Jupiter Lend Earn) と JupUSD → jlJupUSD
  // (1 JupUSD → 0.960423) が同等レートで route できることを実測。USDC / JupUSD はともに oracle tier A
  { protocol_id: "jupiter_lend", underlying_symbol: "JupUSD", underlying_mint: JUPUSD, underlying_decimals: 6, share_symbol: "jlJupUSD", share_mint: "7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk", share_decimals: 6,
    funding: [{ symbol: "USDC", mint: USDC, decimals: 6 }] },

  // ── Phase 8.15 Tier A: LST / appreciating SPL (Jupiter routable、実地検証済) ──
  // Jito: SOL → jitoSOL (stake-pool LST、price appreciates)
  { protocol_id: "jito", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "jitoSOL", share_mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", share_decimals: 9 },
  // Marinade: SOL → mSOL
  { protocol_id: "marinade", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "mSOL", share_mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", share_decimals: 9 },
  // Sanctum: SOL → INF (Infinity multi-LST pool token)
  { protocol_id: "sanctum", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "INF", share_mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", share_decimals: 9 },
  // Perena: USDC → USD* (auto-compounding stablecoin、NAV は利回りの累積で 1 USD を超えて伸びる)
  // 2026-10-05: Perena が USD* を Star V2 program (save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H) の新 mint に移行。
  // 旧 mint BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6 (Numéraire Seed Pool LP) は Jupiter で route が消え
  // (NO_ROUTES_FOUND、流動性 $44)、verify:tx で検知した。新 mint は Jupiter label "Perena Star V2" で双方向に route あり
  // (1 USDC → 0.908353 USD*、価格影響 ≈ 0)。旧 token は known-mints に "USD* (legacy)" として表示のみ残す。
  // APY (Phase 8.25): app.perena.org の bundle 解析で非公開 endpoint を特定 —
  // GET api.perena.org/api/usdstar/apy?period=7d (% 単位)。rates.ts の
  // fetchPerenaUsdStarApy が取得し menu / positions に live 反映。
  { protocol_id: "perena", underlying_symbol: "USDC", underlying_mint: USDC, underlying_decimals: 6, share_symbol: "USD*", share_mint: "star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM", share_decimals: 6 },
  // Solstice: USDC → eUSX (staked USX、delta-neutral yield。Phase 8.24)
  // Jupiter routability 実地検証済 (100 USDC → 96.45 eUSX、impact ~0、rate 1.0365)。
  // APY は Exponent API (api.exponent.finance/markets) の underlyingApy が実測ソース。
  { protocol_id: "solstice", underlying_symbol: "USDC", underlying_mint: USDC, underlying_decimals: 6, share_symbol: "eUSX", share_mint: "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC", share_decimals: 6 },
  // Hylo (Phase 8.27): hyloSOL = LST (1 SOL → 0.9397、impact 0、Exponent underlyingApy 有)
  { protocol_id: "hylo", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "hyloSOL", share_mint: "hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT", share_decimals: 9 },
  // Hylo: eHYUSD (V2 で sHYUSD から改称、同 mint) = Earn Pool の hyUSD (100 USDC → 68.22、impact ~0。APY 実値ソース未発見 → menu は fixture)
  { protocol_id: "hylo", underlying_symbol: "USDC", underlying_mint: USDC, underlying_decimals: 6, share_symbol: "eHYUSD", share_mint: "HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz", share_decimals: 6 },
];

/** share token mint → market (withdraw / 既知 share の解決) */
export function findMarketByShareMint(
  shareMint: string
): SwapEarnMarket | undefined {
  return SWAP_EARN_MARKETS.find((m) => m.share_mint === shareMint);
}

/** (protocol_id, underlying symbol) → market (deposit dispatch の解決) */
export function findMarketByProtocolAsset(
  protocolId: string,
  underlyingSymbol: string
): SwapEarnMarket | undefined {
  return SWAP_EARN_MARKETS.find(
    (m) => m.protocol_id === protocolId && m.underlying_symbol === underlyingSymbol
  );
}

/** 表記揺れの吸収 (jupUSD / JupUSD、WSOL = SOL)。solana-action.ts の normalizeAssetSymbol と同じ規則 */
function sameSymbol(a: string, b: string): boolean {
  const n = (s: string) => {
    const u = s.trim().toUpperCase();
    return u === "WSOL" ? "SOL" : u;
  };
  return n(a) === n(b);
}

/** market の funding token を symbol (大文字小文字無視) か mint (厳密) で引く */
export function findFundingToken(
  market: SwapEarnMarket,
  symbolOrMint: string
): SwapEarnFundingToken | undefined {
  return market.funding?.find(
    (f) => f.mint === symbolOrMint || sameSymbol(f.symbol, symbolOrMint)
  );
}

/**
 * deposit の入力 token を解決する。`inputMint` 省略 = underlying。
 * underlying でも allowlist の funding でもない mint は undefined (BFF は 400 unsupported_input_mint)。
 */
export function swapEarnDepositInput(
  market: SwapEarnMarket,
  inputMint?: string | null
): SwapEarnDepositInput | undefined {
  if (!inputMint || inputMint === market.underlying_mint) {
    return {
      mint: market.underlying_mint,
      symbol: market.underlying_symbol,
      decimals: market.underlying_decimals,
      isFunding: false,
    };
  }
  const f = market.funding?.find((x) => x.mint === inputMint);
  return f ? { mint: f.mint, symbol: f.symbol, decimals: f.decimals, isFunding: true } : undefined;
}

/** asset symbol から deposit の入力 token を解決する (underlying 優先、次に funding)。不一致は undefined */
export function swapEarnDepositInputBySymbol(
  market: SwapEarnMarket,
  asset: string | undefined
): SwapEarnDepositInput | undefined {
  if (!asset) return undefined;
  if (sameSymbol(asset, market.underlying_symbol)) {
    return swapEarnDepositInput(market, market.underlying_mint);
  }
  const f = findFundingToken(market, asset);
  return f ? swapEarnDepositInput(market, f.mint) : undefined;
}

/** underlying mint → share mint (Jupiter Lend deposit、protocol 単位の back-compat 用) */
export function jupiterLendUnderlyingToShare(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of SWAP_EARN_MARKETS) {
    if (m.protocol_id === "jupiter_lend") out[m.underlying_mint] = m.share_mint;
  }
  return out;
}

/**
 * Phase 8.15: 保有 swap-earn share token (LST 等) の raw Position を EarnPosition に
 * 正規化する。`raw_state.mint` が registry の share_mint に hit する position だけを
 * 対象 protocol で返す (mint 一致で解決 → symbol の表記揺れ / 未登録 LST を除外)。
 *
 * underlying の USD / APY は `/positions` 経由では不明なので 0 / null。表示は保有額
 * (share token 建て) + withdraw 起動 (generic swap-earn endpoint) に使う。
 *
 * 注: Position 型に依存するため import type で循環を避ける (config → types は単方向)。
 */
export function heldSwapEarnPositions(
  positions: Position[],
  protocolId: string
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const p of positions) {
    const mint = (p.raw_state as { mint?: unknown } | undefined)?.mint;
    if (typeof mint !== "string") continue;
    const m = findMarketByShareMint(mint);
    if (!m || m.protocol_id !== protocolId) continue;
    out.push({
      protocol_id: m.protocol_id,
      protocol_name:
        protocolId.charAt(0).toUpperCase() + protocolId.slice(1),
      market_symbol: m.underlying_symbol,
      share_mint: m.share_mint,
      shares: p.current_amount,
      share_decimals: m.share_decimals,
      asset_symbol: m.share_symbol,
      underlying_amount: p.current_amount,
      underlying_decimals: m.share_decimals,
      underlying_usd: "0",
      supply_rate_bps: null,
      accrued_yield_amount: "0",
      accrued_yield_sign: "unknown",
      cost_basis_amount: null,
    });
  }
  return out;
}
