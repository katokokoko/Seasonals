/**
 * wallet-snapshot — 1 wallet の「表示用」on-chain 読み取りを TTL 内で 1 回に束ねる (Phase B3)
 *
 * Seeker は `/positions` / `/positions/earn` / `/time-events/wallet` を並列に叩く。以前は各 handler が
 * DAS / Enhanced tx / Meteora / Orca / Kamino / Jupiter Lend / stake を独立に読んでいた
 * (cold で DAS ×4、Enhanced ×3、Meteora GPA ×6)。ここで 8 source を **wallet ごとに 1 回**読み、
 * 3 route (+ /portfolio/history の現在残高) が同じ結果を共有する。
 *
 * 設計 (plan §4.0 / Phase B3):
 * - source ごとの promise (`Settled<T>`) を持つ。`/positions` は `assets` だけ待てば返せる
 *   (Meteora / Orca の GPA は同じ entry の中で読み続ける)。source の失敗は `Settled` の中に閉じ、
 *   snapshot 自体は throw しない (route ごとの degrade 規則は呼び手がそのまま適用する)
 * - 未 settle の snapshot は pending Map で共有 (in-flight dedupe)。全 source が settle したら
 *   cache に入れる: 全成功 60s / 1 つでも rejected 5s (429 の瞬断で空データを 1 分固定しない)
 * - SWR 60s: 期限切れ後 60s 以内は旧 snapshot を返し、裏で 1 回だけ読み直す (settle 後に差し替え)。
 *   短命 (5s) entry は SWR を使わず hard に期限切れにする (失敗を含む snapshot を延命しない)
 * - `invalidateWalletSnapshot` (tx 送信後): entry を消し、進行中の読みも切り離し、20 秒間は
 *   新 entry の TTL を 5s にし SWR も使わない (chain 反映が送信の 1-2 秒後のため)。timer は持たない
 * - **cache は権限ではない / 実行系は使わない**: tx builder (`/protocols/*-tx`、withdraw の
 *   position 読み、`/agent-plans/:id/execute`) は本 module を通さず常に fresh に読む
 *
 * 金融値は各 client の型のまま不透明に保持する (§4.5、本 module は変換しない)。
 * 失敗理由は `redactKey` を通した message 文字列のみ保持する (API key を log に出さない)。
 */

import { KAMINO_MAIN_MARKET } from "@workspace/lib/config/kamino-markets";

import { TtlCache, type TtlCacheStats } from "./cache/ttl-cache";
import { fetchAssetsByOwner, invalidateAssetsCacheForWallet } from "./clients/helius";
import {
  fetchWalletTxs,
  invalidateWalletTxCacheForWallet,
} from "./clients/tx-history";
import { fetchStakeAccounts } from "./clients/helius-rpc";
import { redactKey } from "./clients/helius-limiter";
import {
  fetchEarnPositions,
  invalidateEarnPositionsCacheForWallet,
} from "./clients/jupiter-lend";
import {
  fetchKaminoObligations,
  fetchKaminoVaultUserPositions,
} from "./clients/kamino-tx";
import { fetchMeteoraPositions } from "./clients/meteora-tx";
import { fetchOrcaPositions } from "./clients/orca-tx";

export type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: string };

type ValueOf<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export interface WalletSnapshot {
  wallet: string;
  /** 読み取りを始めた時刻 (ms)。`X-Seasonals-Data-Age-Ms` の基準 */
  createdAt: number;
  /** Helius DAS getAssetsByOwner */
  assets: Promise<Settled<ValueOf<typeof fetchAssetsByOwner>>>;
  /** wallet tx 履歴 (直近 50 件 = fetchWalletTxs の既定。Enhanced / Parsed Events は flag で選ぶ) */
  txs: Promise<Settled<ValueOf<typeof fetchWalletTxs>>>;
  meteora: Promise<Settled<ValueOf<typeof fetchMeteoraPositions>>>;
  orca: Promise<Settled<ValueOf<typeof fetchOrcaPositions>>>;
  /** Kamino main market の obligation */
  kaminoObligations: Promise<Settled<ValueOf<typeof fetchKaminoObligations>>>;
  kvaultPositions: Promise<Settled<ValueOf<typeof fetchKaminoVaultUserPositions>>>;
  jupiterLend: Promise<Settled<ValueOf<typeof fetchEarnPositions>>>;
  /** native stake account (withdrawer = wallet) */
  stake: Promise<Settled<ValueOf<typeof fetchStakeAccounts>>>;
  /** 8 source が全部 settle したら resolve (reject しない) */
  settled: Promise<void>;
}

