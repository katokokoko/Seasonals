/**
 * perena — Perena Tri-Stable Pool (旧 USD* の pool) の TVL を on-chain の vault 残高から出す。
 * vault は lib/config/perena.ts に固定 (pool PDA は spam token も持つので owner 一覧では数えない)。
 * 1 回の getMultipleAccounts で 3 vault を読み、SPL token account の先頭 layout
 * (mint 0..32 / owner 32..64 / amount u64 LE 64..72、Token-2022 も同じ) を decode する。
 */
import { PublicKey } from "@solana/web3.js";
import { PERENA_TRI_STABLE_POOL, PERENA_TRI_STABLE_VAULTS } from "@workspace/lib/config/perena";
import { getMultipleAccountsBase64, type RawAccount } from "./helius-rpc";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** 1 vault の残高 (smallest unit)。mint / owner / program が想定と違えば throw (別の account を数えない) */
export function decodeVaultAmount(acct: RawAccount | null, expected: { mint: string; vault: string; token2022?: boolean }): bigint {
  if (!acct) throw new Error(`Perena vault ${expected.vault} not found`);
  const program = expected.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  if (acct.owner !== program) throw new Error(`Perena vault ${expected.vault}: unexpected program ${acct.owner}`);
  if (acct.data.length < 72) throw new Error(`Perena vault ${expected.vault}: account too short`);
  const mint = new PublicKey(acct.data.subarray(0, 32)).toBase58();
  const owner = new PublicKey(acct.data.subarray(32, 64)).toBase58();
  if (mint !== expected.mint) throw new Error(`Perena vault ${expected.vault}: mint mismatch`);
  if (owner !== PERENA_TRI_STABLE_POOL) throw new Error(`Perena vault ${expected.vault}: owner is not the Tri-Stable pool`);
  return acct.data.readBigUInt64LE(64);
}

/**
 * Tri-Stable Pool の TVL (USD)。中身は USDC / USDT / PYUSD なので 1 token = $1 として合算する
 * (Menu の表示用 TVL。既存の `tvl_usd: number` と同じ扱い)。量は bigint で足してから最後に割る
 */
export async function fetchPerenaTriStableTvlUsd(): Promise<number> {
  const accts = await getMultipleAccountsBase64(PERENA_TRI_STABLE_VAULTS.map((v) => v.vault));
  if (!Array.isArray(accts) || accts.length !== PERENA_TRI_STABLE_VAULTS.length) {
    throw new Error("Perena vaults: unexpected RPC result");
  }
  // 3 vault とも decimals 6 (lib で固定)。違う decimals が混ざったら合算できないので止める
  const decimals = PERENA_TRI_STABLE_VAULTS[0]!.decimals;
  if (PERENA_TRI_STABLE_VAULTS.some((v) => v.decimals !== decimals)) throw new Error("Perena vaults: mixed decimals");
  let total = 0n;
  PERENA_TRI_STABLE_VAULTS.forEach((v, i) => {
    total += decodeVaultAmount(accts[i] ?? null, v);
  });
  return Number(total) / 10 ** decimals;
}
