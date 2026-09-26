/**
 * portfolio/engine — 評価額履歴の chain 非依存エンジン
 *
 * Solana 8.58〜8.95 で server.ts に直書きしていた「入力取得 → 時刻列 → 残高の
 * 逆算 → 過去価格 → 系列」の流れと cache / SWR を、chain ごとの差し替え口
 * (`ChainHistorySource`) を持つ形に切り出したもの。chain 固有なのは
 *   1. 現在残高と tx 差分の取り方 (Solana: Helius / Ethereum: RPC + Etherscan)
 *   2. 過去価格の出所 (Solana: Pyth Benchmarks + DeFiLlama / Ethereum: DeFiLlama)
 * の 2 点だけで、残りの逆算・値付け・flow 分解は portfolio-history.ts の純関数を
 * 共有する。新チェーンの追加手順は docs/portfolio-history-design.md。
 *
 * holdings (Allocation donut 用の現在値) も **同じ入力 cache** から作るので、
 * グラフの右端とパイの合計は同じ残高・同じ現在価格から出る。
 */

import type { ChainId } from "@workspace/lib/config/chains";
import type {
  PortfolioHistoryResponse,
  PortfolioHolding,
  PortfolioHoldingsResponse,
} from "@workspace/lib/types";
import { PositionCategory } from "@workspace/lib/types";
import { bigIntToUsd8, usd8ToBigInt } from "@workspace/lib/utils/numeric";

import { priceAtOrBefore, type PriceSeries } from "../clients/pyth-history";
import {
  buildHistorySeries,
  firstFundedTime,
  replayBalances,
  sampleTimestamps,
  type BalanceDelta,
  type HistoryAsset,
} from "../portfolio-history";

/** 現在値のみの保有 (履歴に入れられないもの。例: Aave V4 の supply) */
export type ExtraHolding = Omit<PortfolioHolding, "chain" | "address">;

export interface HistoryInputs {
  /** asset key → 現在残高 (smallest unit) */
  current: Map<string, bigint>;
  assets: HistoryAsset[];
  deltas: BalanceDelta[];
  /** 取得できた最古の tx 時刻 (unix 秒) */
  oldestSeen: number;
  /** この差分が何日前まで遡れているか (これより長い range は再取得が要る) */
  fetchedDays: number;
  /**
   * 差分を **要求 window の先頭 (または wallet の最初の tx) まで** 取り切れたか。
   * page 上限で打ち切った場合は false (それより前の残高は不明)
   */
  complete: boolean;
  /** holdings にだけ載せる現在値 (履歴には入らない) */
  extraHoldings?: ExtraHolding[];
  /** 現在保有しているが履歴に含められないものの表示名 */
  excludedFromHistory?: string[];
}

export interface ChainHistorySource {
  chain: ChainId;
  /** native 建て換算に使う asset key (Solana = WSOL mint、Ethereum = "ETH") */
  nativePriceKey: string | undefined;
  /** 現在残高 + tx 差分。保有ゼロなら null */
  loadInputs(
    address: string,
    days: number,
    nowSeconds: number
  ): Promise<HistoryInputs | null>;
  /** asset key → 過去価格系列。取れない asset は Map に入れない (近似に落ちる) */
  priceSeries(
    assets: HistoryAsset[],
    fromSec: number,
    toSec: number,
    stepSec: number
  ): Promise<Map<string, PriceSeries>>;
}

export interface HistoryEngineOptions {
  /** 応答 / 入力 cache の TTL (8.58: 5 分) */
  cacheTtlMs?: number;
  now?: () => number;
}

export interface HistoryEngine {
  chain: ChainId;
  history(
    address: string,
    days: number,
    nowSeconds?: number
  ): Promise<PortfolioHistoryResponse>;
  holdings(address: string): Promise<PortfolioHoldingsResponse>;
  clear(): void;
}

const EMPTY_META = { oldest_at: null, approximated_symbols: [] as string[] };