export const SNAPSHOT_TTL_MS = 60_000;
export const SNAPSHOT_SWR_MS = 60_000;
/** 1 source でも rejected / invalidate 直後の entry の TTL */
export const SNAPSHOT_SHORT_TTL_MS = 5_000;
/** invalidate 後、新 entry を短命にする期間 */
export const SNAPSHOT_BUST_WINDOW_MS = 20_000;
const SNAPSHOT_MAX_ENTRIES = 100;
/** bust window の記録がこれを超えたら期限切れを掃除する (timer 無しの上限) */
const BUST_MAP_SOFT_LIMIT = 1_000;

let clock: () => number = () => Date.now();

/** test 専用: 時計の差し替え (null で Date.now に戻す) */
export function _setWalletSnapshotClockForTest(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactKey(msg);
}

/**
 * client を呼び、結果を Settled に包む。同期 throw / 非 Promise の戻り値 (jest automock の
 * undefined) も吸収する (snapshot 自体は決して reject しない)
 */
function settle<T>(fn: () => T | Promise<T>): Promise<Settled<T>> {
  let started: Promise<T>;
  try {
    started = Promise.resolve(fn()); // 同期に呼び始める (8 source を同じ tick で並走させる)
  } catch (err) {
    started = Promise.reject(err);
  }
  return started.then(
      (value): Settled<T> => ({ status: "fulfilled", value }),
      (err): Settled<T> => ({ status: "rejected", reason: reasonOf(err) })
    );
}

function buildSnapshot(wallet: string, createdAt: number): WalletSnapshot {
  const assets = settle(() => fetchAssetsByOwner(wallet));
  const txs = settle(() => fetchWalletTxs(wallet));
  const meteora = settle(() => fetchMeteoraPositions(wallet));
  const orca = settle(() => fetchOrcaPositions(wallet));
  const kaminoObligations = settle(() => fetchKaminoObligations(KAMINO_MAIN_MARKET, wallet));
  const kvaultPositions = settle(() => fetchKaminoVaultUserPositions(wallet));
  const jupiterLend = settle(() => fetchEarnPositions(wallet));
  const stake = settle(() => fetchStakeAccounts(wallet));
  const settled = Promise.all([
    assets,
    txs,
    meteora,
    orca,
    kaminoObligations,
    kvaultPositions,
    jupiterLend,
    stake,
  ]).then(() => undefined);
  return {
    wallet,
    createdAt,
    assets,
    txs,
    meteora,
    orca,
    kaminoObligations,
    kvaultPositions,
    jupiterLend,
    stake,
    settled,
  };
}

async function anyRejected(s: WalletSnapshot): Promise<boolean> {
  const all = await Promise.all([
    s.assets,
    s.txs,
    s.meteora,
    s.orca,
    s.kaminoObligations,
    s.kvaultPositions,
    s.jupiterLend,
    s.stake,
  ]);
  return all.some((r) => r.status === "rejected");
}

/**
 * TtlCache を storage / registry (admin usage の caches 欄) として使い、未 settle の snapshot は
 * pending Map で共有する。TtlCache.getOrLoad は「値が揃うまで待つ」形なので、source 単位で
 * 先に返したい本用途では load の流れだけ自前で持つ (stats も自前で数える)
 */
class WalletSnapshotCache extends TtlCache<WalletSnapshot> {
  private readonly pending = new Map<string, WalletSnapshot>();
  private readonly bustUntil = new Map<string, number>();
  /** settle 後に set した TTL (SWR 窓 = storedAt + ttl + SWR の判定用) */
  private readonly ttlOf = new WeakMap<WalletSnapshot, number>();
  private counts = { hits: 0, misses: 0, staleHits: 0, inflightJoins: 0 };

  constructor() {
    super({
      name: "wallet.snapshot",
      ttlMs: SNAPSHOT_TTL_MS,
      maxEntries: SNAPSHOT_MAX_ENTRIES,
      staleWhileRevalidateMs: SNAPSHOT_SWR_MS,
      now: () => clock(),
    });
  }

  load(wallet: string, forceRefresh: boolean): WalletSnapshot {
    if (!forceRefresh) {
      const fresh = this.get(wallet);
      if (fresh) {
        this.counts.hits++;
        return fresh;
      }
    }
    const inflight = this.pending.get(wallet);
    if (!forceRefresh) {
      const held = this.peek(wallet);
      const ttl = held ? (this.ttlOf.get(held.value) ?? SNAPSHOT_TTL_MS) : 0;
      // 短命 entry (source が rejected / bust window 中に作った) は SWR で延命しない — 5s で
      // hard に切らないと、失敗を含む snapshot が裏の読み直しが settle するまで返り続ける
      const swrEligible = ttl >= SNAPSHOT_TTL_MS;
      if (held && swrEligible && held.ageMs < ttl + SNAPSHOT_SWR_MS && !this.inBustWindow(wallet)) {
        // SWR: 旧値を返し、裏の読み直しは 1 本だけ
        this.counts.staleHits++;
        if (!inflight) this.start(wallet);
        return held.value;
      }
    }
    if (inflight) {
      this.counts.inflightJoins++;
      return inflight;
    }
    this.counts.misses++;
    return this.start(wallet);
  }

