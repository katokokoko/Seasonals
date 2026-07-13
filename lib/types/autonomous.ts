/**
 * AutonomousExecutionRecord — 自律実行の監査記録 (Phase 8.29)
 *
 * BFF の bounded 委任署名サイクル (compare → policy → 委任署名 → broadcast) の
 * 1 実行 = 1 record。永続監査 + web-readable ログの単位 (§17.4 の前段)。
 *
 * 決定/実行の分離: 決定層は実 mainnet の live menu (`decision_source`)、実行層は
 * devnet の bounded tx。amount_usd8 (決定 notional) と lamports (実移動) は意図的
 * に decouple される (v1 は symbolic transfer)。
 *
 * §32.2: `delegate_pubkey` は **pubkey のみ**。secret は record にもログにも載せない。
 */

import type { Objective } from "./enums";

export type AutonomousDecision = "executed" | "dry_run" | "rejected";

export interface AutonomousExecutionRecord {
  /** `auto_<uuid>` */
  record_id: string;
  /** 紐付く 8.28 AgentPlan (サイクル毎に生成)。reject 前は null */
  plan_id: string | null;
  /** 委任アカウントの base58 pubkey (secret は含めない) */
  delegate_pubkey: string | null;
  objective: Objective;
  /** 選定 protocol (reject は null) */
  protocol: string | null;
  /** v1 は "deposit" (決定層の意図) */
  action_type: string;
  asset: string | null;
  /** 決定 notional (USD 8-dec string、§4.5) */
  amount_usd8: string;
  /** devnet で実際に動いた lamports (smallest string)。未実行は "0" */
  lamports: string;
  decision: AutonomousDecision;
  /** reject/失敗の理由 (成功は null) */
  reason: string | null;
  /** PolicyViolation code + hard-cap/runtime code */
  violations: string[];
  /** 実 confirmed devnet 署名 (dry_run/reject は null) */
  tx_signature: string | null;
  network: "devnet";
  /** 決定層のデータ源 (mainnet live menu) */
  decision_source: "mainnet_menu_live";
  /** funds-moved push を試みた時刻 (未送信は null) */
  notified_at: string | null;
  /** ISO 8601 */
  created_at: string;
}

/**
 * AutonomousStatus — 自律オプションの現在状態 (Phase 8.30)
 *
 * `GET /autonomous/status` の response DTO。BFF が算出し、mobile / web の管制盤が
 * 「AI は今 armed か / 今日いくら動いたか / 絶対上限は」を描画するために読む
 * (same source of truth: BFF と各クライアントが同じ型を共有、§32.2)。
 *
 * §32.2: `delegate_pubkey` は pubkey のみ (secret は含めない)。
 * `hard_caps` は user policy と独立の絶対上限で、policy が無制限でも超えられない。
 */
export interface AutonomousStatus {
  /** flag ∧ devnet ∧ !killed ∧ delegate あり */
  enabled: boolean;
  feature_flag: boolean;
  devnet: boolean;
  killed: boolean;
  delegate_pubkey: string | null;
  daily_count: number;
  daily_limit: number;
  hard_caps: { max_tx_usd8: string; max_daily: number; max_lamports: string };
}
