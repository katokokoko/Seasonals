/**
 * save-reserve — Save (旧 Solend) reserve の総供給量を on-chain から読む (2026-10)
 *
 * menu の savefi pool TVL を live 化するための client。api.save.finance の
 * /v1/reserves は APY / cToken レートしか返さないため、reserve account を
 * getMultipleAccounts 1 回で読み、@solendprotocol/solend-sdk の parseReserve で decode する。
 *
 *   total (smallest unit) = liquidity.availableAmount + liquidity.borrowedAmountWads / 1e18
 *
 * 規約 (§4.5): 演算は bigint のみ。USD 換算 (表示専用 Number) は呼び手 (/menu-listings)。
 * fail-closed: account 欠落 / owner が Save program でない / decode 不能 は throw →
 * 呼び手の allSettled で fixture 値へ degrade する。
 *
 * owner は SDK 定数 SOLEND_PRODUCTION_PROGRAM_ID (So1endDq…CpAo)。2026-10-06 に
 * SAVE_MARKETS の 2 reserve の on-chain owner が同値であることを確認済。
 */

import { PublicKey } from "@solana/web3.js";
import {
  parseReserve,
  SOLEND_PRODUCTION_PROGRAM_ID,
} from "@solendprotocol/solend-sdk";

import { getMultipleAccountsBase64 } from "./helius-rpc";

// SDK は自前の web3.js を持ち nominal 型が合わない (save-tx.ts と同じ事情) ため
// 境界型は Parameters<> で抽出して cast する。runtime は Buffer / PublicKey で互換。
type SdkPubkey = Parameters<typeof parseReserve>[0];
type SdkAccountInfo = Parameters<typeof parseReserve>[1];

const WAD = 10n ** 18n;
const TTL_MS = 5 * 60_000;

export interface SaveReserveTotal {
  /** 供給総量 (underlying smallest unit) = available + borrowed */
  total: bigint;
  decimals: number;
}

let cache: { at: number; key: string; values: Map<string, SaveReserveTotal> } | null = null;

/** BN / bigint / number を bigint に (SDK は BN を返す。toString() 経由で精度を落とさない)。 */
function bnToBigInt(v: unknown, label: string): bigint {
  const s = v === null || v === undefined ? "" : String(v);
  if (!/^[0-9]+$/.test(s)) throw new Error(`Save reserve: invalid ${label}`);
  return BigInt(s);
}

/**
 * reserve address → { total, decimals }。全 reserve が揃わなければ throw
 * (一部だけ返すと pool 間で live / fixture が混ざり読み違えるため)。5min cache。
 */
export async function fetchSaveReserveTotals(
  reserves: string[]
): Promise<Map<string, SaveReserveTotal>> {
  const key = reserves.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) {
    return cache.values;
  }
  const accounts = await getMultipleAccountsBase64(reserves);
  const programId = SOLEND_PRODUCTION_PROGRAM_ID.toBase58();
  const out = new Map<string, SaveReserveTotal>();
  reserves.forEach((addr, i) => {
    const acc = accounts[i];
    if (!acc) throw new Error(`Save reserve ${addr}: account not found`);
    if (acc.owner !== programId) {
      throw new Error(`Save reserve ${addr}: unexpected owner ${acc.owner}`);
    }
    const parsed = parseReserve(
      new PublicKey(addr) as unknown as SdkPubkey,
      {
        data: acc.data,
        owner: new PublicKey(acc.owner),
        executable: false,
        lamports: 0,
      } as unknown as SdkAccountInfo
    );
    const liq = parsed?.info?.liquidity;
    if (!liq) throw new Error(`Save reserve ${addr}: decode failed`);
    const available = bnToBigInt(liq.availableAmount, "availableAmount");
    const borrowed = bnToBigInt(liq.borrowedAmountWads, "borrowedAmountWads") / WAD;
    const decimals = liq.mintDecimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`Save reserve ${addr}: invalid mintDecimals`);
    }
    out.set(addr, { total: available + borrowed, decimals });
  });
  cache = { at: Date.now(), key, values: out };
  return out;
}

/** test 用: cache クリア */
export function _clearSaveReserveCacheForTest(): void {
  cache = null;
}
