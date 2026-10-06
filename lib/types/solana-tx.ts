/**
 * Solana unsigned tx builder / submit の wire 型 (BFF `server.ts` の `/protocols/*-tx` と `/tx/*`)。
 *
 * Seeker (MWA) と Web (Wallet Standard) が同じ BFF endpoint を同じ契約で呼ぶための canonical 型
 * (CLAUDE.md §1: Mobile / Web で型をローカル定義しない)。tx は base64 の v0 VersionedTransaction。
 * Meteora / Orca の deposit は BFF の使い捨て keypair で部分署名済み — wallet は自分の署名だけを足す。
 *
 * 数値表現 (§4.5): amount は smallest unit の整数 string。
 */

/** `/protocols/{swap-earn,jupiter-lend}/{deposit,withdraw}-tx` (Jupiter swap 経由) */
export interface SwapEarnTxResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  outAmount: string;
  outputMint: string;
  quote: unknown;
}

/** `/protocols/kamino/{deposit,withdraw}-tx` (Lend reserve) */
export interface KaminoTxResponse {
  transaction: string;
  reserve: string;
  market: string;
  underlyingMint: string;
}

/** `/protocols/kamino/vault-{deposit,withdraw}-tx` (kVault) */
export interface KaminoVaultTxResponse {
  transaction: string;
  vault: string;
  underlyingMint: string;
}

/** `/protocols/exponent/redeem-tx` (満期後の PT redeem) */
export interface ExponentRedeemTxResponse {
  transaction: string;
  ptMint: string;
  underlyingMint: string;
}

/** `/protocols/meteora/{deposit,withdraw}-tx` (DLMM) */
export interface MeteoraTxResponse {
  transactions: string[];
  position?: string;
  bps?: number;
  poolAddress: string;
}

/** `/protocols/orca/{deposit,withdraw}-tx` (Whirlpools、deposit = swap + open の 2 本) */
export interface OrcaTxResponse {
  transactions: string[];
  /** deposit 時のみ: position mint (NFT) pubkey */
  position?: string;
  bps?: number;
  poolAddress: string;
}

/** `/protocols/save/{deposit,withdraw}-tx` (旧 Solend、ATA 準備等で最大 4 本) */
export interface SaveTxResponse {
  transactions: string[];
  reserve: string;
  ctokenMint: string;
  underlyingMint: string;
}

/** `POST /tx/submit` — 署名済 tx を BFF が Helius mainnet で broadcast */
export interface TxSubmitRequest {
  /** base64 の署名済 tx */
  signedTx: string;
  /** 2 本目以降は先行 tx 未 confirm でも preflight で落ちないよう true */
  skipPreflight?: boolean;
}
export interface TxSubmitResponse {
  signature: string;
}

/** `GET /tx/status?signature=` — getSignatureStatuses の要約 */
export type TxConfirmationStatus = "pending" | "processed" | "confirmed" | "finalized" | "failed";
export interface TxStatusResponse {
  signature: string;
  status: TxConfirmationStatus;
  /** 着地した slot。未着地なら null */
  slot: number | null;
  /** 失敗時の on-chain error (JSON 文字列化)。成功 / 未着地なら null */
  err: string | null;
}

/**
 * BFF の Solana tx builder / submit が返す error code (`{ error, message }` の error)。
 * - oracle_blocked / fair_value_blocked は「安全のため拒否した」= 失敗ではなく declined (Seeker 8.74)
 */
export type SolanaTxErrorCode =
  | "oracle_blocked"
  | "fair_value_blocked"
  | "insufficient_balance"
  | "invalid_amount"
  | "not_matured"
  | "missing_required_field"
  | "invalid_wallet_address"
  | "submit_failed";

export const SOLANA_DECLINED_CODES: readonly SolanaTxErrorCode[] = ["oracle_blocked", "fair_value_blocked"];

/**
 * Solana の deposit / withdraw を 1 件組むための入力 (ActionSpec の部分集合)。
 * Seeker は synthetic AgentPlan の selected_action として、Web はそのまま使う。
 * metadata: deposit = { pool_id }、withdraw = { share_mint, share_decimals, underlying_decimals, underlying_amount }
 */
export interface SolanaActionInput {
  action_type: "deposit" | "withdraw";
  protocol: string;
  asset?: string;
  /** smallest unit string。deposit は入力前なら "" */
  amount?: string;
  metadata?: Record<string, unknown>;
}

/**
 * action を読む純関数 (amount-utils / oracle-gate / solana-action) が受ける最小の形。
 * ActionSpec (Seeker の synthetic plan) と SolanaActionInput (Web) の両方が満たす
 */
export interface SolanaActionShape {
  action_type: string;
  protocol: string;
  asset?: string;
  amount?: string;
  metadata?: Record<string, unknown>;
}
