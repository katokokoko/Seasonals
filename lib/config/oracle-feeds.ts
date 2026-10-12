/**
 * oracle-feeds — §4.6 oracle gate の asset ごとの設定 (Mobile / Web / BFF 共有、CLAUDE.md §4)。
 *
 * gate は deposit / withdraw の **underlying mint** で引く (lib/derive/oracle-gate.ts resolveOracleMint)。
 * registry (swap-earn / kamino / save / exponent の underlying_mint、meteora / orca の deposit_mint) の
 * 全 mint がここに tier 付きで載っていることを oracle-feeds.test.ts が強制する。
 * Menu に asset を足す時は、ここに tier を宣言しないと test が落ちる。
 *
 * source (2026-10 から、どちらも Solana 上の push feed account を Helius RPC で読む):
 * - Pyth: Pyth Data Association が費用を持つ sponsored push feed (shard 0、PriceUpdateV2)。
 *   heartbeat 55 秒 / 乖離 0.5%。Hermes REST は 2026-08-26 に API key 必須化したので使わない
 * - RedStone: RedStone の push feed (PriceData)。heartbeat 60 秒 / 乖離 0.1%
 * - RedStone gateway (tier B): push feed が無い asset 用。off-chain の署名付き data package を key 無しの公開
 *   gateway から取り、BFF が署名を自前で recover して正規 signer 5 つのうち 3 以上の中央値を使う
 * - Switchboard は 2026-09-25 にサポート終了 (crossbar は DNS 消滅) — 使わない
 *
 * staleness 閾値は source ごとに heartbeat + 猶予 (ユーザー決定 2026-10-05)。push feed は価格が乖離幅を
 * 超えて動けば heartbeat を待たず更新されるので、「age ≤ 閾値」は「価格はその乖離幅以内」を意味する。
 * 実測 (4 分、5 秒間隔): Pyth 最大 61〜62 秒、RedStone 最大 68〜78 秒。
 *
 * feed id の出所 (2026-10-05 に実 account を読んで鮮度を確認):
 * - Pyth: Benchmarks `/v1/price_feeds/?asset_type=crypto` の `Crypto.<SYM>/USD`
 * - RedStone: program `REDSTB…` の account の feed_id (ASCII)。一覧は app.redstone.finance/push-feeds
 */
import type { OracleTier } from "../types/oracle";

/** Pyth sponsored push feed account の owner (pyth-solana-receiver) */
export const PYTH_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/** Pyth push oracle program (sponsored feed account の PDA 導出元、seeds = [u16 LE shard, feed_id]) */
export const PYTH_PUSH_ORACLE_PROGRAM = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";
/** Pyth sponsored feed の shard */
export const PYTH_PUSH_SHARD = 0;
/** RedStone Solana price adapter (account の owner、seeds = ["price" 32B, feed_id 32B]) */
export const REDSTONE_PROGRAM = "REDSTBDUecGjwXd6YGPzHSvEUBHQqVRfCcjUVgPiHsr";

/** RedStone 公開 gateway (key 不要)。feed で絞れず毎回全 feed (~2MB) を返すので BFF は共有 cache する */
export const REDSTONE_GATEWAY_URLS = [
  "https://oracle-gateway-1.a.redstone.finance",
  "https://oracle-gateway-2.a.redstone.finance",
] as const;
export const REDSTONE_DATA_SERVICE_ID = "redstone-primary-prod";
/**
 * redstone-primary-prod の正規 signer (internal 5)。出所: `@redstone-finance/sdk@1.0.0`
 * `dist/src/registry/initial-state.json` の nodes のうち dateAdded < 2024-01-02 のもの
 * (= SDK の `getSignersForDataServiceId` 既定)。gateway が 2026-10-05 に返していたのもこの 5 つ。
 * 2025 年以降に追加された external signer は受け入れない
 */
export const REDSTONE_PRIMARY_SIGNERS = [
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774", // altair
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499", // wayfarer
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202", // morpheus
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE", // ciri
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de", // node-5
] as const;
/** 異なる正規 signer がこの数以上そろった時だけ使う (RedStone primary-prod の既定 threshold と同じ) */
export const REDSTONE_GATEWAY_MIN_SIGNERS = 3;

/** staleness 閾値 (秒) = heartbeat + 猶予 */
export const PYTH_PUSH_MAX_AGE_S = 75; // heartbeat 55s
export const REDSTONE_PUSH_MAX_AGE_S = 90; // heartbeat 60s
export const REDSTONE_GATEWAY_MAX_AGE_S = 60; // package は 10 秒刻みで更新 (実測 16〜21 秒)

export interface OracleFeedConfig {
  symbol: string;
  tier: OracleTier;
  /** Pyth price feed id (0x 無しの 64 hex)。tier A / B / C で必須 */
  pythFeedId?: string;
  /** RedStone feed id (ASCII、32 byte 右 0 詰めで seed にする)。tier A で必須 */
  redstoneFeedId?: string;
  /** RedStone gateway の data feed id (= dataPackageId)。tier B で必須 */
  redstoneGatewayFeedId?: string;
  /** Pyth の staleness 閾値を feed 別に長くする (sponsored feed の heartbeat が長い asset 用) */
  pythMaxAgeS?: number;
  /** tier D の理由 (必須) / それ以外の補足 */
  reason?: string;
}

