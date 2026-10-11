/**
 * ttl-cache — BFF の in-memory TTL cache (Helius 呼び出し削減の共通部品)
 *
 * 1 本の Helius Free-tier key で多数の Seeker user を捌くため、上流の読み取りを
 * key 単位で共有する。`lib/` は runtime state を持たないので BFF 内に置く。
 *
 * - fresh hit: 保存値を返す
 * - miss: key ごとに in-flight promise を 1 本だけ作り、同時の呼び手はそれに合流する
 * - stale-while-revalidate (SWR) 窓: 旧値を即返し、裏で 1 回だけ再取得する
 *   (失敗は握りつぶし旧値を残す)
 * - loader の失敗は cache を汚さない (次の呼び手が再取得する)
 * - 上限超過は Map の挿入順で古い方から落とす (set 時に再挿入 = helius.ts の evictOldest と同じ)
 * - **timer を持たない** (setInterval / setTimeout 無し)。期限は read 時に `now()` で判定する
 *   — jest の open handle を作らない
 * - delete / clear は進行中の load を切り離す: 切り離された load の結果は呼び手には
 *   返すが cache には書かない (invalidate 直前の古い読みで上書きしない)
 *
 * 金融値の扱いは呼び手の責務 (本 cache は値を不透明に保持するだけ、§4.5)。
 */

export interface TtlCacheOptions {
  /** allCacheStats() / admin usage での表示名。一意にする */
  name: string;
  /** 既定の fresh 期間 (ms) */
  ttlMs: number;
  /** 保持する key 数の上限 (既定 200) */
  maxEntries?: number;
  /** fresh 期限後、旧値を返しつつ裏で更新する猶予 (ms、既定 0 = SWR 無し) */
  staleWhileRevalidateMs?: number;
  /** 時計 (test で差し替え) */
  now?: () => number;
  /** false なら module registry (allCacheStats) に載せない (既定 true) */
  register?: boolean;
}

export interface TtlCacheStats {
  hits: number;
  misses: number;
  staleHits: number;
  inflightJoins: number;
  size: number;
}

export interface GetOrLoadOptions<V> {
  /** 読めた値ごとの TTL (例: 一部失敗時は 5s)。未指定は cache 既定 */
  ttlMs?: (value: V) => number;
}

interface Entry<V> {
  value: V;
  storedAt: number;
  expiresAt: number;
}

interface Inflight<V> {
  promise: Promise<V>;
  /** delete / clear で切り離されたかの判定用 (同一性比較) */
  token: object;
}

export class TtlCache<V> {
  readonly name: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly swrMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Inflight<V>>();
  private readonly background = new Set<Promise<void>>();
  private counters = { hits: 0, misses: 0, staleHits: 0, inflightJoins: 0 };

  constructor(opts: TtlCacheOptions) {
    this.name = opts.name;
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 200;
    this.swrMs = opts.staleWhileRevalidateMs ?? 0;
    this.now = opts.now ?? Date.now;
    if (opts.register !== false) registerCache(this);
  }

  /** fresh な値のみ返す (stats は数えない) */
  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e || this.now() >= e.expiresAt) return undefined;
    return e.value;
  }

  /** 鮮度を問わず保持中の値と経過時間 (stats は数えない) */
  peek(key: string): { value: V; ageMs: number } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    return { value: e.value, ageMs: this.now() - e.storedAt };
  }

  set(key: string, value: V, opts: { ttlMs?: number } = {}): void {
    const at = this.now();
    // 再挿入で挿入順を最新にする (eviction は最古から)
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: at, expiresAt: at + (opts.ttlMs ?? this.ttlMs) });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** entry を消し、進行中の load も切り離す (結果は cache に書かれない) */
  delete(key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  async getOrLoad(key: string, loader: () => Promise<V>, opts: GetOrLoadOptions<V> = {}): Promise<V> {
    const e = this.entries.get(key);
    const at = this.now();
    if (e && at < e.expiresAt) {
      this.counters.hits++;
      return e.value;
    }
    if (e && this.swrMs > 0 && at < e.expiresAt + this.swrMs) {
      this.counters.staleHits++;
      if (!this.inflight.has(key)) {
        const bg = this.startLoad(key, loader, opts).then(
          () => undefined,
          () => undefined // 失敗は握りつぶし、旧値を残す
        );
        this.background.add(bg);
        void bg.finally(() => this.background.delete(bg));
      }
      return e.value;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.counters.inflightJoins++;
      return pending.promise;
    }
    this.counters.misses++;
    return this.startLoad(key, loader, opts);
  }

  stats(): TtlCacheStats {
    return { ...this.counters, size: this.entries.size };
  }

  resetStats(): void {
    this.counters = { hits: 0, misses: 0, staleHits: 0, inflightJoins: 0 };
  }

  /** test 専用: 走っている SWR 再取得を全部待つ */
  async _awaitBackgroundRefreshesForTest(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.all([...this.background]);
    }
  }

  private startLoad(key: string, loader: () => Promise<V>, opts: GetOrLoadOptions<V>): Promise<V> {
    const token = {};
    const promise = (async () => {
      try {
        // loader の同期 throw は rejection に寄せる — そのまま throw させると下の finally が
        // inflight.set より先に走り、reject 済み promise が key の in-flight として残り続ける
        let loading: Promise<V>;
        try {
          loading = loader();
        } catch (err) {
          loading = Promise.reject(err);
        }
        const value = await loading;
        if (this.inflight.get(key)?.token === token) {
          this.set(key, value, opts.ttlMs ? { ttlMs: opts.ttlMs(value) } : {});
        }
        return value;
      } finally {
        if (this.inflight.get(key)?.token === token) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, { promise, token });
    return promise;
  }
}

// ── module registry (GET /admin/helius-usage の caches 欄) ─────────────────────

const registry = new Map<string, TtlCache<unknown>>();

/** 同名は置き換える (module 再読込 / test の作り直しで重複させない) */
export function registerCache(cache: TtlCache<unknown> | TtlCache<never>): void {
  registry.set(cache.name, cache as TtlCache<unknown>);
}

export function allCacheStats(): Record<string, TtlCacheStats> {
  const out: Record<string, TtlCacheStats> = {};
  for (const [name, c] of [...registry.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[name] = c.stats();
  }
  return out;
}

/** test 専用: 登録済み cache の中身と stats を全部消す */
export function _clearAllCachesForTest(): void {
  for (const c of registry.values()) {
    c.clear();
    c.resetStats();
  }
}
