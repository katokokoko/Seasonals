/**
 * UserPolicy — 仕様書 §11.6
 *
 * §6.4 で宣言された制約項目を、データモデル上で実装するためのエンティティ。
 *
 * §32.2 整合性チェック:
 * - "policy-aware execution" → §6.4 制約と user_policies フィールドが 1:1 対応
 *
 * 重要な設計原則:
 * - UserPolicy はユーザー個別の制約
 * - Policy preset (Objective) は Agent が呼び出す目的指定
 * - 両者は execute 時に **AND で評価**される (preset の制約 ∧ UserPolicy の制約)
 *
 * 数値表現規約 (§4.5):
 * - max_tx_amount は USD 換算の 8 decimals string ("1000.00000000")
 * - min_tvl は同様に USD 8 decimals string
 * - max_daily_executions / max_lock_days は通常の integer (適用外、§4.5 末尾参照)
 */

import type { ApprovalMode, PositionCategory } from "./enums";

/**
 * UserPolicy — execute 時に必ず評価される制約セット
 *
 * 初期化フロー (§11.6):
 * - ウォレット接続 (§8.2) 完了直後に Server が自動作成
 * - default 値で初期化、明示的な policy 設定画面はオンボーディング後
 */
export interface UserPolicy {
  /** 対応する user_id */
  user_id: string;

  /** 表示通貨 (USD / SOL) */
  base_currency: "USD" | "SOL";

  /**
   * 利用可能 protocol whitelist。
   * 初期値は trusted protocol registry (§13.2) の全 enabled protocol。
   */
  enabled_protocols: string[];

  /** 利用可能 PositionCategory (§5.2 の 10 種から選択) */
  enabled_categories: PositionCategory[];

  /** 利用可能 asset symbol whitelist */
  enabled_assets: string[];

  /**
   * 1 回あたり最大金額 (USD 8 decimals string)。
   * null なら無制限 (default)。設定画面で明示的に指定するまで null。
   */
  max_tx_amount: string | null;

  /** 1 日あたり最大実行回数。null なら無制限 (default) */
  max_daily_executions: number | null;

  /** lockup 最大日数。null なら無制限 (default) */
  max_lock_days: number | null;

  /**
   * 最低 TVL 閾値 (USD 8 decimals string)。
   * default は "10000000.00000000" = 10M USD。
   */
  min_tvl: string;

  /** 最低 risk score 閾値 (0..1)。default 0.5 */
  min_risk_score: number;

  /** 承認方式 (4 種、§11.6) */
  approval_mode: ApprovalMode;

  /** ISO 8601 */
  created_at: string;
  /** ISO 8601 */
  updated_at: string;
}

/**
 * UserPolicy 初期化時の default 値 (§11.6)
 *
 * NOTE (8.37 訂正): enabled_protocols / enabled_assets の「Server で動的解決
 * (= all trusted)」は未実装。現行 BFF は fixtureUserPolicyDefault の**保守的
 * whitelist** (kamino/jito/streamflow/marinade + 主要 7 asset) をそのまま返す。
 * これは fail-closed としては妥当な default だが、menu の他 protocol は
 * policy を編集するまで agent 実行不能になる — 拡大は製品判断 (docs/backlog.md)。
 */
export const USER_POLICY_DEFAULTS = {
  base_currency: "USD" as const,
  // enabled_protocols / enabled_assets: 実際は fixtureUserPolicyDefault の
  // whitelist が生きる (上記 NOTE)。enabled_categories は POSITION_CATEGORIES 全種
  max_tx_amount: null,
  max_daily_executions: null,
  max_lock_days: null,
  min_tvl: "10000000.00000000" as const, // 10M USD
  min_risk_score: 0.5,
  approval_mode: "request_per_action" as ApprovalMode,
} as const;

/**
 * UserPolicy 違反時の error code (§24.9 で返す)
 */
export type PolicyViolation =
  | "policy_violation_protocol_not_enabled"
  | "policy_violation_category_not_enabled"
  | "policy_violation_asset_not_enabled"
  | "policy_violation_max_tx_amount"
  | "policy_violation_max_daily_executions"
  | "policy_violation_max_lock_days"
  | "policy_violation_min_tvl"
  | "policy_violation_min_risk_score"
  | "policy_violation_approval_mode";

/**
 * approval_mode = "auto" の MVP / Public Beta 制限 (§11.6)
 *
 * MCP client API キー漏洩時の被害を極小化するため、`auto` は feature flag で
 * 無効化する。`feature.approval_mode_auto` が false の間は設定画面に表示しない。
 *
 * `auto` 有効化の前提条件:
 * - bounded delegation token (§18 Phase 3) の実装完了
 * - 異常検知 / kill switch (§16.2) の本格運用
 * - 第三者によるセキュリティ監査の完了
 */
export const APPROVAL_MODE_AUTO_FEATURE_FLAG = "feature.approval_mode_auto";
