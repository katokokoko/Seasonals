/**
 * SKR staking の読取 (docs/skr-r0-implementation.md §3「BFFの1本のread口」)
 *
 * - config / pool / 導出 UserStake / vault / mint / Clock を `commitment=confirmed` の
 *   **単一 getMultipleAccounts** で読む。応答の context.slot を採用し、個別 fetch を混ぜない
 * - account 種別ごとに owner / 長さ / discriminator (SKR account だけ) / PDA / 相互参照を検査。
 *   1 つでも通らなければ unsupported (偽の量・日付を作らない)。RPC 失敗は unavailable
 * - BFF cache なし、内部 retry なし、各 RPC の timeout 10 秒 (2 本は並列なので read 全体も 10 秒)
 * - 液体 SKR は別の getTokenAccountsByOwner (ATA / 非 ATA を合算、別 slot)。失敗しても staking 判定は変えない
 * - anchor coder / SDK は使わない (layout は lib/config/skr-staking.ts、IDL との一致は lib の test で検査)
 */
import { PublicKey } from "@solana/web3.js";
import {
  SKR_DECIMALS,
  SKR_GUARDIAN,
  SKR_GUARDIAN_POOL,
  SKR_LAYOUT,
  SKR_MINT,
  SKR_PDA_SEEDS,
  SKR_SHARE_PRICE_SCALE,
  SKR_STAKE_CONFIG,
  SKR_STAKE_VAULT,
  SKR_STAKING_CLUSTER,
  SKR_STAKING_PROGRAM_ID,
  SKR_STAKING_PROTOCOL_ID,
  SKR_SYMBOL,
  SOLANA_CLOCK_LAYOUT,
  SOLANA_CLOCK_SYSVAR,
  SOLANA_SYSVAR_OWNER,
  SPL_MINT_LAYOUT,
  SPL_TOKEN_ACCOUNT_LAYOUT,
  SPL_TOKEN_PROGRAM_ID,
} from "@workspace/lib/config/skr-staking";
import {
  LIQUID_UNAVAILABLE,
  failedCooldownState,
  freshCooldownState,
  type CooldownScope,
} from "@workspace/lib/derive/cooldown-position";
import {
  CooldownDataStatus,
  type CooldownLiquidView,
  type CooldownSource,
  type CooldownStateResponse,
} from "@workspace/lib/types";
import { fromBigInt, isValidTokenAmount } from "@workspace/lib/utils/numeric";
import { buildUrl } from "./helius-rpc";
import { fetchWithTimeout } from "./http";

/** read 1 本あたりの上限 (§3: read 全体 10 秒、retry なし) */
export const SKR_READ_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// RPC
// ─────────────────────────────────────────────────────────────────────────────

export interface RawAccount {
  owner: string;
  data: Buffer;
}

export interface SkrRpc {
  /** 単一 batch。accounts は addresses と同じ順・同じ長さ (不在は null) */
  getMultipleAccounts(addresses: string[]): Promise<{ slot: number; accounts: (RawAccount | null)[] }>;
  /** owner が持つ mint の token account の amount (smallest unit string) 一覧 */
  getTokenAmountsByOwner(owner: string, mint: string): Promise<{ slot: number; amounts: string[] }>;
}

/** RPC 失敗 (HTTP / JSON-RPC error / 形の不正)。message に URL / API key を含めない */
export class SkrRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkrRpcError";
  }
}

