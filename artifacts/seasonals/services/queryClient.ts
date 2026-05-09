/**
 * QueryClient — TanStack Query の単一エントリ (CLAUDE.md §5)
 *
 * Mobile / 将来の Web dashboard が `<QueryClientProvider client={createQueryClient()}>` で
 * wrap する。テストでは fresh な instance を毎回作る (キャッシュ汚染防止)。
 *
 * default options の設計:
 * - retry: 1 — モバイル回線で 1 回までは再試行 (BFF 一過性 5xx 想定)
 * - retry はテスト等で false に override 可能
 * - refetchOnWindowFocus: false — RN にウィンドウフォーカスはなく iOS/Android lifecycle で扱う
 * - staleTime: 30s — UnifiedTimeEvent / Position の更新頻度に合わせた
 *   保守的 default (Calendar tick で頻繁に refetch しない)
 *
 * @see CLAUDE.md §5 (server state は TanStack Query 経由 / fetch 直叩き禁止)
 * @see docs/spec.md §11.4 / §11.7 (UnifiedTimeEvent / AgentPlan)
 */

import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";

/**
 * 共通の default options。
 * テストや特殊用途で override したい場合は createQueryClient(overrides) を使う。
 */
export const DEFAULT_QUERY_OPTIONS: QueryClientConfig = {
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: {
      retry: 0,
    },
  },
};

/**
 * 新しい QueryClient instance を作る。
 * App root で 1 回呼ぶ (テストでは毎テスト新規生成して isolation を担保)。
 */
export function createQueryClient(
  overrides?: Partial<QueryClientConfig>
): QueryClient {
  return new QueryClient({
    ...DEFAULT_QUERY_OPTIONS,
    ...overrides,
    defaultOptions: {
      ...DEFAULT_QUERY_OPTIONS.defaultOptions,
      ...overrides?.defaultOptions,
      queries: {
        ...DEFAULT_QUERY_OPTIONS.defaultOptions?.queries,
        ...overrides?.defaultOptions?.queries,
      },
      mutations: {
        ...DEFAULT_QUERY_OPTIONS.defaultOptions?.mutations,
        ...overrides?.defaultOptions?.mutations,
      },
    },
  });
}
