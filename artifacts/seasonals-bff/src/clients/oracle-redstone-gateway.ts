/**
 * oracle-redstone-gateway — tier B の secondary (RedStone の off-chain 署名付き data package)。
 *
 * 公開 gateway (key 不要) は全 feed (~2MB) をまとめて返し、feed で絞れない。全 asset で 1 回の取得を
 * 共有し 10 秒 cache する。gateway の `signerAddress` / `isSignatureValid` は自己申告なので使わず、
 * 署名を自前で recover して正規 signer (lib `REDSTONE_PRIMARY_SIGNERS`) だけを数える。
 *
 * 署名対象 (公式 `@redstone-finance/protocol@1.0.0` の DataPackage.toBytes / getSignableHash と同じ):
 *   [data point ごとに feed id bytes32 (ASCII 右 0 詰め、31 文字超は keccak) ‖ value 32B BE (8 decimals の整数)]
 *   (feed id bytes32 の hex 昇順) ‖ timestampMilliseconds 6B ‖ value byte size (32) 4B ‖ data point 数 3B
 *   hash = keccak256、署名 = secp256k1 65B (r‖s‖v)、prefix なし
 * 2026-10-05 に実 package 30 件で recover が正規 signer に一致することを確認 (新規依存なし、viem のみ)。
 */
import { concat, keccak256, numberToHex, pad, parseUnits, recoverAddress, stringToHex, toHex, type Hex } from "viem";
import type { OracleSourceStatus } from "@workspace/lib/types";
import {
  REDSTONE_DATA_SERVICE_ID,
  REDSTONE_GATEWAY_MAX_AGE_S,
  REDSTONE_GATEWAY_MIN_SIGNERS,
  REDSTONE_GATEWAY_URLS,
  REDSTONE_PRIMARY_SIGNERS,
} from "@workspace/lib/config/oracle-feeds";
import { fetchWithTimeout } from "./http";
import { toUsd8 } from "./oracle-onchain";

export interface GatewayDataPoint {
  dataFeedId: string;
  value: number | string;
}
export interface GatewayPackage {
  timestampMilliseconds: number;
  /** base64 の 65 byte 署名 */
  signature: string;
  dataPoints: GatewayDataPoint[];
  dataServiceId?: string;
  dataPackageId?: string;
  /** gateway の自己申告。検証には使わない */
  signerAddress?: string;
}
export type GatewaySnapshot = Record<string, GatewayPackage[]>;

const VALUE_DECIMALS = 8;
const VALUE_BYTE_SIZE = 32;
const ALLOWED = new Set(REDSTONE_PRIMARY_SIGNERS.map((a) => a.toLowerCase()));
const UNAVAILABLE: OracleSourceStatus = { available: false, price_usd: null, age_seconds: null };

function feedIdBytes32(id: string): Hex {
  return id.length > 31 ? keccak256(stringToHex(id)) : stringToHex(id, { size: 32 });
}

/** value → 8 decimals の整数 (公式 convertNumberToString → parseUnits と同じ)。不正なら null */
export function packageValueToInt(value: number | string): bigint | null {
  const fixed = typeof value === "string" ? value : Number(value).toFixed(VALUE_DECIMALS);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(fixed)) return null;
  const [int, frac = ""] = fixed.split(".");
  // 文字列入力で 8 桁を超える小数は丸め規則が SDK (decimal.js) 依存になるので受けない
  if (frac.length > VALUE_DECIMALS) return null;
  return parseUnits(`${int}.${frac || "0"}`, VALUE_DECIMALS);
}

/** 署名対象の byte 列 */
export function serializePackageForSigning(pkg: GatewayPackage): Hex | null {
  const points: Array<{ id: Hex; value: bigint }> = [];
  for (const dp of pkg.dataPoints) {
    const value = packageValueToInt(dp.value);
    if (value === null) return null;
    points.push({ id: feedIdBytes32(dp.dataFeedId), value });
  }
  points.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return concat([
    ...points.flatMap((p) => [p.id, pad(numberToHex(p.value), { size: VALUE_BYTE_SIZE })]),
    pad(numberToHex(pkg.timestampMilliseconds), { size: 6 }),
    pad(numberToHex(VALUE_BYTE_SIZE), { size: 4 }),
    pad(numberToHex(points.length), { size: 3 }),
  ]);
}

