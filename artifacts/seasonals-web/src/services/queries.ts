/**
 * TanStack Query hooks (server state は必ずここ経由、CLAUDE.md §5)。
 *
 * useTimeline(): 公開イベント + 閲覧中 address のイベント + ユーザーが手入力した予定
 * (custom plan、localStorage) を 1 本の TimelineEvent[] に merge する
 * (Calendar / Timeline / 詳細カード / Dashboard の共通 source)。
 * 部分失敗は source ごとの状態として返し、架空データで埋めない。
 */
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fromCustomEvent, fromUnifiedTimeEventDTO, mergeTimelineEvents, sortTimeline } from "@workspace/lib/derive/timeline";
import { heldPoolKeys } from "@workspace/lib/derive/earn-positions";
import { rangeToDays, type RangeKey } from "@workspace/lib/derive/portfolio";
import type {
  EarnPosition,
  MenuHolding,
  MenuHoldingsResponse,
  MenuProduct,
  PortfolioHistoryResponse,
  PortfolioHoldingsResponse,
  ProtocolMenuEntry,
  TimelineEvent,
  TimelineEventsResponse,
} from "@workspace/lib/types";
import { useActiveAddresses, type ActiveAddress } from "../state/session";
import { useCustomEvents } from "../state/customEvents";
import { api, ApiError } from "./api";
import { shortAddress } from "../ui/format";

export const queryKeys = {
  ethPublic: ["eth", "public-events"] as const,
  ethEvents: (a: string) => ["eth", "events", a.toLowerCase()] as const,
  solEvents: (a: string) => ["sol", "events", a] as const,
  menu: ["menu-listings"] as const,
  ethStatus: ["eth", "status"] as const,
  ethHoldings: (a: string) => ["eth", "holdings", a.toLowerCase()] as const,
  solEarn: (a: string) => ["sol", "earn", a] as const,
  portfolioHistory: (a: ActiveAddress, days: number) => ["portfolio", "history", a.chain, addressKey(a), days] as const,
  portfolioHoldings: (a: ActiveAddress) => ["portfolio", "holdings", a.chain, addressKey(a)] as const,
};

/** EVM address は大小文字を区別しない (Solana の base58 は区別する) */
function addressKey(a: Pick<ActiveAddress, "chain" | "address">): string {
  return a.chain === "ethereum" ? a.address.toLowerCase() : a.address;
}

export interface SourceState {
  key: string;
  label: string;
  status: "loading" | "ok" | "error" | "unavailable";
  error?: string;
  count: number;
  /** 200 で返ったが一部 adapter が失敗 / 未完了 */
  partial?: string[];
}

export interface TimelineData {
  events: TimelineEvent[];
  sources: SourceState[];
  isLoading: boolean;
  /** wallet (接続 or watch) が 1 つでもあるか */
  hasWallet: boolean;
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 404 ? "Not available on this server yet." : e.message;
  return e instanceof Error ? e.message : "Unknown error";
}

