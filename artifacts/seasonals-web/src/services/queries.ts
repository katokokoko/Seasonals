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
import { useActiveAddresses } from "../state/session";
import { api, ApiError } from "./api";
import { shortAddress } from "../ui/format";

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
  const active = useActiveAddresses();

  const specs = [
    {
      key: "eth-public",
      label: "Ethereum public events",
      queryKey: queryKeys.ethPublic as readonly unknown[],
      queryFn: async () => (await api.ethPublicEvents()).events,
    },
    ...active.map((a) =>
      a.chain === "ethereum"
        ? {
            key: `eth:${a.address}`,
            label: `Ethereum ${shortAddress(a.address)}`,
            queryKey: queryKeys.ethEvents(a.address) as readonly unknown[],
            queryFn: async () => (await api.ethEvents(a.address)).events,
          }
        : {
            key: `sol:${a.address}`,
            label: `Solana ${shortAddress(a.address)}`,
            queryKey: queryKeys.solEvents(a.address) as readonly unknown[],
            queryFn: async () => {
              const observedAt = new Date().toISOString();
              return (await api.solanaWalletEvents(a.address)).map((d) => fromUnifiedTimeEventDTO(d, observedAt));
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
    hasWallet: active.length > 0,
  };
}

export function useMenuListings() {
  return useQuery({ queryKey: queryKeys.menu, queryFn: api.menuListings, staleTime: 60_000, retry: 1 });
}

export function useEthStatus() {
  return useQuery({ queryKey: queryKeys.ethStatus, queryFn: api.ethStatus, staleTime: 30_000, retry: false });
}
