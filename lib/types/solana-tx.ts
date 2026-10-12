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
  /** 2026-10-13: 実際に支払った mint (funding deposit なら funding token)。旧 BFF には無い */
  inputMint?: string;
}

/**
 * swap の償還価値ガードの判定 (BFF fair-value.ts FairValueVerdict と同形)。
 * - ok: 参照値との乖離 (bps、正 = ユーザー不利)
 * - no_reference: 参照レートを持たない market (ガード対象外)
 * - blocked: 乖離が guard を超えた / 参照が取れなかった (execute は 409 fair_value_blocked)
 */
export type SwapFairValueVerdict =
  | { status: "ok"; deviation_bps: number }
  | { status: "no_reference" }
  | { status: "blocked"; reason: "fair_value_deviation" | "fair_value_unavailable"; deviation_bps?: number };

/** `POST /protocols/swap-earn/quote` — tx を組まずに見積りだけ返す (2026-10-13、"Receive ≈" 表示用) */
export interface SwapEarnQuoteRequest {
  shareMint: string;
  /** 省略 = market の underlying。funding token の mint を渡すと funding deposit の見積り */
  inputMint?: string;
  /** smallest unit string (§4.5) */
  amount: string;
  slippageBps?: number;
}
export interface SwapEarnQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** slippage 込みの最低受取 (Jupiter otherAmountThreshold) */
  minOut: string;
  /** Jupiter の priceImpactPct (string のまま) */
  priceImpactPct: string;
  slippageBps: number;
  fairValue: SwapFairValueVerdict;
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
  /**
   * 問い合わせ時点の現在 block height (getBlockHeight)。client は builder が返した
   * `lastValidBlockHeight` と比べ、超えていてまだ pending なら「期限切れ = 着地しない」と
   * 確定できる (lib/derive/tx-confirm.ts)。旧 BFF には無いので optional
   */
  blockHeight?: number | null;
}

/** `GET /health` — Fly の health check と client の実行可否判定 (key / URL は返さない) */
export type SolanaExecutionTarget = "mainnet" | "disabled";
export interface HealthResponse {
  status: string;
  timestamp?: string;
  /** build の commit (GIT_SHA)。未設定なら null */
  version?: string | null;
  /** 旧 BFF には無い */
  solana?: {
    heliusConfigured: boolean;
    /** "disabled" = plans-only server。client は署名前に実行 CTA を止める (server.ts /health) */
    executionTarget?: SolanaExecutionTarget;
  };
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
  | "submit_failed"
  /** 2026-10-13: /tx/submit で blockhash が失効していた (409)。何も動いていない — 組み直して署名し直す */
  | "blockhash_expired"
  /** 2026-10-13: swap-earn deposit の inputMint が underlying でも allowlist の funding でもない */
  | "unsupported_input_mint"
  /** swap-earn の shareMint が registry に無い */
  | "unsupported_share_mint";

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