export function createHistoryEngine(
  source: ChainHistorySource,
  opts: HistoryEngineOptions = {}
): HistoryEngine {
  const ttl = opts.cacheTtlMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const historyCache = new Map<
    string,
    { at: number; data: PortfolioHistoryResponse }
  >();
  const inputsCache = new Map<
    string,
    { at: number; data: HistoryInputs | null; days: number }
  >();
  /** history と holdings が同時に来ても上流を 1 回しか叩かない */
  const inflight = new Map<
    string,
    { days: number; promise: Promise<HistoryInputs | null> }
  >();
  /** 8.83: SWR の背景再計算が同一 key で多重に走らないためのガード */
  const refreshing = new Set<string>();

  /**
   * 8.60: 「現在残高 + tx 差分」は range をまたいで同じなので address 単位で
   * cache する。要求 range より短い期間しか遡っていない cache は取り直す。
   */
  async function loadInputs(
    address: string,
    days: number,
    nowSeconds: number
  ): Promise<HistoryInputs | null> {
    const cached = inputsCache.get(address);
    if (cached && now() - cached.at < ttl && cached.days >= days) {
      return cached.data;
    }
    const running = inflight.get(address);
    if (running && running.days >= days) return running.promise;
    const promise = source
      .loadInputs(address, days, nowSeconds)
      .then((data) => {
        // 並走した長い range の結果を、後から終わった短い range で潰さない
        const existing = inputsCache.get(address);
        if (!existing || now() - existing.at >= ttl || existing.days <= days) {
          inputsCache.set(address, { at: now(), data, days });
        }
        return data;
      })
      .finally(() => {
        if (inflight.get(address)?.promise === promise) inflight.delete(address);
      });
    inflight.set(address, { days, promise });
    return promise;
  }

  async function compute(
    address: string,
    days: number,
    nowSeconds: number
  ): Promise<PortfolioHistoryResponse> {
    const empty: PortfolioHistoryResponse = {
      chain: source.chain,
      points: [],
      ...EMPTY_META,
    };
    const inputs = await loadInputs(address, days, nowSeconds);
    if (!inputs) return empty;
    const cutoff = nowSeconds - days * 86_400;
    const { current, assets, deltas, oldestSeen } = inputs;
    const meta = inputs.excludedFromHistory?.length
      ? { excluded_from_history: inputs.excludedFromHistory }
      : {};

    // 8.59: 刻みは **実際に描ける期間** から決める (履歴が range より短い wallet で
    // 密度が落ちないように)。最初に資産を持った時刻より前は差分から何も言えない
    // ので下限にする。途中のゼロ期間は 0 の点として描かれる (8.60)
    const fundedFrom = firstFundedTime(current, deltas, cutoff);
    const oldestProvable = Math.max(oldestSeen, cutoff, fundedFrom ?? 0);
    const provableDays = Math.max(1, (nowSeconds - oldestProvable) / 86_400);
    const stamps = sampleTimestamps(
      Math.min(days, provableDays),
      nowSeconds
    ).filter((at) => at >= oldestProvable);
    if (stamps.length === 0) return { ...empty, ...meta };
    const balancesByTime = replayBalances(current, deltas, stamps);

    // 8.59: asset ごとに範囲全体の系列を 1 回で取り、各点は「その時刻以前の直近」。
    // 先頭の点にも「その時刻以前の bar」が要るので刻み 2 個分手前から
    const step = stamps.length > 1 ? stamps[1]! - stamps[0]! : 86_400;
    const seriesByKey = await source.priceSeries(
      assets,
      stamps[0]! - 2 * step,
      stamps[stamps.length - 1]!,
      step
    );
    const pricesByTime = new Map<number, Map<string, string>>();
    for (const at of stamps) {
      const forPoint = new Map<string, string>();
      for (const [key, series] of seriesByKey) {
        const usd8 = priceAtOrBefore(series, at);
        if (usd8) forPoint.set(key, usd8);
      }
      if (forPoint.size > 0) pricesByTime.set(at, forPoint);
    }

    const series = buildHistorySeries(
      stamps,
      balancesByTime,
      assets,
      pricesByTime,
      source.nativePriceKey
    );
    return {
      chain: source.chain,
      points: series.points,
      oldest_at: series.points[0]?.at ?? null,
      // 先頭が「最初に資産を持った時刻」で、かつ差分を取り切れている時だけ
      // 「それ以前はゼロ」と言える (複数アドレス合算で 0 として扱ってよい)
      starts_at_funding:
        fundedFrom !== null && fundedFrom >= cutoff && inputs.complete,
      approximated_symbols: series.approximatedSymbols,
      ...meta,
    };
  }

  return {
    chain: source.chain,

    async history(address, days, nowSeconds = Math.floor(now() / 1000)) {
      const key = `${address}|${days}`;
      const cached = historyCache.get(key);
      if (cached) {
        if (now() - cached.at < ttl) return cached.data;
        // 8.83: stale-while-revalidate — TTL 超過でも即返し、裏で作り直す。
        // チャートは display-only なので bounded staleness は許容 (§4.6 の
        // oracle fail-closed 系とは別経路で、実行判定には一切使われない)
        if (!refreshing.has(key)) {
          refreshing.add(key);
          void compute(address, days, Math.floor(now() / 1000))
            .then((data) => historyCache.set(key, { at: now(), data }))
            .catch(() => undefined)
            .finally(() => refreshing.delete(key));
        }
        return cached.data;
      }
      const data = await compute(address, days, nowSeconds);
      historyCache.set(key, { at: now(), data });
      return data;
    },

    async holdings(address) {
      // 現在値だけなら差分は要らないが、history と入力 cache を共有するため
      // 最短 range (1 日) で取る (cache / in-flight があればそれを使う)
      const inputs = await loadInputs(address, 1, Math.floor(now() / 1000));
      return {
        chain: source.chain,
        address,
        holdings: inputs ? holdingsFromInputs(source.chain, address, inputs) : [],
      };
    },

    clear() {
      historyCache.clear();
      inputsCache.clear();
      inflight.clear();
    },
  };
}

/**
 * 入力 → holdings。評価額は amount × 現在単価 (bigint)。
 * **単価が不明な asset は載せない** (0 として見せない = 架空値を出さない)。
 */
export function holdingsFromInputs(
  chain: ChainId,
  address: string,
  inputs: HistoryInputs
): PortfolioHolding[] {
  const out: PortfolioHolding[] = [];
  for (const asset of inputs.assets) {
    const amount = inputs.current.get(asset.mint) ?? 0n;
    if (amount <= 0n || !asset.currentUsd8) continue;
    let price: bigint;
    try {
      price = usd8ToBigInt(asset.currentUsd8);
    } catch {
      continue;
    }
    const usd = (amount * price) / 10n ** BigInt(asset.decimals);
    if (usd <= 0n) continue;
    out.push({
      chain,
      address,
      symbol: asset.symbol,
      protocol_id: asset.protocolId ?? "wallet_holding",
      category: asset.category ?? PositionCategory.Other,
      amount: {
        value: amount.toString(),
        decimals: asset.decimals,
        symbol: asset.symbol,
      },
      usd: bigIntToUsd8(usd),
      deposited: asset.deposited === true,
      in_history: true,
    });
  }
  for (const extra of inputs.extraHoldings ?? []) {
    out.push({ chain, address, ...extra });
  }
  return out;
}