  invalidate(wallet: string): void {
    super.delete(wallet);
    this.pending.delete(wallet); // 進行中の読みは呼び手には返るが cache には書かない
    const at = clock();
    if (this.bustUntil.size >= BUST_MAP_SOFT_LIMIT) {
      for (const [w, until] of this.bustUntil) if (until <= at) this.bustUntil.delete(w);
    }
    this.bustUntil.set(wallet, at + SNAPSHOT_BUST_WINDOW_MS);
  }

  override delete(key: string): void {
    super.delete(key);
    this.pending.delete(key);
  }

  override clear(): void {
    super.clear();
    this.pending.clear();
    this.bustUntil.clear();
  }

  override stats(): TtlCacheStats {
    return { ...this.counts, size: super.stats().size };
  }

  override resetStats(): void {
    super.resetStats();
    this.counts = { hits: 0, misses: 0, staleHits: 0, inflightJoins: 0 };
  }

  /** test 専用: 保持中 entry の TTL (set 時に決めた値) */
  _ttlForTest(wallet: string): number | undefined {
    const held = this.peek(wallet);
    return held ? this.ttlOf.get(held.value) : undefined;
  }

  private inBustWindow(wallet: string): boolean {
    const until = this.bustUntil.get(wallet);
    if (until === undefined) return false;
    if (clock() < until) return true;
    this.bustUntil.delete(wallet); // 期限切れは読んだ時に掃除 (timer 無し)
    return false;
  }

  private start(wallet: string): WalletSnapshot {
    const createdAt = clock();
    const shortLived = this.inBustWindow(wallet);
    const snap = buildSnapshot(wallet, createdAt);
    this.pending.set(wallet, snap);
    void snap.settled
      .then(() => anyRejected(snap))
      .then((partial) => {
        // invalidate / clear / 後発の forceRefresh で切り離されていたら cache に書かない
        if (this.pending.get(wallet) !== snap) return;
        this.pending.delete(wallet);
        const ttlMs = partial || shortLived ? SNAPSHOT_SHORT_TTL_MS : SNAPSHOT_TTL_MS;
        this.ttlOf.set(snap, ttlMs);
        this.set(wallet, snap, { ttlMs });
      });
    return snap;
  }
}

const cache = new WalletSnapshotCache();

/**
 * wallet の表示用 snapshot を返す (同期。各 source は promise)。
 * - fresh な entry があればそれ、SWR 窓なら旧 entry (裏で 1 回読み直す)、読み途中ならそれに合流
 * - `forceRefresh`: cache を読まずに新しく読む (進行中の読みがあればそれに合流し、結果は cache に入る)
 */
export function loadWalletSnapshot(
  wallet: string,
  opts: { forceRefresh?: boolean } = {}
): WalletSnapshot {
  return cache.load(wallet, Boolean(opts.forceRefresh));
}

/** tx 送信後に呼ぶ: entry を消し、20 秒間は新 entry を短命 (5s) にする */
export function invalidateWalletSnapshot(wallet: string): void {
  cache.invalidate(wallet);
  // snapshot を捨てても source 側の per-wallet cache (DAS 30s / Enhanced 60s / Jupiter Lend 30s) が
  // 残ると、直後の再読みが tx 前の保有を返す。表示用 cache は wallet 単位でまとめて捨てる
  // (§4.0: tx 後の必要な更新)。wallet 非依存の共有 cache は触らない
  invalidateAssetsCacheForWallet(wallet);
  invalidateWalletTxCacheForWallet(wallet);
  invalidateEarnPositionsCacheForWallet(wallet);
}

/** `X-Seasonals-Data-Age-Ms` 用: snapshot の経過時間 (ms、負にしない) */
export function snapshotAgeMs(s: WalletSnapshot): number {
  return Math.max(0, clock() - s.createdAt);
}

/** test 専用: entry / 進行中の読み / bust window / stats を全部消す */
export function _clearWalletSnapshotForTest(): void {
  cache.clear();
  cache.resetStats();
}

/** test 専用: 保持中 entry の TTL と経過時間 */
export function _peekWalletSnapshotForTest(
  wallet: string
): { ttlMs: number | undefined; ageMs: number; snapshot: WalletSnapshot } | undefined {
  const held = cache.peek(wallet);
  if (!held) return undefined;
  return { ttlMs: cache._ttlForTest(wallet), ageMs: held.ageMs, snapshot: held.value };
}

/** test 専用: cache の stats (admin usage の caches["wallet.snapshot"] と同じ値) */
export function _walletSnapshotStatsForTest(): TtlCacheStats {
  return cache.stats();
}
