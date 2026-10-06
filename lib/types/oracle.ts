/**
 * Oracle 型 — Mobile / Web / BFF 共有 (spec §4.6、CLAUDE.md §4)
 *
 * Pyth (primary) → secondary の fail-closed oracle 判定結果。2026-10 から両方とも **Solana 上の
 * push feed account** を Helius RPC で読む (Pyth Hermes は 2026-08-26 に API key 必須化、Switchboard は
 * 2026-09-25 にサポート終了したため使わない)。secondary は RedStone push feed (tier A) か、push feed が無い asset は
 * RedStone gateway の署名付き package (tier B)。
 * BFF `clients/oracle.ts` の `evaluateOracle` が生成し、`GET /oracle/status` が返す。
 * Mobile / Web は `warnings` を WarningArea (web は OracleGate) に出し、`status === "blocked"` で CTA を止める。
 *
 * 規約:
 * - price は 8 decimals string (§4.5、不明なら null)
 * - divergence_pct / age_seconds は percentage / 計数なので Number (§4.5 carve-out)
 */

/** price source の識別子。`redstone_gateway` は tier B (off-chain 署名付き package を BFF が検証) */
export type OracleSourceId = "pyth" | "redstone" | "redstone_gateway";

/**
 * asset ごとの oracle 構成 (lib/config/oracle-feeds.ts で宣言)。
 * - A: Pyth push + RedStone push (staleness + 乖離)
 * - B: Pyth push + RedStone gateway (署名検証済み off-chain package、正規 signer 5 つのうち 3 以上の中央値)
 * - C: Pyth push のみ (staleness のみ。乖離は評価できない)
 * - D: 使える feed が無い / 停止中 (gate 対象外。理由を `reason` に必ず書く)
 */
export type OracleTier = "A" | "B" | "C" | "D";

/**
 * oracle warning の種別 (§4.6)。WarningArea / OracleGate が render する強警告。
 * - `oracle_divergence_warning`: Pyth ↔ secondary の価格乖離が 2-5%
 * - `oracle_pyth_stale`: Pyth が閾値超 stale、secondary を使用中
 * - `oracle_secondary_stale`: secondary が閾値超 stale、Pyth を使用中 (乖離は評価していない)
 *
 * NOTE: 両 stale / >5% 乖離は §4.6 fail-closed で execute 拒否され、warning には
 *       到達しない (それらは `OracleBlockReason` 側)。
 */
export type OracleWarningKind =
  | "oracle_divergence_warning"
  | "oracle_pyth_stale"
  | "oracle_secondary_stale";

/**
 * execute を拒否する fail-closed の理由 (§4.6)。
 * - `oracle_both_stale`: Pyth stale かつ secondary が無い / stale
 * - `oracle_divergence_too_large`: Pyth ↔ secondary 乖離 >5%
 * - `oracle_unavailable`: どの source も取得できない
 */
export type OracleBlockReason =
  | "oracle_both_stale"
  | "oracle_divergence_too_large"
  | "oracle_unavailable";

/** UI warning の payload (WarningArea / OracleGate が消費)。 */
export interface OracleWarning {
  kind: OracleWarningKind;
  /** 乖離率 (%)。`oracle_divergence_warning` で必須 */
  divergencePct?: number;
  /** Pyth の最終更新からの経過秒数。`oracle_pyth_stale` で必須 */
  pythAgeSeconds?: number;
  /** secondary の最終更新からの経過秒数。`oracle_secondary_stale` で必須 */
  secondaryAgeSeconds?: number;
}

/** 単一 oracle source の取得結果。 */
export interface OracleSourceStatus {
  available: boolean;
  /** 8 decimals string、不明なら null */
  price_usd: string | null;
  /** on-chain の publish time からの経過秒数。不明なら null */
  age_seconds: number | null;
}

/** secondary の取得結果。`source: null` = この asset には secondary が無い (tier C / D) */
export interface OracleSecondaryStatus extends OracleSourceStatus {
  source: OracleSourceId | null;
}

/**
 * §4.6 fail-closed 判定の最終結果。
 *   status: "ok" 通す / "warning" 通すが強警告 / "blocked" execute 拒否
 */
export interface OracleResult {
  asset_symbol: string;
  status: "ok" | "warning" | "blocked";
  /** 採用した source。blocked / 未設定時は null */
  primary: OracleSourceId | null;
  /** 採用 source の price (8 decimals string、execution 用)。blocked 時 null */
  price_usd: string | null;
  pyth: OracleSourceStatus;
  secondary: OracleSecondaryStatus;
  /** この asset の oracle 構成 (registry 外の mint は "D") */
  tier: OracleTier;
  /** Pyth ↔ secondary 乖離率 (%)。両方 fresh の時のみ算出、他は null */
  divergence_pct: number | null;
  /** UI 表示用 warning 群 */
  warnings: OracleWarning[];
  /** blocked の理由。ok / warning では null */
  block_reason: OracleBlockReason | null;
  /**
   * gate 対象外 (= 通すが oracle 保護なし、tier D / registry 外)。
   * 正当な asset を silent fail させないためのフラグ。
   */
  not_configured?: boolean;
  /** tier D の理由 (feed が無い / sponsor が止まっている等)。UI / 運用が読む */
  reason?: string;
}