export function useTimeline(): TimelineData {
  const active = useActiveAddresses();
  const customEvents = useCustomEvents((s) => s.events);

  const specs = [
    {
      key: "eth-public",
      label: "Ethereum public events",
      queryKey: queryKeys.ethPublic as readonly unknown[],
      queryFn: async () => api.ethPublicEvents(),
    },
    ...active.map((a) =>
      a.chain === "ethereum"
        ? {
            key: `eth:${a.address}`,
            label: `Ethereum ${shortAddress(a.address)}`,
            queryKey: queryKeys.ethEvents(a.address) as readonly unknown[],
            queryFn: async () => api.ethEvents(a.address),
          }
        : {
            key: `sol:${a.address}`,
            label: `Solana ${shortAddress(a.address)}`,
            queryKey: queryKeys.solEvents(a.address) as readonly unknown[],
            queryFn: async (): Promise<TimelineEventsResponse> => {
              const observedAt = new Date().toISOString();
              return {
                events: (await api.solanaWalletEvents(a.address)).map((d) => fromUnifiedTimeEventDTO(d, observedAt)),
                sources: [{ source: "seasonals-bff:solana", ok: true, observedAt }],
              };
            },
          }
    ),
  ];

  const results = useQueries({
    queries: specs.map((s) => ({
      queryKey: s.queryKey,
      queryFn: s.queryFn,
      staleTime: 60_000,
      retry: (n: number, e: unknown) => !(e instanceof ApiError && e.status === 404) && n < 2,
      // 一部 source が未完了 / 失敗 (CCA bid の background scan、429 等) なら 15 秒後に再取得
      refetchInterval: (q: { state: { data?: TimelineEventsResponse } }) => (q.state.data?.sources.some((x) => !x.ok) ? 15_000 : false),
    })),
  });

  const dataKey = results.map((r) => r.dataUpdatedAt).join(",");
  const events = useMemo(
    () => {
      const observedAt = new Date().toISOString();
      return sortTimeline(
        mergeTimelineEvents(...results.map((r) => r.data?.events ?? []), customEvents.map((c) => fromCustomEvent(c, observedAt)))
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey, customEvents]
  );

  const sources: SourceState[] = specs.map((s, i) => {
    const r = results[i]!;
    const notFound = r.error instanceof ApiError && r.error.status === 404;
    return {
      key: s.key,
      label: s.label,
      status: r.isPending ? "loading" : r.isError ? (notFound ? "unavailable" : "error") : "ok",
      ...(r.isError ? { error: errorText(r.error) } : {}),
      count: r.data?.events.length ?? 0,
      ...(r.data && r.data.sources.some((x) => !x.ok) ? { partial: r.data.sources.filter((x) => !x.ok).map((x) => `${x.source}: ${x.error ?? "failed"}`) } : {}),
    };
  });

  return {
    events,
    sources,
    isLoading: results.some((r) => r.isPending),
    hasWallet: active.length > 0,
  };
}

export function useMenuListings() {
  return useQuery({ queryKey: queryKeys.menu, queryFn: api.menuListings, staleTime: 60_000, retry: 1 });
}

export function useEthMenu() {
  return useQuery({ queryKey: ["eth", "menu"], queryFn: api.ethMenu, staleTime: 5 * 60_000, retry: 1 });
}

export function useEthStatus() {
  return useQuery({ queryKey: queryKeys.ethStatus, queryFn: api.ethStatus, staleTime: 30_000, retry: false });
}

export interface MenuHoldingsData {
  /** watch / 接続中の address が 1 つでもあるか (無ければトグルは無効) */
  hasAddress: boolean;
  isLoading: boolean;
  /** 取得に失敗した source (address + 種類)。失敗分は「保有なし」とみなさない */
  failed: string[];
  /** Ethereum: productId → 各 address の保有 */
  eth: Map<string, MenuHolding[]>;
  /** Solana: `${protocol_id}:${pool_id}` → 各 wallet の position */
  sol: Map<string, EarnPosition[]>;
  /** 保有しているが Menu の一覧に無い Ethereum 商品 */
  extraProducts: MenuProduct[];
  /** Ethereum address ごとの応答 (deposit / withdraw パネルの残高・Max 用) */
  ethByAddress: Map<string, MenuHoldingsResponse>;
}

/**
 * Menu の「Deposited only」用: 閲覧中 address すべての保有をまとめる。
 * Ethereum は BFF /eth/holdings (on-chain 残高)、Solana は既存の /positions/earn を
 * lib の heldPoolKeys で menu の pool_id に対応付ける (mobile MenuDrawer と同じ規則)。
 */
export function useMenuHoldings(listings: ProtocolMenuEntry[] | undefined): MenuHoldingsData {
  const active = useActiveAddresses();
  const eth = active.filter((a) => a.chain === "ethereum");
  const sol = active.filter((a) => a.chain === "solana");
  const ethResults = useQueries({
    queries: eth.map((a) => ({ queryKey: queryKeys.ethHoldings(a.address), queryFn: () => api.ethHoldings(a.address), staleTime: 60_000, retry: 1 })),
  });
  const solResults = useQueries({
    queries: sol.map((a) => ({ queryKey: queryKeys.solEarn(a.address), queryFn: () => api.solanaEarnPositions(a.address), staleTime: 60_000, retry: 1 })),
  });
  // 依存配列の長さが address 数で変わるため useMemo は使わない (集計は軽い)
  {
    const failed: string[] = [];
    const ethMap = new Map<string, MenuHolding[]>();
    const extra = new Map<string, MenuProduct>();
    const ethByAddress = new Map<string, MenuHoldingsResponse>();
    ethResults.forEach((r, i) => {
      const label = `Ethereum ${shortAddress(eth[i]!.address)}`;
      if (r.isError) failed.push(label);
      if (!r.data) return;
      ethByAddress.set(eth[i]!.address, r.data);
      r.data.failed.forEach((f) => failed.push(`${label} (${f})`));
      for (const h of r.data.holdings) ethMap.set(h.productId, [...(ethMap.get(h.productId) ?? []), h]);
      for (const p of r.data.extraProducts) extra.set(p.id, p);
    });
    solResults.forEach((r, i) => {
      if (r.isError) failed.push(`Solana ${shortAddress(sol[i]!.address)}`);
    });
    const earns = solResults.flatMap((r) => (r.data ? [r.data] : []));
    return {
      hasAddress: active.length > 0,
      isLoading: [...ethResults, ...solResults].some((r) => r.isPending),
      failed,
      eth: ethMap,
      sol: listings ? heldPoolKeys(listings, earns) : new Map(),
      extraProducts: [...extra.values()],
      ethByAddress,
    };
  }
}

/** 1 address 分の portfolio query の状態 (失敗を隠さず、合算から外したことを示すため) */
export interface PortfolioSourceResult<T> {
  address: ActiveAddress;
  data: T | undefined;
  isFetching: boolean;
  isPending: boolean;
  error: string | null;
}

// 履歴は BFF 側も 5 分 cache + SWR (8.83)。mobile の usePortfolioHistory と同じ鮮度
const PORTFOLIO_STALE_MS = 5 * 60_000;
// 503 は BFF が上流失敗を返したもの (BFF 側で SWR 済み、key 未設定は直らない)。
// 再試行するのは BFF に届かなかった時だけ
const portfolioRetry = (n: number, e: unknown) => e instanceof ApiError && e.status === 0 && n < 1;

/**
 * 閲覧中の全 address の評価額履歴 (chain ごとに endpoint を振り分け)。
 * range を切り替えても前の系列を出したまま取りに行く (keepPreviousData)。
 */
export function usePortfolioHistories(range: RangeKey): PortfolioSourceResult<PortfolioHistoryResponse>[] {
  const active = useActiveAddresses();
  const days = rangeToDays(range);
  const results = useQueries({
    queries: active.map((a) => ({
      queryKey: queryKeys.portfolioHistory(a, days),
      queryFn: () => api.portfolioHistory(a.chain, a.address, days),
      staleTime: PORTFOLIO_STALE_MS,
      placeholderData: keepPreviousData,
      retry: portfolioRetry,
    })),
  });
  return active.map((a, i) => toSourceResult(a, results[i]!));
}

/** 閲覧中の全 address の現在の保有 (Allocation donut / holdings 表) */
export function usePortfolioHoldings(): PortfolioSourceResult<PortfolioHoldingsResponse>[] {
  const active = useActiveAddresses();
  const results = useQueries({
    queries: active.map((a) => ({
      queryKey: queryKeys.portfolioHoldings(a),
      queryFn: () => api.portfolioHoldings(a.chain, a.address),
      staleTime: PORTFOLIO_STALE_MS,
      retry: portfolioRetry,
    })),
  });
  return active.map((a, i) => toSourceResult(a, results[i]!));
}

function toSourceResult<T>(
  address: ActiveAddress,
  r: { data?: T; isFetching: boolean; isPending: boolean; isError: boolean; error: unknown }
): PortfolioSourceResult<T> {
  return {
    address,
    data: r.isError ? undefined : r.data,
    isFetching: r.isFetching,
    isPending: r.isPending,
    error: r.isError ? errorText(r.error) : null,
  };
}
