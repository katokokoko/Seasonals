/**
 * SKR staking 共通 account の raw batch (mainnet-beta / confirmed / slot 448756823)。
 *
 * JSON 本体 (protocol-reference-20260920.json) は取得記録としてそのまま残し、ここで型だけ付ける。
 * 利用者の UserStake は含まない (README.md)。demo source と BFF test はこの bytes を replay し、
 * UserStake と Clock だけを合成する (docs/skr-r0-implementation.md §1 P0)。
 */
import raw from "./protocol-reference-20260920.json";

export interface SkrRawRpcAccount {
  /** [base64, "base64"] */
  data: string[];
  executable: boolean;
  lamports: number;
  owner: string;
  /** u64::MAX が JSON number で精度落ちしているので使わない */
  rentEpoch: number;
  space: number;
}

export interface SkrProtocolReferenceFixture {
  kind: string;
  cluster: string;
  commitment: string;
  captured_at: string;
  idl_sha256: string;
  program: string;
  /** [config, pool, vault, mint, Clock] の順 */
  addresses: string[];
  rpc_response: {
    jsonrpc: string;
    id: number;
    result: {
      context: { apiVersion: string; slot: number };
      value: SkrRawRpcAccount[];
    };
  };
  decoded: {
    config: {
      bump: number;
      authority: string;
      mint: string;
      stake_vault: string;
      min_stake_amount: string;
      cooldown_seconds: string;
      total_shares: string;
      share_price: string;
      commission_weight_sum: string;
      cumulative_commission_per_share: string;
      last_vault_amount: string;
    };
    pool: {
      stake_config: string;
      guardian: string;
      authority: string;
      total_shares: string;
      cumulative_commission_per_share: string;
      last_share_price: string;
      accrued_commission: string;
      commission_bps: number;
      bump: number;
      active: boolean;
      deregistered_share_price: string;
    };
    vault_token_authority: string;
    mint_decimals: number;
    chain_time: string;
  };
  checks: Record<string, boolean>;
  user_stake_included: boolean;
}

export const fixtureSkrProtocolReference: SkrProtocolReferenceFixture = raw;
