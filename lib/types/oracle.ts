/**
 * Oracle 型 — Mobile / BFF 共有 (Phase 8.14、spec §4.6)
 *
 * Pyth (primary) → Switchboard (fallback) の fail-closed oracle 判定結果。
 * BFF `clients/oracle.ts` の `evaluateOracle` が生成し、`GET /oracle/status` が返す。
 * Mobile は `OracleResult` を `WarningArea` の `OracleWarning[]` に map して表示し、
 * `status === "blocked"` で実行 CTA を恒久 disable する。
 *
 * 規約:
 * - price は 8 decimals string (§4.5、不明なら null)
 * - divergence_pct / age_seconds は percentage / 計数なので Number (§4.5 carve-out)
 */

/**
 * oracle warning の種別 (§4.6)。`WarningArea` が render する強警告。
 * - `oracle_divergence_warning`: Pyth ↔ Switchboard の価格乖離が 2-5%
 * - `oracle_pyth_stale`: Pyth が >60秒 stale、Switchboard を fallback 使用中
 * - `oracle_switchboard_stale`: Switchboard が >60秒 stale、Pyth を使用中 (rare)
 *
 * NOTE: 両 stale / >5% 乖離は §4.6 fail-closed で execute 拒否され、warning には
 *       到達しない (それらは `OracleBlockReason` 側)。
 */
export type OracleWarningKind =
  | "oracle_divergence_warning"
  | "oracle_pyth_stale"
  | "oracle_switchboard_stale";

/**
 * execute を拒否する fail-closed の理由 (§4.6)。
 * - `oracle_both_stale`: Pyth stale かつ Switchboard fallback 不可
 * - `oracle_divergence_too_large`: Pyth ↔ Switchboard 乖離 >5%
 * - `oracle_unavailable`: 両 oracle 未取得
 */
export type OracleBlockReason =
  | "oracle_both_stale"
  | "oracle_divergence_too_large"
  | "oracle_unavailable";

/** UI warning の payload (WarningArea が消費)。 */
export interface OracleWarning {
  kind: OracleWarningKind;
  /** 乖離率 (%)。`oracle_divergence_warning` で必須 */
  divergencePct?: number;
  /** Pyth の最終更新からの経過秒数。`oracle_pyth_stale` で必須 */
  pythAgeSeconds?: number;
  /** Switchboard の最終更新からの経過秒数。`oracle_switchboard_stale` で必須 */
  switchboardAgeSeconds?: number;
}

/** 単一 oracle source の取得結果。 */
export interface OracleSourceStatus {
  available: boolean;
  /** 8 decimals string、不明なら null */
  price_usd: string | null;
  /** 最終更新からの経過秒数。Switchboard Crossbar simulate は fetch=fresh なので 0 */
  age_seconds: number | null;
}

/**
 * §4.6 fail-closed 判定の最終結果。
 *   status: "ok" 通す / "warning" 通すが強警告 / "blocked" execute 拒否
 */
export interface OracleResult {
  asset_symbol: string;
  status: "ok" | "warning" | "blocked";
  /** 採用した oracle。blocked / 未設定時は null */
  primary: "pyth" | "switchboard" | null;
  /** 採用 oracle の price (8 decimals string、execution 用)。blocked 時 null */
  price_usd: string | null;
  pyth: OracleSourceStatus;
  switchboard: OracleSourceStatus;
  /** Pyth ↔ Switchboard 乖離率 (%)。両 available 時のみ算出、他は null */
  divergence_pct: number | null;
  /** UI 表示用 warning 群 */
  warnings: OracleWarning[];
  /** blocked の理由。ok / warning では null */
  block_reason: OracleBlockReason | null;
  /**
   * registry に feed が無く oracle gate 対象外 (= 通すが oracle 保護なし)。
   * 正当な未設定 asset を silent fail させないためのフラグ。
   */
  not_configured?: boolean;
}
