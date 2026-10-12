/**
 * oracle client — §4.6 fail-closed oracle gate (CLAUDE.md §4)。
 *
 * 2026-10 から primary / secondary とも **Solana 上の push feed account** を Helius RPC で読む:
 *   - primary: Pyth sponsored push feed (PriceUpdateV2、shard 0)
 *   - secondary: RedStone push feed (PriceData、tier A) か、push feed が無い asset は RedStone gateway の
 *     署名付き package (tier B、oracle-redstone-gateway.ts)。どちらも無い asset は Pyth のみ (tier C)
 * Pyth Hermes REST は 2026-08-26 に API key 必須 (無料 plan では使えない)、Switchboard は 2026-09-25 に
 * サポート終了したため、どちらも呼ばない。asset ごとの構成 (tier A–D) は `lib/config/oracle-feeds.ts`。
 *
 * staleness 閾値は source ごとに heartbeat + 猶予 (Pyth 75 秒 / RedStone 90 秒、ユーザー決定 2026-10-05)。
 * push feed は価格が乖離幅 (Pyth 0.5% / RedStone 0.1%) を超えれば heartbeat を待たず更新されるので、
 * 「閾値以内の age」は「価格はその乖離幅以内」を意味する。
 *
 * 数値規約 (§4.5):
 *   - price_usd は on-chain の整数を bigint で 8 decimals string にする (oracle-onchain.ts)
 *   - divergence_pct / age_seconds は percentage / 計数なので Number (§4.5 carve-out)
 *
 * fail-closed (§4.6):
 *   - どの source も取得できない → oracle_unavailable
 *   - Pyth stale かつ secondary が無い / stale → oracle_both_stale
 *   - Pyth ↔ secondary 乖離 >5% (両 fresh 時) → oracle_divergence_too_large
 *   - 2-5% → oracle_divergence_warning / Pyth stale → oracle_pyth_stale / secondary stale → oracle_secondary_stale
 *   - tier D (feed なし / 停止中) は gate せず通す (not_configured + reason、silent fail にしない)
 */
import type {
  OracleResult,
  OracleSecondaryStatus,
  OracleSourceId,
  OracleSourceStatus,
  OracleTier,
  OracleWarning,
} from "@workspace/lib/types";
import {
  ORACLE_FEEDS,
  PYTH_PUSH_MAX_AGE_S,
  REDSTONE_GATEWAY_MAX_AGE_S,
  REDSTONE_PUSH_MAX_AGE_S,
  type OracleFeedConfig,
} from "@workspace/lib/config/oracle-feeds";
import { TtlCache } from "../cache/ttl-cache";
import { getMultipleAccountsBase64, type RawAccount } from "./helius-rpc";
import {
  decodePythPriceUpdate,
  decodeRedstonePriceData,
  pythPushAccount,
  redstonePriceAccount,
  type DecodedPrice,
} from "./oracle-onchain";
import { _clearGatewayCacheForTest, aggregateGatewayFeed, fetchGatewaySnapshot } from "./oracle-redstone-gateway";

// server.ts と softfail.test が使う symbol 逆引きは lib が canonical
export { oracleMintForSymbol, pythFeedIdForSymbol } from "@workspace/lib/config/oracle-feeds";

/** §4.6 divergence warning 閾値 (%) */
export const DIVERGENCE_WARN_PCT = 2;
/** §4.6 divergence block 閾値 (%、execute 拒否) */
export const DIVERGENCE_BLOCK_PCT = 5;

/** source ごとの staleness 閾値 (秒) */
export const MAX_AGE_S: Record<OracleSourceId, number> = {
  pyth: PYTH_PUSH_MAX_AGE_S,
  redstone: REDSTONE_PUSH_MAX_AGE_S,
  redstone_gateway: REDSTONE_GATEWAY_MAX_AGE_S,
};

/**
 * 8.78: cache TTL を ok / blocked で分離。blocked を長く cache すると RPC の瞬断が
 * 「最低 TTL 秒の execution block」に増幅されるので、blocked は 3 秒で切って早く再判定に行く。
 */
const CACHE_TTL_OK_MS = 12_000;
const CACHE_TTL_BLOCKED_MS = 3_000;

const UNAVAILABLE: OracleSourceStatus = { available: false, price_usd: null, age_seconds: null };
const NO_SECONDARY: OracleSecondaryStatus = { ...UNAVAILABLE, source: null };

/**
 * 8.78: 直近に decode できた値を account 単位で保持し、RPC が失敗した時だけ
 * **source の staleness 閾値以内なら** age を実時間で再計算して使う。
 * 閾値は evaluateOracle と同じなので fail-closed の緩和ではない (閾値超の last-good は使わない)。
 */