const NO_FEED = "No Pyth or RedStone feed on Solana for this asset.";

/** underlying mint → oracle 設定 */
export const ORACLE_FEEDS: Record<string, OracleFeedConfig> = {
  // ── tier A: Pyth push + RedStone push ──
  So11111111111111111111111111111111111111112: {
    symbol: "SOL",
    tier: "A",
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    redstoneFeedId: "SOL",
  },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: "USDC",
    tier: "A",
    pythFeedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    redstoneFeedId: "USDC",
  },
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: {
    symbol: "JupUSD",
    tier: "A",
    pythFeedId: "8ed858a2214e892c9371694fb6c8a9037b6ed4052c4edf209f8cb988484e81d9",
    redstoneFeedId: "JupUSD",
  },

  // ── tier B: Pyth push + RedStone gateway (RedStone の on-chain feed が無い / 止まっている) ──
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT",
    tier: "B",
    pythFeedId: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
    redstoneGatewayFeedId: "USDT",
    reason: "RedStone USDT push account has not updated since 2025-07, so the signed gateway feed is used.",
  },
  // JLP (Kamino JLP reserve 用)
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": {
    symbol: "JLP",
    tier: "B",
    pythFeedId: "c811abc82b4bad1f9bd711a2773ccaa935b03ecef974236942cec5e0eb845a3a",
    redstoneGatewayFeedId: "JLP",
  },
  // USDG: Pyth の sponsored feed は 3 分 heartbeat (実測最大 284 秒) なので Pyth だけ閾値 200 秒
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
    symbol: "USDG",
    tier: "B",
    pythFeedId: "daa58c6a3ce7d4b9c46c32a6e646012c17c4a2b24c08dd8c5e476118b855a7da",
    pythMaxAgeS: 200,
    redstoneGatewayFeedId: "USDG",
  },

  // ── tier C: Pyth push のみ (RedStone に feed が無い) ──
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: {
    symbol: "EURC",
    tier: "C",
    pythFeedId: "76fa85158bf14ede77087fe3ae472f66213f6ea2f5b411cb2de472794990fa5c",
  },

  // ── tier D: gate 対象外 (理由必須) ──
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: {
    symbol: "USDS",
    tier: "D",
    reason: "Pyth sponsored feed stopped updating in 2026-08; RedStone has no USDS feed.",
  },
  // Exponent PT の underlying (満期後 redeem の gate 先)
  "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG": {
    symbol: "USX",
    tier: "D",
    reason: "Pyth sponsored feed stopped updating in 2026-08; RedStone has no USX feed.",
  },
  "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5": { symbol: "ONyc", tier: "D", reason: NO_FEED },
  "4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs": { symbol: "xSOL", tier: "D", reason: NO_FEED },
  "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC": { symbol: "eUSX", tier: "D", reason: NO_FEED },
  hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT: { symbol: "hyloSOL", tier: "D", reason: NO_FEED },
  hy1opf2bqRDwAxoktyWAj6f3UpeHcLydzEdKjMYGs2u: { symbol: "hyloSOL+", tier: "D", reason: NO_FEED },
  "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E": { symbol: "hyUSD", tier: "D", reason: NO_FEED },
  GxHksENo754dKj6kv5d2z7ey9KwE7YSRYgRCtoFYd2yq: { symbol: "stSLX", tier: "D", reason: NO_FEED },
  "9J8VvigcjFTkN3jhZH2ieTi2hdGVBVpEXbcA1JDo7QpA": { symbol: "srONyc", tier: "D", reason: NO_FEED },
  BULKoNSGzxtCqzwTvg5hFJg8fx6dqZRScyXe5LYMfxrn: { symbol: "BulkSOL", tier: "D", reason: NO_FEED },
  rkubjTrZYioRSeXwDnhwGQzvW3qkcin72JSxUt3WMVp: { symbol: "rkuSOL", tier: "D", reason: NO_FEED },
  WFRGSWjaz8tbAxsJitmbfRuFV2mSNwy7BMWcCwaA28U: { symbol: "fragSOL", tier: "D", reason: NO_FEED },
};

export function oracleFeedForMint(mint: string): OracleFeedConfig | undefined {
  return ORACLE_FEEDS[mint];
}

/** gate が実際に効く tier (A / B / C) か */
export function isGatedTier(tier: OracleTier): boolean {
  return tier !== "D";
}

/**
 * symbol → underlying mint (gate のある tier だけ)。`/prices` と評価額履歴が symbol で oracle を引くのに使う。
 * WSOL は SOL の別名として扱う (mobile 側は SOL に正規化して持つ)
 */
export function oracleMintForSymbol(symbol: string): string | undefined {
  const wanted = symbol === "WSOL" ? "SOL" : symbol;
  for (const [mint, feed] of Object.entries(ORACLE_FEEDS)) {
    if (feed.symbol === wanted && isGatedTier(feed.tier)) return mint;
  }
  return undefined;
}

/** symbol → Pyth feed id (評価額履歴の Pyth Benchmarks 用、gate と同じ feed) */
export function pythFeedIdForSymbol(symbol: string): string | undefined {
  const mint = oracleMintForSymbol(symbol);
  return mint ? ORACLE_FEEDS[mint]?.pythFeedId : undefined;
}
