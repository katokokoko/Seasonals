/**
 * Position / Wallet / Protocol — 仕様書 §11.1 / §11.2 / §11.3
 *
 * Mobile / BFF / MCP Server で共有される基本データ型。
 *
 * 数値表現規約 (§4.5):
 * - principal_amount / current_amount / accrued_yield_amount は smallest unit string
 * - unit_price_usd / unit_price_sol は USD/SOL の 8 decimals string
 * - DB 型は NUMERIC(38, 0) (token amount) / NUMERIC(38, 8) (price)
 */

import type { PositionCategory, TrustLevel } from "./enums";

// ─────────────────────────────────────────────────────────────────────────────
// Wallet — §11.1
// ─────────────────────────────────────────────────────────────────────────────

export interface Wallet {
  /** wallet の一意 ID (Server 内部) */
  wallet_id: string;
  /** Solana の base58 address */
  address: string;
  /** ユーザーが付ける任意のラベル ("Main wallet" 等) */
  label: string;
  /** 現在 active な (= 表示対象) wallet か */
  is_active: boolean;
  /**
   * デバイスバインディング情報 (§11.1)。
   * Seeker / Seed Vault との紐付けの記録。秘密鍵は含まない。
   */
  device_binding: {
    device_id?: string;
    binding_method?: "mwa" | "seed_vault";
    bound_at?: string; // ISO 8601
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol — §11.2
// ─────────────────────────────────────────────────────────────────────────────

export interface Protocol {
  /** protocol の一意 ID ("kamino" / "jito" / "streamflow" 等) */
  protocol_id: string;
  /** 表示用 name */
  name: string;
  /** PositionCategory (10 種) */
  category: PositionCategory;
  /** trust level (Tier S / A / B / Untrusted) */
  trust_level: TrustLevel;
  /** trusted registry に登録 / 有効化されているか */
  enabled: boolean;
  /**
   * protocol 固有のメタデータ。
   * §13.2 の oracle 乖離閾値 override 等もここに格納。
   */
  metadata: {
    /** 公式サイト */
    homepage?: string;
    /** docs URL */
    docs_url?: string;
    /** §4.6 oracle 乖離閾値 override (default 2% / 5%) */
    oracle_divergence_warning_threshold?: number;
    oracle_divergence_block_threshold?: number;
    /** その他 */
    [key: string]: unknown;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Position — §11.3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1 ウォレット × 1 protocol × 1 asset の保有ポジション。
 *
 * 数値表現規約 (§4.5):
 * - principal_amount / current_amount / accrued_yield_amount は smallest unit string
 * - unit_price_* は 8 decimals string
 * - すべて parseInt / Number への変換は禁止
 */
export interface Position {
  position_id: string;
  wallet_id: string;
  protocol_id: string;

  /** 保有 asset の symbol ("USDC" / "SOL" / "mSOL" 等) */
  asset_symbol: string;

  /** 元本 (smallest unit string、例: "1500000" = 1.5 USDC) */
  principal_amount: string;
  /** 現在残高 (smallest unit string) */
  current_amount: string;
  /** 累積 yield (smallest unit string) */
  accrued_yield_amount: string;

  /** USD 換算 (8 decimals string、例: "1.00000000") */
  unit_price_usd: string;
  /** SOL 換算 (8 decimals string) */
  unit_price_sol: string;

  /** 預入日 (ISO 8601) */
  deposited_at: string;
  /** 満期日 (ISO 8601、満期がない position は null) */
  maturity_at: string | null;
  /** 解除可能日 / lockup_end (ISO 8601、lockup がない position は null) */
  unlock_at: string | null;

  /**
   * 借入系ポジションの健全性指標。
   * Kamino / MarginFi 等の lending position で値が入る。
   * それ以外は null。null の場合 health TimeEventCategory は発生しない。
   */
  health_factor: number | null;

  /** 自動 roll 設定 (UserPolicy 側に上位ルールあり) */
  auto_roll_rule: AutoRollRule | null;

  /** リスクスコア (0..1) */
  risk_score: number;

  /**
   * adapter から正規化される前の raw state。
   * デバッグや adapter 改善のために残しておく。
   */
  raw_state: Record<string, unknown>;
}

/**
 * Position の自動 roll ルール (§11.3 auto_roll_rule)
 *
 * 満期到来時の動作を事前定義しておく。Agent / 通知から即時 execute 可能にするための設定。
 */
export interface AutoRollRule {
  enabled: boolean;
  /** 満期到来時の action */
  on_maturity:
    | "withdraw"
    | "re_deposit"
    | "re_deposit_include_yield"
    | "re_deposit_exclude_yield"
    | "rotate";
  /** rotate 時の移転先 protocol */
  to_protocol?: string;
  /** rotate 時の最低 APY 条件 */
  min_target_apy?: number;
}