interface LastGood {
  price_usd: string;
  publishTimeSec: number;
}
const lastGood = new Map<string, LastGood>();

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function toStatus(decoded: DecodedPrice, account: string): OracleSourceStatus {
  if (!decoded.ok) return UNAVAILABLE;
  lastGood.set(account, { price_usd: decoded.price_usd, publishTimeSec: decoded.publishTimeSec });
  return { available: true, price_usd: decoded.price_usd, age_seconds: Math.max(0, nowSec() - decoded.publishTimeSec) };
}

function lastGoodStatus(account: string, maxAgeS: number): OracleSourceStatus {
  const good = lastGood.get(account);
  if (!good) return UNAVAILABLE;
  const age = nowSec() - good.publishTimeSec;
  if (age < 0 || age > maxAgeS) return UNAVAILABLE;
  return { available: true, price_usd: good.price_usd, age_seconds: age };
}

/**
 * B2: 複数 mint の push account を 1 回の getMultipleAccounts で読んだ結果。
 * `ok: false` は RPC 自体の失敗 (→ source ごとに last-good)、`ok: true` で key が無い / null は
 * account 不在 (→ decode 失敗で unavailable、last-good は使わない)。fetchSources 単体呼び出しと同じ意味
 */
export type PrefetchedAccounts = { ok: true; accounts: Map<string, RawAccount | null> } | { ok: false };

/** Helius の getMultipleAccounts は 1 request 100 key まで */
const GMA_MAX_KEYS = 100;

/** config が読む push account (Pyth / RedStone push) */
function pushAccountsOf(config: OracleFeedConfig): { pythAcct: string | null; rsAcct: string | null } {
  return {
    pythAcct: config.pythFeedId ? pythPushAccount(config.pythFeedId) : null,
    rsAcct: config.redstoneFeedId ? redstonePriceAccount(config.redstoneFeedId) : null,
  };
}

function pushKeysOf(config: OracleFeedConfig): string[] {
  const { pythAcct, rsAcct } = pushAccountsOf(config);
  return [pythAcct, rsAcct].filter((k): k is string => k !== null);
}

/** push account をまとめて読む (重複 key は 1 回、100 key ごとに分割)。どれか 1 chunk でも失敗したら全体を `ok: false` */
async function readPushAccounts(keys: string[]): Promise<PrefetchedAccounts> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return { ok: true, accounts: new Map() };
  try {
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += GMA_MAX_KEYS) chunks.push(unique.slice(i, i + GMA_MAX_KEYS));
    const results = await Promise.all(chunks.map((c) => getMultipleAccountsBase64(c)));
    const accounts = new Map<string, RawAccount | null>();
    chunks.forEach((c, ci) => c.forEach((k, ki) => accounts.set(k, results[ci]![ki] ?? null)));
    return { ok: true, accounts };
  } catch {
    return { ok: false };
  }
}

/**
 * asset の source を読む。Pyth / RedStone push は 1 回の getMultipleAccounts、tier B の gateway は並列で取得。
 * `prefetched` を渡すと push account は読まずにそれを使う (getOracleResults の batch 用)。
 * RPC / gateway 自体の失敗は source ごとに last-good (閾値以内) → 無ければ unavailable。
 * データはあるが検証を通らない (owner / feed id 不一致、未検証、価格 0、signer quorum 不足) は unavailable
 * (last-good も使わない)
 */
export async function fetchSources(
  config: OracleFeedConfig,
  prefetched?: PrefetchedAccounts
): Promise<{ pyth: OracleSourceStatus; secondary: OracleSecondaryStatus }> {
  const { pythAcct, rsAcct } = pushAccountsOf(config);
  const keys = pushKeysOf(config);
  const pythMaxAge = config.pythMaxAgeS ?? MAX_AGE_S.pyth;

  const [pushed, gateway] = await Promise.all([
    prefetched ?? readPushAccounts(keys),
    config.redstoneGatewayFeedId ? readGateway(config.redstoneGatewayFeedId) : Promise.resolve(null),
  ]);
  const at = (k: string): RawAccount | null => (pushed.ok ? (pushed.accounts.get(k) ?? null) : null);

  const pyth: OracleSourceStatus = !pythAcct
    ? UNAVAILABLE
    : pushed.ok
      ? toStatus(decodePythPriceUpdate(at(pythAcct), config.pythFeedId!), pythAcct)
      : lastGoodStatus(pythAcct, pythMaxAge);
  let secondary: OracleSecondaryStatus = NO_SECONDARY;
  if (rsAcct) {
    secondary = {
      source: "redstone",
      ...(pushed.ok
        ? toStatus(decodeRedstonePriceData(at(rsAcct), config.redstoneFeedId!), rsAcct)
        : lastGoodStatus(rsAcct, MAX_AGE_S.redstone)),
    };
  } else if (config.redstoneGatewayFeedId) {
    secondary = { source: "redstone_gateway", ...(gateway ?? UNAVAILABLE) };
  }
  return { pyth, secondary };
}

