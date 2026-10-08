/**
 * SKR staking account の byte 組み立て (docs/skr-r0-implementation.md §1 P0 / §6)
 *
 * demo source (録画用) と test が使う。取得済み mainnet batch
 * (lib/__fixtures__/skr-staking/protocol-reference-20260920.json) の config / pool / vault / mint を
 * そのまま replay し、利用者の UserStake と Clock だけを合成する。
 * layout は lib/config/skr-staking.ts (IDL と一致を lib の test で検査済み)。
 */
import { PublicKey } from "@solana/web3.js";
import { fixtureSkrProtocolReference as ref } from "@workspace/lib/__fixtures__/skr-staking/protocol-reference";
import {
  SKR_LAYOUT,
  SKR_STAKING_PROGRAM_ID,
  SOLANA_CLOCK_LAYOUT,
  SOLANA_SYSVAR_OWNER,
  SPL_TOKEN_ACCOUNT_LAYOUT,
} from "@workspace/lib/config/skr-staking";
import type { RawAccount } from "./skr-staking";

const U64_MASK = (1n << 64n) - 1n;

export function writeU128LE(buf: Buffer, value: bigint, offset: number): void {
  if (value < 0n || value >> 128n !== 0n) throw new RangeError(`u128 out of range: ${value}`);
  buf.writeBigUInt64LE(value & U64_MASK, offset);
  buf.writeBigUInt64LE(value >> 64n, offset + 8);
}

function writePubkey(buf: Buffer, address: string, offset: number): void {
  new PublicKey(address).toBuffer().copy(buf, offset);
}

export interface UserStakeFields {
  stake_config: string;
  user: string;
  guardian_pool: string;
  shares: bigint;
  unstaking_amount: bigint;
  unstake_timestamp: bigint;
  cost_basis?: bigint;
  cumulative_commission_before_staking?: bigint;
  bump?: number;
}

/** UserStake (169 byte) を組み立てる */
export function encodeUserStake(f: UserStakeFields): Buffer {
  const L = SKR_LAYOUT.userStake;
  const o = L.offsets;
  const buf = Buffer.alloc(L.size);
  Buffer.from(L.discriminator).copy(buf, 0);
  buf.writeUInt8(f.bump ?? 254, o.bump);
  writePubkey(buf, f.stake_config, o.stake_config);
  writePubkey(buf, f.user, o.user);
  writePubkey(buf, f.guardian_pool, o.guardian_pool);
  writeU128LE(buf, f.shares, o.shares);
  writeU128LE(buf, f.cost_basis ?? 1_000_000_000n, o.cost_basis);
  writeU128LE(buf, f.cumulative_commission_before_staking ?? 0n, o.cumulative_commission_before_staking);
  buf.writeBigUInt64LE(f.unstaking_amount, o.unstaking_amount);
  buf.writeBigInt64LE(f.unstake_timestamp, o.unstake_timestamp);
  return buf;
}

export interface ClockFields {
  slot: bigint;
  epoch_start_timestamp: bigint;
  epoch: bigint;
  leader_schedule_epoch: bigint;
  unix_timestamp: bigint;
}

/** Clock sysvar (40 byte) を組み立てる */
export function encodeClock(f: ClockFields): Buffer {
  const o = SOLANA_CLOCK_LAYOUT.offsets;
  const buf = Buffer.alloc(SOLANA_CLOCK_LAYOUT.size);
  buf.writeBigUInt64LE(f.slot, o.slot);
  buf.writeBigInt64LE(f.epoch_start_timestamp, o.epoch_start_timestamp);
  buf.writeBigUInt64LE(f.epoch, o.epoch);
  buf.writeBigUInt64LE(f.leader_schedule_epoch, o.leader_schedule_epoch);
  buf.writeBigInt64LE(f.unix_timestamp, o.unix_timestamp);
  return buf;
}

/** StakeConfig の一部 field を書き換えた copy (他人の操作・config 変更の模擬) */
export function patchStakeConfig(
  base: Buffer,
  patch: {
    cooldown_seconds?: bigint;
    total_shares?: bigint;
    share_price?: bigint;
    last_vault_amount?: bigint;
  }
): Buffer {
  const o = SKR_LAYOUT.stakeConfig.offsets;
  const buf = Buffer.from(base);
  if (patch.cooldown_seconds !== undefined) buf.writeBigUInt64LE(patch.cooldown_seconds, o.cooldown_seconds);
  if (patch.total_shares !== undefined) writeU128LE(buf, patch.total_shares, o.total_shares);
  if (patch.share_price !== undefined) writeU128LE(buf, patch.share_price, o.share_price);
  if (patch.last_vault_amount !== undefined) buf.writeBigUInt64LE(patch.last_vault_amount, o.last_vault_amount);
  return buf;
}

/** GuardianDelegationPool の total_shares を書き換えた copy */
export function patchGuardianPoolTotalShares(base: Buffer, totalShares: bigint): Buffer {
  const buf = Buffer.from(base);
  writeU128LE(buf, totalShares, SKR_LAYOUT.guardianPool.offsets.total_shares);
  return buf;
}

/** SPL token account の amount を書き換えた copy (vault 残高の変化) */
export function patchTokenAccountAmount(base: Buffer, amount: bigint): Buffer {
  const buf = Buffer.from(base);
  buf.writeBigUInt64LE(amount, SPL_TOKEN_ACCOUNT_LAYOUT.offsets.amount);
  return buf;
}

export interface ReferenceAccounts {
  config: RawAccount;
  pool: RawAccount;
  vault: RawAccount;
  mint: RawAccount;
  clock: RawAccount;
}

/** 取得済み mainnet batch の 5 account (毎回新しい Buffer を返す) */
export function referenceAccounts(): ReferenceAccounts {
  const v = ref.rpc_response.result.value;
  const acc = (i: number): RawAccount => {
    const a = v[i];
    if (!a || a.data[1] !== "base64" || typeof a.data[0] !== "string") {
      throw new Error(`protocol reference account ${i} missing`);
    }
    return { owner: a.owner, data: Buffer.from(a.data[0], "base64") };
  };
  return { config: acc(0), pool: acc(1), vault: acc(2), mint: acc(3), clock: acc(4) };
}

/** 取得済み Clock の値 (demo は unix_timestamp / slot だけ差し替える) */
export function referenceClockFields(): ClockFields {
  const data = referenceAccounts().clock.data;
  const o = SOLANA_CLOCK_LAYOUT.offsets;
  return {
    slot: data.readBigUInt64LE(o.slot),
    epoch_start_timestamp: data.readBigInt64LE(o.epoch_start_timestamp),
    epoch: data.readBigUInt64LE(o.epoch),
    leader_schedule_epoch: data.readBigUInt64LE(o.leader_schedule_epoch),
    unix_timestamp: data.readBigInt64LE(o.unix_timestamp),
  };
}

export function programAccount(data: Buffer): RawAccount {
  return { owner: SKR_STAKING_PROGRAM_ID, data };
}

export function clockAccount(fields: ClockFields): RawAccount {
  return { owner: SOLANA_SYSVAR_OWNER, data: encodeClock(fields) };
}