/** 署名から signer を recover (小文字 address)。壊れた署名 / 値は null */
export async function recoverPackageSigner(pkg: GatewayPackage): Promise<string | null> {
  const bytes = serializePackageForSigning(pkg);
  if (!bytes) return null;
  const sig = Buffer.from(pkg.signature ?? "", "base64");
  if (sig.length !== 65) return null;
  try {
    return (await recoverAddress({ hash: keccak256(bytes), signature: toHex(sig) })).toLowerCase();
  } catch {
    return null;
  }
}

export interface GatewayAggregate {
  status: OracleSourceStatus;
  /** 検証を通った異なる正規 signer の数 */
  validSigners: number;
  reason?: string;
}

/**
 * 1 feed の package 群 → 検証済みの価格。
 * - 1 package = 1 data point で、dataServiceId / dataPackageId / dataFeedId が一致し、値 > 0、正規 signer のものだけ
 * - 同じ signer は最新 1 件
 * - 鮮度内 (≤ 閾値) の package で quorum がそろえばそれを使う。そろわなければ全 package で数え直し、
 *   age は使った package の **最も古い** timestamp から (鮮度を甘く見ない)
 * - 価格は中央値。偶数件は中央 2 つの **低い方** (金額を盛らない側)
 */
export async function aggregateGatewayFeed(
  packages: GatewayPackage[] | undefined,
  feedId: string,
  nowMs: number = Date.now()
): Promise<GatewayAggregate> {
  if (!packages || packages.length === 0) return { status: UNAVAILABLE, validSigners: 0, reason: "no packages" };
  const bySigner = new Map<string, { value: bigint; ts: number }>();
  for (const pkg of packages) {
    if (pkg.dataServiceId !== REDSTONE_DATA_SERVICE_ID || pkg.dataPackageId !== feedId) continue;
    if (pkg.dataPoints?.length !== 1 || pkg.dataPoints[0]!.dataFeedId !== feedId) continue;
    if (!Number.isInteger(pkg.timestampMilliseconds) || pkg.timestampMilliseconds <= 0) continue;
    const value = packageValueToInt(pkg.dataPoints[0]!.value);
    if (value === null || value <= 0n) continue;
    const signer = await recoverPackageSigner(pkg);
    if (!signer || !ALLOWED.has(signer)) continue;
    const prev = bySigner.get(signer);
    if (!prev || prev.ts < pkg.timestampMilliseconds) bySigner.set(signer, { value, ts: pkg.timestampMilliseconds });
  }
  const valid = [...bySigner.values()];
  if (valid.length < REDSTONE_GATEWAY_MIN_SIGNERS) {
    return { status: UNAVAILABLE, validSigners: valid.length, reason: `quorum not met (${valid.length}/${REDSTONE_GATEWAY_MIN_SIGNERS})` };
  }
  const fresh = valid.filter((v) => nowMs - v.ts <= REDSTONE_GATEWAY_MAX_AGE_S * 1000);
  const used = fresh.length >= REDSTONE_GATEWAY_MIN_SIGNERS ? fresh : valid;
  const values = used.map((v) => v.value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = values[Math.floor((values.length - 1) / 2)]!;
  const oldestTs = Math.min(...used.map((v) => v.ts));
  return {
    status: { available: true, price_usd: toUsd8(median, VALUE_DECIMALS), age_seconds: Math.max(0, Math.floor((nowMs - oldestTs) / 1000)) },
    validSigners: valid.length,
  };
}

// ── snapshot (全 feed、~2MB) を全 asset で共有 ──

const SNAPSHOT_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 8_000;
let snapshot: { at: number; data: GatewaySnapshot } | null = null;
let inflight: Promise<GatewaySnapshot> | null = null;

async function fetchFrom(base: string): Promise<GatewaySnapshot> {
  const res = await fetchWithTimeout(
    `${base}/data-packages/latest/${REDSTONE_DATA_SERVICE_ID}`,
    { method: "GET", headers: { accept: "application/json" } },
    FETCH_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`RedStone gateway HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("RedStone gateway: unexpected response shape");
  return json as GatewaySnapshot;
}

/** gateway を順に試し、最初に取れた snapshot を返す (10 秒 cache、同時呼び出しは 1 回の取得を共有)。全滅は throw */
export async function fetchGatewaySnapshot(): Promise<GatewaySnapshot> {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.data;
  if (inflight) return inflight;
  inflight = (async () => {
    let lastErr: unknown = null;
    for (const base of REDSTONE_GATEWAY_URLS) {
      try {
        const data = await fetchFrom(base);
        snapshot = { at: Date.now(), data };
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("RedStone gateway unavailable");
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function _clearGatewayCacheForTest(): void {
  snapshot = null;
  inflight = null;
}