/** gateway の 1 feed。取得失敗は last-good (60 秒以内)、検証失敗は unavailable */
async function readGateway(feedId: string): Promise<OracleSourceStatus> {
  const key = `gateway:${feedId}`;
  let snap;
  try {
    snap = await fetchGatewaySnapshot();
  } catch {
    return lastGoodStatus(key, MAX_AGE_S.redstone_gateway);
  }
  const { status } = await aggregateGatewayFeed(snap[feedId], feedId);
  if (status.available && status.price_usd && status.age_seconds !== null) {
    lastGood.set(key, { price_usd: status.price_usd, publishTimeSec: nowSec() - status.age_seconds });
  }
  return status;
}

function isFresh(s: OracleSourceStatus, maxAgeS: number): boolean {
  return s.available && s.age_seconds !== null && s.age_seconds <= maxAgeS;
}

/**
 * §4.6 decision table を実装する pure 関数。fetch 結果から最終判定を生成。
 * これが fail-closed の核 (jest 全分岐対象)。
 */
export function evaluateOracle(input: {
  symbol: string;
  tier: OracleTier;
  pyth: OracleSourceStatus;
  secondary: OracleSecondaryStatus;
  /** feed 別の Pyth 閾値 (sponsored feed の heartbeat が長い asset)。省略時は source 既定 */
  pythMaxAgeS?: number;
  /** feed 別の secondary 閾値。省略時は source 既定 */
  secondaryMaxAgeS?: number;
}): OracleResult {
  const { symbol, tier, pyth, secondary } = input;
  const base = { asset_symbol: symbol, pyth, secondary, tier };
  const blocked = (block_reason: OracleResult["block_reason"], divergence_pct: number | null = null): OracleResult => ({
    ...base,
    status: "blocked",
    primary: null,
    price_usd: null,
    divergence_pct,
    warnings: [],
    block_reason,
  });

  const secondaryMaxAge = input.secondaryMaxAgeS ?? (secondary.source ? MAX_AGE_S[secondary.source] : 0);
  const pythFresh = isFresh(pyth, input.pythMaxAgeS ?? MAX_AGE_S.pyth);
  const secFresh = secondary.source !== null && isFresh(secondary, secondaryMaxAge);

  if (!pyth.available && !(secondary.source && secondary.available)) return blocked("oracle_unavailable");

  const warnings: OracleWarning[] = [];
  let primary: OracleSourceId;
  let price_usd: string | null;
  if (pythFresh) {
    primary = "pyth";
    price_usd = pyth.price_usd;
    // secondary はあるが stale: 乖離は評価できないので、その旨を強警告で見せる
    if (secondary.source && secondary.available && !secFresh) {
      warnings.push({ kind: "oracle_secondary_stale", secondaryAgeSeconds: secondary.age_seconds ?? undefined });
    }
  } else if (secFresh) {
    // Pyth stale / 未取得 だが secondary fresh → fallback + warning
    primary = secondary.source!;
    price_usd = secondary.price_usd;
    warnings.push({ kind: "oracle_pyth_stale", pythAgeSeconds: pyth.age_seconds ?? undefined });
  } else {
    // Pyth stale かつ secondary が無い / stale → fail-closed
    return blocked("oracle_both_stale");
  }

  // divergence は両 fresh の時のみ評価 (stale price 比較は無意味)
  let divergence_pct: number | null = null;
  if (pythFresh && secFresh && pyth.price_usd && secondary.price_usd) {
    const a = Number(pyth.price_usd);
    const b = Number(secondary.price_usd);
    if (a > 0 && b > 0) {
      divergence_pct = (Math.abs(a - b) / ((a + b) / 2)) * 100;
      if (divergence_pct > DIVERGENCE_BLOCK_PCT) return blocked("oracle_divergence_too_large", divergence_pct);
      if (divergence_pct >= DIVERGENCE_WARN_PCT) warnings.push({ kind: "oracle_divergence_warning", divergencePct: divergence_pct });
    }
  }

  return {
    ...base,
    status: warnings.length > 0 ? "warning" : "ok",
    primary,
    price_usd,
    divergence_pct,
    warnings,
    block_reason: null,
  };
}

