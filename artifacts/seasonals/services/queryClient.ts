/**
 * QueryClient — TanStack Query の単一エントリ (CLAUDE.md §5)
 *
 * Mobile / 将来の Web dashboard が `<QueryClientProvider client={createQueryClient()}>` で
 * wrap する。テストでは fresh な instance を毎回作る (キャッシュ汚染防止)。
 *
 * default options の設計:
 * - retry: 1 — モバイル回線で 1 回までは再試行 (BFF 一過性 5xx 想定)
 * - retry はテスト等で false に override 可能
 * - refetchOnWindowFocus: true — 8.93: attachAppStateFocus で AppState を
 *   focusManager に配線したので、フォアグラウンド復帰 = focus として stale query を
 *   refetch する (staleTime 30s が連続復帰を吸収)。8.93 以前は配線がなく false だった
 * - staleTime: 30s — UnifiedTimeEvent / Position の更新頻度に合わせた
 *   保守的 default (Calendar tick で頻繁に refetch しない)
 *
 * @see CLAUDE.md §5 (server state は TanStack Query 経由 / fetch 直叩き禁止)
 * @see docs/spec.md §11.4 / §11.7 (UnifiedTimeEvent / AgentPlan)
 */

import { AppState } from "react-native";
import {
  QueryClient,
  focusManager,
  type QueryClientConfig,
} from "@tanstack/react-query";

/**
 * 共通の default options。
 * テストや特殊用途で override したい場合は createQueryClient(overrides) を使う。
 */
export const DEFAULT_QUERY_OPTIONS: QueryClientConfig = {
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true, // 8.93: attachAppStateFocus とセット
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
/**
 * 8.93: RN には window focus が無いので、AppState の active/background を
 * TanStack Query の focusManager に配線する (これが無いと refetchOnWindowFocus は
 * 一切発火しない)。App root で 1 回呼び、戻り値で購読解除する。
 * 購読パターンは components/glass/useTiltRoll.ts と同じ。
 *
 * NetInfo / onlineManager (ネット復帰の瞬間検知) は native module 追加 =
 * APK 再ビルドが要るため見送り (backlog §E.3.5)。復帰の検知は本配線 +
 * queries.ts の errorRetryInterval (エラー時のみ 30s ポーリング) が担う。
 */
export function attachAppStateFocus(): () => void {
  const sub = AppState.addEventListener("change", (state) => {
    focusManager.setFocused(state === "active");
  });
  return () => sub.remove();
}

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
