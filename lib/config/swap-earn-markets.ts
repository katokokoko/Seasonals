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
 *     Hylo hyUSD 等 mint 未確証のものは確認後に追加 (silent に壊れた market を載せない)。
 */

import type { EarnPosition } from "../types/earn-position";
import type { Position } from "../types/position";

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
  { protocol_id: "jupiter_lend", underlying_symbol: "JupUSD", underlying_mint: JUPUSD, underlying_decimals: 6, share_symbol: "jlJupUSD", share_mint: "7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk", share_decimals: 6 },

  // ── Phase 8.15 Tier A: LST / appreciating SPL (Jupiter routable、実地検証済) ──
  // Jito: SOL → jitoSOL (stake-pool LST、price appreciates)
  { protocol_id: "jito", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "jitoSOL", share_mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", share_decimals: 9 },
  // Marinade: SOL → mSOL
  { protocol_id: "marinade", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "mSOL", share_mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", share_decimals: 9 },
  // Sanctum: SOL → INF (Infinity multi-LST pool token)
  { protocol_id: "sanctum", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "INF", share_mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", share_decimals: 9 },
  // Perena: USDC → USD* (Numéraire Seed Pool LP、auto-compounding stablecoin)
  // APY (Phase 8.25): app.perena.org の bundle 解析で非公開 endpoint を特定 —
  // GET api.perena.org/api/usdstar/apy?period=7d (% 単位)。rates.ts の
  // fetchPerenaUsdStarApy が取得し menu / positions に live 反映。
  { protocol_id: "perena", underlying_symbol: "USDC", underlying_mint: USDC, underlying_decimals: 6, share_symbol: "USD*", share_mint: "BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6", share_decimals: 6 },
  // Solstice: USDC → eUSX (staked USX、delta-neutral yield。Phase 8.24)
  // Jupiter routability 実地検証済 (100 USDC → 96.45 eUSX、impact ~0、rate 1.0365)。
  // APY は Exponent API (api.exponent.finance/markets) の underlyingApy が実測ソース。
  { protocol_id: "solstice", underlying_symbol: "USDC", underlying_mint: USDC, underlying_decimals: 6, share_symbol: "eUSX", share_mint: "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC", share_decimals: 6 },
  // Hylo (Phase 8.27): hyloSOL = LST (1 SOL → 0.9397、impact 0、Exponent underlyingApy 有)
  { protocol_id: "hylo", underlying_symbol: "SOL", underlying_mint: SOL, underlying_decimals: 9, share_symbol: "hyloSOL", share_mint: "hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT", share_decimals: 9 },
  // Hylo: sHYUSD = staked hyUSD (100 USDC → 68.22、impact ~0。APY 実値ソース未発見 → menu は fixture)
  { protocol_id: "hylo", underlying_symbol: "USDC", underlying_mint: USDC, underlying_decimals: 6, share_symbol: "sHYUSD", share_mint: "HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz", share_decimals: 6 },
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
