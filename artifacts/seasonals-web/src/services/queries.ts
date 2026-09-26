/**
 * TanStack Query hooks (server state は必ずここ経由、CLAUDE.md §5)。
 *
 * useTimeline(): 公開イベント + 閲覧中 address のイベント + ユーザーが手入力した予定
 * (custom plan、localStorage) を 1 本の TimelineEvent[] に merge する
 * (Calendar / Timeline / 詳細カード / Dashboard の共通 source)。
 * 部分失敗は source ごとの状態として返し、架空データで埋めない。
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fromCustomEvent, fromUnifiedTimeEventDTO, mergeTimelineEvents, sortTimeline } from "@workspace/lib/derive/timeline";
import type { TimelineEvent, TimelineEventsResponse } from "@workspace/lib/types";
import { useActiveAddresses } from "../state/session";
import { useCustomEvents } from "../state/customEvents";
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
