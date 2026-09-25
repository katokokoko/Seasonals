/**
 * TanStack Query hooks (server state は必ずここ経由、CLAUDE.md §5)。
 *
 * useTimeline(): 公開イベント + 閲覧中 address のイベントを 1 本の TimelineEvent[] に
 * merge する (Calendar / Timeline / 詳細カード / Dashboard の共通 source)。
 * 部分失敗は source ごとの状態として返し、架空データで埋めない。
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fromUnifiedTimeEventDTO, mergeTimelineEvents, sortTimeline } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import { activeAddresses, useSession } from "../state/session";
import { api, ApiError } from "./api";

export const queryKeys = {
  ethPublic: ["eth", "public-events"] as const,
  ethEvents: (a: string) => ["eth", "events", a.toLowerCase()] as const,
  solEvents: (a: string) => ["sol", "events", a] as const,
  menu: ["menu-listings"] as const,
  ethStatus: ["eth", "status"] as const,
};

export interface SourceState {
  key: string;
  label: string;
  status: "loading" | "ok" | "error" | "unavailable";
  error?: string;
  count: number;
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
  const watch = useSession((s) => s.watch);
  const connectedEvm = useSession((s) => s.connectedEvm);
  const addrs = activeAddresses({ watch, connectedEvm });

  const specs = [
    {
      key: "eth-public",
      label: "Ethereum public events",
      queryKey: queryKeys.ethPublic,
      queryFn: async () => (await api.ethPublicEvents()).events,
    },
    ...(addrs.ethereum
      ? [
          {
            key: "eth-wallet",
            label: "Ethereum wallet events",
            queryKey: queryKeys.ethEvents(addrs.ethereum),
            queryFn: async () => (await api.ethEvents(addrs.ethereum!)).events,
          },
        ]
      : []),
    ...(addrs.solana
      ? [
          {
            key: "sol-wallet",
            label: "Solana wallet events",
            queryKey: queryKeys.solEvents(addrs.solana),
            queryFn: async () => {
              const observedAt = new Date().toISOString();
              return (await api.solanaWalletEvents(addrs.solana!)).map((d) => fromUnifiedTimeEventDTO(d, observedAt));
            },
          },
        ]
      : []),
  ];

  const results = useQueries({
    queries: specs.map((s) => ({
      queryKey: s.queryKey,
      queryFn: s.queryFn,
      staleTime: 60_000,
      retry: (n: number, e: unknown) => !(e instanceof ApiError && e.status === 404) && n < 2,
    })),
  });

  const dataKey = results.map((r) => r.dataUpdatedAt).join(",");
  const events = useMemo(
    () => sortTimeline(mergeTimelineEvents(...results.map((r) => r.data ?? []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey]
  );

  const sources: SourceState[] = specs.map((s, i) => {
    const r = results[i]!;
    const notFound = r.error instanceof ApiError && r.error.status === 404;
    return {
      key: s.key,
      label: s.label,
      status: r.isPending ? "loading" : r.isError ? (notFound ? "unavailable" : "error") : "ok",
      ...(r.isError ? { error: errorText(r.error) } : {}),
      count: r.data?.length ?? 0,
    };
  });

  return {
    events,
    sources,
    isLoading: results.some((r) => r.isPending),
    hasWallet: Object.keys(addrs).length > 0,
  };
}

export function useMenuListings() {
  return useQuery({ queryKey: queryKeys.menu, queryFn: api.menuListings, staleTime: 60_000, retry: 1 });
}

export function useEthStatus() {
  return useQuery({ queryKey: queryKeys.ethStatus, queryFn: api.ethStatus, staleTime: 30_000, retry: false });
}