/**
 * B2: 判定結果の cache。TTL は従来どおり ok/warning 12 秒 / blocked 3 秒、**SWR 無し**
 * (期限切れの判定は返さない = fail-closed)。getOrLoad で同じ mint の同時 cold request は 1 回の読みに合流する。
 * `now` は呼び出し時に Date.now を引く (test の fake timer を効かせる)
 */
const resultCache = new TtlCache<OracleResult>({
  name: "oracle.results",
  ttlMs: CACHE_TTL_OK_MS,
  maxEntries: 500,
  staleWhileRevalidateMs: 0,
  now: () => Date.now(),
});
const ttlFor = (r: OracleResult): number => (r.status === "blocked" ? CACHE_TTL_BLOCKED_MS : CACHE_TTL_OK_MS);

export function _clearOracleCacheForTest(): void {
  resultCache.clear();
  resultCache.resetStats();
  // 8.78: last-good もテスト間で持ち越さない
  lastGood.clear();
  _clearGatewayCacheForTest();
}

function notConfigured(config: OracleFeedConfig | undefined): OracleResult {
  return {
    asset_symbol: config?.symbol ?? "UNKNOWN",
    status: "ok",
    primary: null,
    price_usd: null,
    pyth: UNAVAILABLE,
    secondary: NO_SECONDARY,
    tier: "D",
    divergence_pct: null,
    warnings: [],
    block_reason: null,
    not_configured: true,
    reason: config?.reason ?? "Not in the oracle registry.",
  };
}

async function evaluateMint(config: OracleFeedConfig, prefetched?: PrefetchedAccounts): Promise<OracleResult> {
  const { pyth, secondary } = await fetchSources(config, prefetched);
  return evaluateOracle({ symbol: config.symbol, tier: config.tier, pyth, secondary, pythMaxAgeS: config.pythMaxAgeS });
}

/**
 * 複数の underlying mint の oracle 判定をまとめて返す (B2)。
 * - tier D / registry 外は RPC 無しで not_configured (理由付き)
 * - fresh な cache はそのまま、同じ mint の読みが進行中ならそれに合流
 * - 残りの mint の Pyth + RedStone push account は **1 回の getMultipleAccounts** でまとめて読み、
 *   mint ごとに decode・評価・cache する (1 account が decode 不能でもその mint の source だけが unavailable)
 * - tier B の gateway snapshot は oracle-redstone-gateway.ts 側で共有 (10 秒 cache + in-flight dedupe)
 * 判定 (fail-closed の決定表 / TTL / last-good) は getOracleResult 単体と同じ。
 * 1 mint の評価が throw した場合はその mint の promise だけが reject し、本関数は reject する
 * (従来の getOracleResult と同じく呼び手が catch する)
 */
export async function getOracleResults(mints: string[]): Promise<Map<string, OracleResult>> {
  const unique = [...new Set(mints)];
  const pending = new Map<string, Promise<OracleResult>>();
  const batchMints: Array<[string, OracleFeedConfig]> = [];
  let batch: Promise<PrefetchedAccounts> | null = null;
  // 全 mint の loader 登録が済んでから 1 回だけ読む (getOrLoad は miss 時に loader を同期で呼ぶ)
  const readBatch = (): Promise<PrefetchedAccounts> =>
    (batch ??= Promise.resolve().then(() =>
      readPushAccounts(
        batchMints.flatMap(([, c]) => pushKeysOf(c))
      )
    ));

  for (const mint of unique) {
    const config = ORACLE_FEEDS[mint];
    if (!config || config.tier === "D") {
      pending.set(mint, Promise.resolve(notConfigured(config)));
      continue;
    }
    pending.set(
      mint,
      resultCache.getOrLoad(
        mint,
        () => {
          batchMints.push([mint, config]);
          return readBatch().then((pre) =>
            // 保険: batch 開始後に登録された mint (現実装では起きない) は自前で読む
            pre.ok && !pushKeysOf(config).every((k) => pre.accounts.has(k)) ? evaluateMint(config) : evaluateMint(config, pre)
          );
        },
        { ttlMs: ttlFor }
      )
    );
  }

  const out = new Map<string, OracleResult>();
  const settled = await Promise.all([...pending].map(async ([mint, p]) => [mint, await p] as const));
  for (const [mint, r] of settled) out.set(mint, r);
  return out;
}

/**
 * underlying mint の oracle 判定を返す。tier D / registry 外の asset は not_configured で通す
 * (oracle gate 対象外、理由付き)。tier A / B / C は on-chain の source を読んで評価する。
 * = getOracleResults([mint]).get(mint)
 */
export async function getOracleResult(mint: string): Promise<OracleResult> {
  const r = (await getOracleResults([mint])).get(mint);
  if (!r) throw new Error("oracle: result missing");
  return r;
}