async function heliusCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetchWithTimeout(
    buildUrl(),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `seasonals-skr-${method}`, method, params }),
    },
    SKR_READ_TIMEOUT_MS
  );
  if (!res.ok) throw new SkrRpcError(`${method} HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (body.error) throw new SkrRpcError(`${method} RPC error ${body.error.code ?? ""}`.trim());
  if (body.result === undefined) throw new SkrRpcError(`${method} empty result`);
  return body.result;
}

function contextSlot(result: unknown, method: string): number {
  const slot = (result as { context?: { slot?: unknown } })?.context?.slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
    throw new SkrRpcError(`${method} missing context.slot`);
  }
  return slot;
}

/** Helius mainnet (HELIUS_API_KEY) の実 RPC */
export function createHeliusSkrRpc(): SkrRpc {
  return {
    async getMultipleAccounts(addresses) {
      const result = await heliusCall<{ value?: unknown }>("getMultipleAccounts", [
        addresses,
        { encoding: "base64", commitment: "confirmed" },
      ]);
      const slot = contextSlot(result, "getMultipleAccounts");
      const value = result.value;
      if (!Array.isArray(value) || value.length !== addresses.length) {
        throw new SkrRpcError("getMultipleAccounts length mismatch");
      }
      const accounts = value.map((v): RawAccount | null => {
        if (v === null) return null;
        const a = v as { owner?: unknown; data?: unknown };
        if (
          typeof a.owner !== "string" ||
          !Array.isArray(a.data) ||
          a.data[1] !== "base64" ||
          typeof a.data[0] !== "string"
        ) {
          throw new SkrRpcError("getMultipleAccounts malformed account");
        }
        return { owner: a.owner, data: Buffer.from(a.data[0], "base64") };
      });
      return { slot, accounts };
    },

    async getTokenAmountsByOwner(owner, mint) {
      const result = await heliusCall<{ value?: unknown }>("getTokenAccountsByOwner", [
        owner,
        { mint },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      const slot = contextSlot(result, "getTokenAccountsByOwner");
      if (!Array.isArray(result.value)) throw new SkrRpcError("getTokenAccountsByOwner malformed");
      const amounts = result.value.map((v) => {
        const amount = (v as { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } } } })
          ?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (typeof amount !== "string" || !isValidTokenAmount(amount)) {
          throw new SkrRpcError("getTokenAccountsByOwner malformed amount");
        }
        return amount;
      });
      return { slot, amounts };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PDA
// ─────────────────────────────────────────────────────────────────────────────

export class InvalidSkrWalletError extends Error {
  constructor() {
    super("invalid_wallet_address");
    this.name = "InvalidSkrWalletError";
  }
}

export interface SkrAccounts {
  config: string;
  pool: string;
  userStake: string;
  vault: string;
  mint: string;
  clock: string;
}

const PROGRAM = new PublicKey(SKR_STAKING_PROGRAM_ID);

function pda(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
}

let fixedPdas: { config: PublicKey; vault: PublicKey; pool: PublicKey } | null = null;

/** config / vault / pool の PDA (固定値と一致しなければ registry の誤り → 読まない) */
function fixedSkrPdas(): { config: PublicKey; vault: PublicKey; pool: PublicKey } {
  if (fixedPdas) return fixedPdas;
  const config = pda([Buffer.from(SKR_PDA_SEEDS.stakeConfig)]);
  const vault = pda([Buffer.from(SKR_PDA_SEEDS.stakeVault)]);
  const pool = pda([
    Buffer.from(SKR_PDA_SEEDS.guardianPool),
    config.toBuffer(),
    new PublicKey(SKR_GUARDIAN).toBuffer(),
  ]);
  if (
    config.toBase58() !== SKR_STAKE_CONFIG ||
    vault.toBase58() !== SKR_STAKE_VAULT ||
    pool.toBase58() !== SKR_GUARDIAN_POOL
  ) {
    throw new Error("SKR registry PDA mismatch");
  }
  fixedPdas = { config, vault, pool };
  return fixedPdas;
}

/** wallet の UserStake PDA を含む batch の住所 (順序 = config, pool, userStake, vault, mint, Clock) */
export function deriveSkrAccounts(wallet: string): SkrAccounts {
  let user: PublicKey;
  try {
    user = new PublicKey(wallet);
  } catch {
    throw new InvalidSkrWalletError();
  }
  const { config, vault, pool } = fixedSkrPdas();
  const userStake = pda([
    Buffer.from(SKR_PDA_SEEDS.userStake),
    config.toBuffer(),
    user.toBuffer(),
    pool.toBuffer(),
  ]);
  return {
    config: config.toBase58(),
    pool: pool.toBase58(),
    userStake: userStake.toBase58(),
    vault: vault.toBase58(),
    mint: SKR_MINT,
    clock: SOLANA_CLOCK_SYSVAR,
  };
}

export function skrBatchAddresses(a: SkrAccounts): string[] {
  return [a.config, a.pool, a.userStake, a.vault, a.mint, a.clock];
}

// ─────────────────────────────────────────────────────────────────────────────
// decode (owner → 長さ → discriminator → field)
// ─────────────────────────────────────────────────────────────────────────────

export type Decoded<T> = { ok: true; value: T } | { ok: false; reason: string };

function readU128LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset) + (buf.readBigUInt64LE(offset + 8) << 64n);
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

function checkShape(
  acc: RawAccount | null,
  label: string,
  owner: string,
  size: number,
  discriminator?: readonly number[]
): string | null {
  if (acc === null) return `${label}_missing`;
  if (acc.owner !== owner) return `${label}_owner`;
  if (acc.data.length !== size) return `${label}_size`;
  if (discriminator && !acc.data.subarray(0, 8).equals(Buffer.from(discriminator))) {
    return `${label}_discriminator`;
  }
  return null;
}

export interface DecodedStakeConfig {
  authority: string;
  mint: string;
  stake_vault: string;
  min_stake_amount: string;
  cooldown_seconds: string;
  total_shares: string;
  share_price: string;
  last_vault_amount: string;
}

export function decodeStakeConfig(acc: RawAccount | null): Decoded<DecodedStakeConfig> {
  const L = SKR_LAYOUT.stakeConfig;
  const bad = checkShape(acc, "config", SKR_STAKING_PROGRAM_ID, L.size, L.discriminator);
  if (bad || !acc) return { ok: false, reason: bad ?? "config_missing" };
  const d = acc.data;
  const o = L.offsets;
  return {
    ok: true,
    value: {
      authority: readPubkey(d, o.authority),
      mint: readPubkey(d, o.mint),
      stake_vault: readPubkey(d, o.stake_vault),
      min_stake_amount: d.readBigUInt64LE(o.min_stake_amount).toString(),
      cooldown_seconds: d.readBigUInt64LE(o.cooldown_seconds).toString(),
      total_shares: fromBigInt(readU128LE(d, o.total_shares)),
      share_price: fromBigInt(readU128LE(d, o.share_price)),
      last_vault_amount: fromBigInt(d.readBigUInt64LE(o.last_vault_amount)),
    },
  };
}

export interface DecodedGuardianPool {
  stake_config: string;
  guardian: string;
  total_shares: string;
  last_share_price: string;
  commission_bps: number;
  active: boolean;
}

export function decodeGuardianPool(acc: RawAccount | null): Decoded<DecodedGuardianPool> {
  const L = SKR_LAYOUT.guardianPool;
  const bad = checkShape(acc, "pool", SKR_STAKING_PROGRAM_ID, L.size, L.discriminator);
  if (bad || !acc) return { ok: false, reason: bad ?? "pool_missing" };
  const d = acc.data;
  const o = L.offsets;
  const activeByte = d.readUInt8(o.active);
  if (activeByte > 1) return { ok: false, reason: "pool_active_flag" };
  return {
    ok: true,
    value: {
      stake_config: readPubkey(d, o.stake_config),
      guardian: readPubkey(d, o.guardian),
      total_shares: fromBigInt(readU128LE(d, o.total_shares)),
      last_share_price: fromBigInt(readU128LE(d, o.last_share_price)),
      commission_bps: d.readUInt16LE(o.commission_bps),
      active: activeByte === 1,
    },
  };
}

export interface DecodedUserStake {
  stake_config: string;
  user: string;
  guardian_pool: string;
  shares: string;
  unstaking_amount: string;
  unstake_timestamp: string;
}

/** UserStake。account 不在は正常 (value: null) */
export function decodeUserStake(acc: RawAccount | null): Decoded<DecodedUserStake | null> {
  if (acc === null) return { ok: true, value: null };
  const L = SKR_LAYOUT.userStake;
  const bad = checkShape(acc, "user_stake", SKR_STAKING_PROGRAM_ID, L.size, L.discriminator);
  if (bad) return { ok: false, reason: bad };
  const d = acc.data;
  const o = L.offsets;
  return {
    ok: true,
    value: {
      stake_config: readPubkey(d, o.stake_config),
      user: readPubkey(d, o.user),
      guardian_pool: readPubkey(d, o.guardian_pool),
      shares: fromBigInt(readU128LE(d, o.shares)),
      unstaking_amount: fromBigInt(d.readBigUInt64LE(o.unstaking_amount)),
      unstake_timestamp: d.readBigInt64LE(o.unstake_timestamp).toString(),
    },
  };
}

export interface DecodedClock {
  slot: string;
  unix_timestamp: string;
}

export function decodeClock(acc: RawAccount | null): Decoded<DecodedClock> {
  const bad = checkShape(acc, "clock", SOLANA_SYSVAR_OWNER, SOLANA_CLOCK_LAYOUT.size);
  if (bad || !acc) return { ok: false, reason: bad ?? "clock_missing" };
  const o = SOLANA_CLOCK_LAYOUT.offsets;
  return {
    ok: true,
    value: {
      slot: acc.data.readBigUInt64LE(o.slot).toString(),
      unix_timestamp: acc.data.readBigInt64LE(o.unix_timestamp).toString(),
    },
  };
}

export interface DecodedTokenAccount {
  mint: string;
  /** token authority (SPL の owner field) */
  authority: string;
  amount: string;
}

export function decodeSplTokenAccount(acc: RawAccount | null): Decoded<DecodedTokenAccount> {
  const L = SPL_TOKEN_ACCOUNT_LAYOUT;
  const bad = checkShape(acc, "vault", SPL_TOKEN_PROGRAM_ID, L.size);
  if (bad || !acc) return { ok: false, reason: bad ?? "vault_missing" };
  return {
    ok: true,
    value: {
      mint: readPubkey(acc.data, L.offsets.mint),
      authority: readPubkey(acc.data, L.offsets.owner),
      amount: fromBigInt(acc.data.readBigUInt64LE(L.offsets.amount)),
    },
  };
}

export interface DecodedMint {
  decimals: number;
  is_initialized: boolean;
}

export function decodeSplMint(acc: RawAccount | null): Decoded<DecodedMint> {
  const L = SPL_MINT_LAYOUT;
  const bad = checkShape(acc, "mint", SPL_TOKEN_PROGRAM_ID, L.size);
  if (bad || !acc) return { ok: false, reason: bad ?? "mint_missing" };
  return {
    ok: true,
    value: {
      decimals: acc.data.readUInt8(L.offsets.decimals),
      is_initialized: acc.data.readUInt8(L.offsets.is_initialized) === 1,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// batch の検証
// ─────────────────────────────────────────────────────────────────────────────

export interface SkrBatch {
  config: DecodedStakeConfig;
  pool: DecodedGuardianPool;
  userStake: DecodedUserStake | null;
  vault: DecodedTokenAccount;
  mint: DecodedMint;
  clock: DecodedClock;
}

/** 6 account を decode し、相互参照を検査する。順序は skrBatchAddresses と同じ */
export function decodeAndValidateSkrBatch(
  wallet: string,
  addrs: SkrAccounts,
  accounts: (RawAccount | null)[]
): Decoded<SkrBatch> {
  if (accounts.length !== 6) return { ok: false, reason: "batch_length" };
  const [configAcc, poolAcc, userAcc, vaultAcc, mintAcc, clockAcc] = accounts;

  const config = decodeStakeConfig(configAcc ?? null);
  if (!config.ok) return config;
  const pool = decodeGuardianPool(poolAcc ?? null);
  if (!pool.ok) return pool;
  const userStake = decodeUserStake(userAcc ?? null);
  if (!userStake.ok) return userStake;
  const vault = decodeSplTokenAccount(vaultAcc ?? null);
  if (!vault.ok) return vault;
  const mint = decodeSplMint(mintAcc ?? null);
  if (!mint.ok) return mint;
  const clock = decodeClock(clockAcc ?? null);
  if (!clock.ok) return clock;

  const c = config.value;
  const p = pool.value;
  const u = userStake.value;
  const v = vault.value;

  // config の参照
  if (c.mint !== SKR_MINT) return { ok: false, reason: "config_mint" };
  if (c.stake_vault !== addrs.vault) return { ok: false, reason: "config_vault" };
  // pool: config に属し、guardian から導出した PDA が読んだ住所と一致し、有効
  if (p.stake_config !== addrs.config) return { ok: false, reason: "pool_config" };
  const poolPda = pda([
    Buffer.from(SKR_PDA_SEEDS.guardianPool),
    new PublicKey(addrs.config).toBuffer(),
    new PublicKey(p.guardian).toBuffer(),
  ]).toBase58();
  if (poolPda !== addrs.pool) return { ok: false, reason: "pool_pda" };
  // 非 active pool は share price の扱いが変わる (deregistered_share_price)。R0 の対象外 = 読まない
  if (!p.active) return { ok: false, reason: "pool_inactive" };
  // vault: SKR mint の token account で、authority は stake config
  if (v.mint !== SKR_MINT) return { ok: false, reason: "vault_mint" };
  if (v.authority !== addrs.config) return { ok: false, reason: "vault_authority" };
  // mint
  if (!mint.value.is_initialized || mint.value.decimals !== SKR_DECIMALS) {
    return { ok: false, reason: "mint_decimals" };
  }
  // 本人 UserStake の参照
  if (u) {
    if (u.stake_config !== addrs.config) return { ok: false, reason: "user_stake_config" };
    if (u.user !== wallet) return { ok: false, reason: "user_stake_user" };
    if (u.guardian_pool !== addrs.pool) return { ok: false, reason: "user_stake_pool" };
  }

  return {
    ok: true,
    value: { config: c, pool: p, userStake: u, vault: v, mint: mint.value, clock: clock.value },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// read
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadSkrStakingDeps {
  source: CooldownSource;
  rpc: SkrRpc;
  now?: () => Date;
  /** unavailable / unsupported の理由 (log 用。response には出さない) */
  onReject?: (status: "unavailable" | "unsupported", reason: string) => void;
}

function liquidFrom(
  r: PromiseSettledResult<{ slot: number; amounts: string[] }>,
  observedAt: string
): CooldownLiquidView {
  if (r.status !== "fulfilled") return LIQUID_UNAVAILABLE;
  let sum = 0n;
  for (const a of r.value.amounts) sum += BigInt(a); // isValidTokenAmount 済み
  return {
    amount: fromBigInt(sum),
    slot: r.value.slot,
    observed_at: observedAt,
    data_status: CooldownDataStatus.Fresh,
  };
}

/**
 * wallet の SKR staking 状態を 1 batch で読む。
 * 例外を投げるのは wallet 自体が不正な時 (InvalidSkrWalletError) だけで、それ以外は data_status で返す。
 */
export async function readSkrStakingState(
  wallet: string,
  deps: ReadSkrStakingDeps
): Promise<CooldownStateResponse> {
  const now = deps.now ?? (() => new Date());
  const addrs = deriveSkrAccounts(wallet);
  const scope: CooldownScope = {
    source: deps.source,
    cluster: SKR_STAKING_CLUSTER,
    wallet_address: wallet,
    protocol_id: SKR_STAKING_PROTOCOL_ID,
    position_account: addrs.userStake,
    pool: addrs.pool,
  };

  const [batchR, liquidR] = await Promise.allSettled([
    deps.rpc.getMultipleAccounts(skrBatchAddresses(addrs)),
    deps.rpc.getTokenAmountsByOwner(wallet, SKR_MINT),
  ]);
  const observedAt = now().toISOString();
  const liquid = liquidFrom(liquidR, observedAt);

  if (batchR.status !== "fulfilled") {
    const reason = batchR.reason instanceof Error ? batchR.reason.name : "rpc_failed";
    deps.onReject?.("unavailable", reason);
    return failedCooldownState(scope, CooldownDataStatus.Unavailable, liquid);
  }

  const batch = decodeAndValidateSkrBatch(wallet, addrs, batchR.value.accounts);
  if (!batch.ok) {
    deps.onReject?.("unsupported", batch.reason);
    return failedCooldownState(scope, CooldownDataStatus.Unsupported, liquid);
  }

  const b = batch.value;
  try {
    return freshCooldownState(
      {
        scope,
        asset: { mint: SKR_MINT, symbol: SKR_SYMBOL, decimals: SKR_DECIMALS },
        share_price_scale: SKR_SHARE_PRICE_SCALE,
        config: { cooldown_seconds: b.config.cooldown_seconds, share_price: b.config.share_price },
        observed_at: observedAt,
        slot: batchR.value.slot,
        chain_time: b.clock.unix_timestamp,
        user: b.userStake
          ? {
              shares: b.userStake.shares,
              pending_amount: b.userStake.unstaking_amount,
              unstake_timestamp: b.userStake.unstake_timestamp,
            }
          : null,
      },
      liquid
    );
  } catch (err) {
    deps.onReject?.("unsupported", err instanceof Error ? `derive_${err.name}` : "derive_failed");
    return failedCooldownState(scope, CooldownDataStatus.Unsupported, liquid);
  }
}
