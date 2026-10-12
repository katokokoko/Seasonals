/**
 * oracle-onchain — Solana 上の price feed account の導出と decode (Pyth sponsored push / RedStone push)。
 * どちらも Helius で読んだ生 bytes を手で decode する (anchor / 各社 SDK は入れない)。
 * layout は 2026-10-05 に実 account で確認 (src/__fixtures__/oracle/*.b64 に実データを固定)。
 *
 * 価格は 8 桁 USD string に **bigint で exact 変換** する (§4.5、float を通さない)。
 */
import { PublicKey } from "@solana/web3.js";
import { PYTH_PUSH_ORACLE_PROGRAM, PYTH_PUSH_SHARD, PYTH_RECEIVER_PROGRAM, REDSTONE_PROGRAM } from "@workspace/lib/config/oracle-feeds";
import type { RawAccount } from "./helius-rpc";

/** decode 結果。失敗理由は運用 log 用 (UI には出さない) */
export type DecodedPrice = { ok: true; price_usd: string; publishTimeSec: number } | { ok: false; reason: string };

const pdaCache = new Map<string, string>();

/** Pyth sponsored push feed account (shard 0) = PDA(push oracle, [u16 LE shard, feed_id]) */
export function pythPushAccount(feedIdHex: string): string {
  const key = `pyth:${feedIdHex}`;
  const hit = pdaCache.get(key);
  if (hit) return hit;
  const shard = Buffer.alloc(2);
  shard.writeUInt16LE(PYTH_PUSH_SHARD);
  const [pda] = PublicKey.findProgramAddressSync([shard, Buffer.from(feedIdHex, "hex")], new PublicKey(PYTH_PUSH_ORACLE_PROGRAM));
  pdaCache.set(key, pda.toBase58());
  return pda.toBase58();
}

/** RedStone price feed account = PDA(adapter, ["price" 32B 右 0 詰め, feed_id 32B 右 0 詰め]) */
export function redstonePriceAccount(feedId: string): string {
  const key = `redstone:${feedId}`;
  const hit = pdaCache.get(key);
  if (hit) return hit;
  const [pda] = PublicKey.findProgramAddressSync([pad32("price"), pad32(feedId)], new PublicKey(REDSTONE_PROGRAM));
  pdaCache.set(key, pda.toBase58());
  return pda.toBase58();
}

function pad32(ascii: string): Buffer {
  const b = Buffer.alloc(32);
  b.write(ascii, "ascii");
  return b;
}

/** 整数 value × 10^-decimals → "123.45678901" (8 桁固定、9 桁目以下は切り捨て) */
export function toUsd8(value: bigint, decimals: number): string {
  const scaled = decimals <= 8 ? value * 10n ** BigInt(8 - decimals) : value / 10n ** BigInt(decimals - 8);
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const int = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

/**
 * Pyth PriceUpdateV2 (pyth-solana-receiver):
 *   discriminator 8 / write_authority 32 / verification_level (enum: 0 = Partial{num_signatures u8}, 1 = Full) /
 *   feed_id 32 / price i64 / conf u64 / exponent i32 / publish_time i64 / prev_publish_time i64 / ema_price i64 / ema_conf u64 / posted_slot u64
 * Full verification の account だけ受ける (sponsored feed は Full)
 */
export function decodePythPriceUpdate(acct: RawAccount | null, expectedFeedIdHex: string): DecodedPrice {
  if (!acct) return { ok: false, reason: "account not found" };
  if (acct.owner !== PYTH_RECEIVER_PROGRAM) return { ok: false, reason: `unexpected owner ${acct.owner}` };
  const d = acct.data;
  if (d.length < 41) return { ok: false, reason: "account too short" };
  const level = d[40];
  if (level !== 1) return { ok: false, reason: "price update is not fully verified" };
  const o = 41;
  if (d.length < o + 32 + 8 + 8 + 4 + 8) return { ok: false, reason: "account too short" };
  const feedId = d.subarray(o, o + 32).toString("hex");
  if (feedId !== expectedFeedIdHex) return { ok: false, reason: "feed id mismatch" };
  const price = d.readBigInt64LE(o + 32);
  const exponent = d.readInt32LE(o + 48);
  const publishTimeSec = Number(d.readBigInt64LE(o + 52));
  if (price <= 0n) return { ok: false, reason: "non-positive price" };
  if (exponent > 0 || exponent < -18) return { ok: false, reason: `unexpected exponent ${exponent}` };
  return { ok: true, price_usd: toUsd8(price, -exponent), publishTimeSec };
}

/**
 * RedStone PriceData (176 bytes):
 *   discriminator 8 / feed_id 32 (ASCII 右 0 詰め) / value u256 BE 32 (× 10^decimals) / timestamp u64 LE (ms) /
 *   write_timestamp Option<u64> / update_slot u64 / decimals u8 / reserved 64
 */
export function decodeRedstonePriceData(acct: RawAccount | null, expectedFeedId: string): DecodedPrice {
  if (!acct) return { ok: false, reason: "account not found" };
  if (acct.owner !== REDSTONE_PROGRAM) return { ok: false, reason: `unexpected owner ${acct.owner}` };
  const d = acct.data;
  if (d.length < 81) return { ok: false, reason: "account too short" };
  const feedId = d.subarray(8, 40).toString("ascii").replace(/\0+$/, "");
  if (feedId !== expectedFeedId) return { ok: false, reason: "feed id mismatch" };
  const value = BigInt(`0x${d.subarray(40, 72).toString("hex")}`);
  const timestampMs = Number(d.readBigUInt64LE(72));
  const tag = d[80];
  const after = tag === 1 ? 81 + 8 : 81;
  if (d.length < after + 8 + 1) return { ok: false, reason: "account too short" };
  const decimals = d[after + 8]!;
  if (value <= 0n) return { ok: false, reason: "non-positive price" };
  if (decimals > 18) return { ok: false, reason: `unexpected decimals ${decimals}` };
  return { ok: true, price_usd: toUsd8(value, decimals), publishTimeSec: Math.floor(timestampMs / 1000) };
}
