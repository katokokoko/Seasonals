/**
 * services/queries — テスト
 *
 * 各 query hook が:
 * - loading → success の状態遷移を経る (mock fetcher の microtask 越え)
 * - lib/__fixtures__ 由来の値を data として返す
 * - queryKey が衝突しない (snapshot)
 *
 * 環境: jest-expo + @testing-library/react-native v12.5+ の `renderHook` API
 */

import React, { type ReactNode } from "react";
import {
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";

import {
  useTimeEvents,
  usePositions,
  useAgentPlan,
  useApprovalToken,
  useUserPolicy,
  useWallets,
  useProtocols,
  useMenuListings,
  useApproveAgentPlan,
  useRejectAgentPlan,
  useRegisterPushToken,
  useEarnPositions,
  useWalletTimeEvents,
  useJupiterLendMarkets,
  useKaminoReserves,
  usePrices,
  usePortfolioHistory,
  queryKeys,
  PRICED_SYMBOLS,
  WALLET_QUERY_STALE_MS,
  WALLET_QUERY_GC_MS,
  CATALOG_QUERY_STALE_MS,
} from "./queries";
import * as api from "./api";
import { createQueryClient } from "./queryClient";
import { TIME_EVENT_CATEGORIES } from "@workspace/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 各テストで fresh な QueryClient を作る (キャッシュ汚染防止) */
function freshClient(): QueryClient {
  return createQueryClient({
    defaultOptions: {
      queries: {
        // テストでは retry を切って失敗時に即座に error を観察する
        retry: false,
        // 各テストごとに client が新規なので汚染は起きない。一方 gcTime=0 は
        // setQueryData → 別 hook の mount までの subscriber 不在期間に即時 GC が走り
        // cache が消えるため、最小限の長さを確保する。
        gcTime: 5_000,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("services/queries", () => {
  describe("useTimeEvents", () => {
    it("fixture の 8 件 (TimeEventCategory 全網羅) を返す", async () => {
      const { result } = renderHook(() => useTimeEvents(), {
        wrapper: makeWrapper(freshClient()),
      });

      // 初期: loading
      expect(result.current.isPending).toBe(true);

      // microtask 越しに success
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toBeDefined();
      expect(result.current.data!.length).toBe(8);
      // §32.2 整合性チェック「8 categories of time」: fixture が enum と一致
      const categories = result.current.data!.map((e) => e.category);
      for (const cat of TIME_EVENT_CATEGORIES) {
        expect(categories).toContain(cat);
      }
    });
  });

  describe("usePositions", () => {
    it("fixture positions を返す (allocation 7 categories 用に拡張済)", async () => {
      const { result } = renderHook(() => usePositions(), {
        wrapper: makeWrapper(freshClient()),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data!.length).toBeGreaterThanOrEqual(4);
      // smallest unit string が parse されずそのまま保持されている (§4.5)
      const lendingPos = result.current.data!.find(
        (p) => p.position_id === "pos_001"
      );
      expect(typeof lendingPos!.principal_amount).toBe("string");
      expect(lendingPos!.principal_amount).toBe("1500000000");
    });
  });

  describe("useAgentPlan", () => {
    it("plan_id を渡すと該当 plan を返す", async () => {
      const { result } = renderHook(() => useAgentPlan("plan_002"), {
        wrapper: makeWrapper(freshClient()),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data!.plan_id).toBe("plan_002");
      expect(result.current.data!.status).toBe("simulated");
    });

    it("planId=null なら disabled (fetch しない)", () => {
      const { result } = renderHook(() => useAgentPlan(null), {
        wrapper: makeWrapper(freshClient()),
      });
      // disabled なら status='pending' のまま fetcher が呼ばれない
      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.isPending).toBe(true);
      expect(result.current.data).toBeUndefined();
    });

    it("存在しない plan_id は error 状態になる", async () => {
      const { result } = renderHook(() => useAgentPlan("plan_does_not_exist"), {
        wrapper: makeWrapper(freshClient()),
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toMatch(/agent_plan_not_found/);
    });
  });

  describe("useUserPolicy", () => {
    it("default policy を返す (approval_mode=request_per_action)", async () => {
      const { result } = renderHook(() => useUserPolicy(), {
        wrapper: makeWrapper(freshClient()),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data!.approval_mode).toBe("request_per_action");
      // §11.6 default: max_tx_amount は null
      expect(result.current.data!.max_tx_amount).toBeNull();
    });
  });

  describe("useWallets", () => {
    it("fixture の 3 wallets を返す", async () => {
      const { result } = renderHook(() => useWallets(), {
        wrapper: makeWrapper(freshClient()),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data!.length).toBe(3);
    });
  });

  describe("useProtocols", () => {
    it("fixture の protocols を返す (Tier S/A 含む)", async () => {
      const { result } = renderHook(() => useProtocols(), {
        wrapper: makeWrapper(freshClient()),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const trustLevels = new Set(result.current.data!.map((p) => p.trust_level));
      expect(trustLevels.has("S")).toBe(true);
      expect(trustLevels.has("A")).toBe(true);
    });
  });

  describe("useMenuListings (8.22 — 本番は BFF /menu-listings が live 値を返す)", () => {
    it("fixture path で 11 protocol の menu listing を返す", async () => {
      const { result } = renderHook(() => useMenuListings(), {
        wrapper: makeWrapper(freshClient()),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const listings = result.current.data!;
      expect(listings.length).toBe(12); // 8.33: exponent entry 追加 (read-only PT)
      const orca = listings.find((e) => e.protocol_id === "orca")!;
      expect(orca.pools.length).toBe(3);
      expect(queryKeys.menuListings()).toEqual(["menu-listings"]);
    });
  });

  // ── queryKey の衝突がないか確認 (cache invalidation の精度に関わる) ──
  describe("queryKeys", () => {
    it("各 hook の queryKey は domain で一意に prefix される", () => {
      expect(queryKeys.timeEvents()).toEqual(["time-events"]);
      expect(queryKeys.positions()).toEqual(["positions"]);
      expect(queryKeys.userPolicy()).toEqual(["user-policy"]);
      expect(queryKeys.wallets()).toEqual(["wallets"]);
      expect(queryKeys.protocols()).toEqual(["protocols"]);
    });

    it("agentPlan は plan_id で sub-key 化される", () => {
      expect(queryKeys.agentPlan("plan_001")).toEqual([
        "agent-plan",
        "plan_001",
      ]);
      expect(queryKeys.agentPlan("plan_002")).toEqual([
        "agent-plan",
        "plan_002",
      ]);
    });

    it("approvalToken は token_id で sub-key 化される", () => {
      expect(queryKeys.approvalToken("tok_active_001")).toEqual([
        "approval-token",
        "tok_active_001",
      ]);
    });
  });

  // ── approval token query ──
  describe("useApprovalToken", () => {
    it("token_id を渡すと該当 ApprovalToken を返す", async () => {
      const { result } = renderHook(
        () => useApprovalToken("tok_active_001"),
        { wrapper: makeWrapper(freshClient()) }
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data!.token_id).toBe("tok_active_001");
      expect(result.current.data!.consumed_at).toBeNull();
    });

    it("tokenId=null なら disabled (fetch しない)", () => {
      const { result } = renderHook(() => useApprovalToken(null), {
        wrapper: makeWrapper(freshClient()),
      });
      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.data).toBeUndefined();
    });

    it("存在しない token_id は error 状態", async () => {
      const { result } = renderHook(
        () => useApprovalToken("tok_does_not_exist"),
        { wrapper: makeWrapper(freshClient()) }
      );
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toMatch(
        /approval_token_not_found/
      );
    });
  });

  // ── push token registration mutation ──
  describe("useRegisterPushToken", () => {
    it("token を渡すと registered_at の timestamp を返す", async () => {
      const { result } = renderHook(() => useRegisterPushToken(), {
        wrapper: makeWrapper(freshClient()),
      });
      result.current.mutate({ token: "ExponentPushToken[abc]" });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(typeof result.current.data!.registered_at).toBe("string");
    });

    it("空 token は invalid_push_token error", async () => {
      const { result } = renderHook(() => useRegisterPushToken(), {
        wrapper: makeWrapper(freshClient()),
      });
      result.current.mutate({ token: "" });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toMatch(/invalid_push_token/);
    });
  });

  // ── approve / reject mutation hooks ──
  describe("useApproveAgentPlan", () => {
    it("simulated plan を approve すると status=approved を返す", async () => {
      const client = freshClient();
      const { result } = renderHook(() => useApproveAgentPlan(), {
        wrapper: makeWrapper(client),
      });
      result.current.mutate({ plan_id: "plan_002" });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data!.plan_id).toBe("plan_002");
      expect(result.current.data!.status).toBe("approved");
    });

    it("draft 状態の plan を approve しようとすると error", async () => {
      const client = freshClient();
      const { result } = renderHook(() => useApproveAgentPlan(), {
        wrapper: makeWrapper(client),
      });
      result.current.mutate({ plan_id: "plan_001" });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toMatch(/invalid_status_transition/);
    });

    it("成功時に useAgentPlan(plan_id) の cache に approved plan を書き込む", async () => {
      const client = freshClient();
      const wrapper = makeWrapper(client);
      const { result: mut } = renderHook(() => useApproveAgentPlan(), {
        wrapper,
      });
      mut.current.mutate({ plan_id: "plan_002" });
      await waitFor(() => expect(mut.current.isSuccess).toBe(true));

      // 同じ QueryClient 上で useAgentPlan を mount → cache hit で approved を返す
      const { result: q } = renderHook(() => useAgentPlan("plan_002"), {
        wrapper,
      });
      await waitFor(() => expect(q.current.data).toBeDefined());
      expect(q.current.data!.status).toBe("approved");
    });
  });

  describe("useRejectAgentPlan", () => {
    it("plan を reject すると status=rejected を返す", async () => {
      const client = freshClient();
      const { result } = renderHook(() => useRejectAgentPlan(), {
        wrapper: makeWrapper(client),
      });
      result.current.mutate({
        plan_id: "plan_002",
        reason: "user changed mind",
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data!.status).toBe("rejected");
    });
  });

  // ── createQueryClient の defaults ──
  describe("createQueryClient", () => {
    it("default options を継承しつつ override 可能", () => {
      const client = createQueryClient({
        defaultOptions: { queries: { retry: 5 } },
      });
      const opts = client.getDefaultOptions();
      expect(opts.queries?.retry).toBe(5);
      // override しなかった field は default を維持
      // (8.93: focusManager 配線とセットで refetchOnWindowFocus は true が default)
      expect(opts.queries?.refetchOnWindowFocus).toBe(true);
      expect(opts.queries?.staleTime).toBe(30_000);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API 効率化計画 Phase A: staleTime / gcTime / enabled / placeholder / signal
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase A — 鮮度と保持の設定", () => {
  const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
  const B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

  /** その key の observer に効いている staleTime と query の gcTime */
  function settingsOf(client: QueryClient, queryKey: readonly unknown[]) {
    const q = client.getQueryCache().find({ queryKey, exact: true })!;
    return {
      staleTime: q.observers[0]?.options.staleTime,
      gcTime: q.gcTime,
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("wallet 系 3 hook は staleTime 60s / gcTime 24h (切断・切替後も cache を保持)", async () => {
    const client = freshClient();
    const { result } = renderHook(
      () => ({
        p: usePositions(A),
        e: useEarnPositions(A),
        w: useWalletTimeEvents(A),
      }),
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => {
      expect(result.current.p.isSuccess).toBe(true);
      expect(result.current.e.isSuccess).toBe(true);
      expect(result.current.w.isSuccess).toBe(true);
    });
    for (const key of [
      queryKeys.positions(A),
      queryKeys.earnPositions(A),
      queryKeys.walletTimeEvents(A),
    ]) {
      expect(settingsOf(client, key)).toEqual({
        staleTime: WALLET_QUERY_STALE_MS,
        gcTime: WALLET_QUERY_GC_MS,
      });
    }
    expect(WALLET_QUERY_STALE_MS).toBe(60_000);
    expect(WALLET_QUERY_GC_MS).toBe(24 * 60 * 60_000);
    client.clear();
  });

  it("address 無しの fixture positions は gcTime を延ばさない (wallet の cache ではない)", async () => {
    const client = freshClient();
    const { result } = renderHook(() => usePositions(), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(settingsOf(client, queryKeys.positions(null)).gcTime).toBe(5_000);
    client.clear();
  });

  it("共有カタログは BFF の cache に揃える (menu / jupiter / kamino 5 分、prices 2 分、protocols ∞)", () => {
    const client = freshClient();
    // observer の options を見るだけなので取得完了は待たない (kamino の fixture は adapter を動的 import)
    const { unmount } = renderHook(
      () => ({
        m: useMenuListings(),
        j: useJupiterLendMarkets(),
        k: useKaminoReserves(),
        pr: usePrices(),
        pt: useProtocols(),
      }),
      { wrapper: makeWrapper(client) }
    );
    expect(settingsOf(client, queryKeys.menuListings()).staleTime).toBe(CATALOG_QUERY_STALE_MS);
    expect(settingsOf(client, queryKeys.jupiterLendMarkets()).staleTime).toBe(CATALOG_QUERY_STALE_MS);
    expect(settingsOf(client, queryKeys.kaminoReserves()).staleTime).toBe(CATALOG_QUERY_STALE_MS);
    expect(CATALOG_QUERY_STALE_MS).toBe(5 * 60_000);
    expect(
      settingsOf(client, queryKeys.prices([...PRICED_SYMBOLS].sort())).staleTime
    ).toBe(2 * 60_000);
    expect(settingsOf(client, queryKeys.protocols()).staleTime).toBe(Infinity);
    unmount();
    client.clear();
  });

  it("useKaminoReserves({ enabled: false }) は取得しない (Kamino 以外の ActionModal)", async () => {
    const spy = jest.spyOn(api, "getKaminoReserves");
    const { result } = renderHook(() => useKaminoReserves({ enabled: false }), {
      wrapper: makeWrapper(freshClient()),
    });
    await Promise.resolve();
    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("queryFn は TanStack の AbortSignal を getter に渡す (切替 / unmount で回線ごと abort)", async () => {
    const spy = jest.spyOn(api, "getPositions");
    const { result } = renderHook(() => usePositions(A), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(A, expect.any(AbortSignal));
  });

  it("永続 cache から戻った wallet time events (triggerAt が文字列) を Date に戻す", async () => {
    const client = freshClient();
    client.setQueryData(queryKeys.walletTimeEvents(A), [
      { event_id: "e1", triggerAt: "2026-10-01T00:00:00.000Z" },
    ]);
    const { result } = renderHook(() => useWalletTimeEvents(A), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data![0]!.triggerAt).toBeInstanceOf(Date);
    expect(result.current.data![0]!.triggerAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    client.clear();
  });

  describe("usePortfolioHistory の placeholder は wallet を跨がない", () => {
    const point = (sol: string) => ({
      points: [{ at: 1, usd: "1", sol }],
      oldest_at: 1,
      approximated_symbols: [],
    });

    it("同じ wallet の range 切替は前の range のチャートを出し続ける", async () => {
      jest
        .spyOn(api, "getPortfolioHistory")
        .mockImplementation((_w, days) =>
          days === 30 ? Promise.resolve(point("A30")) : new Promise(() => {})
        );
      const { result, rerender } = renderHook(
        ({ address, days }: { address: string; days: number }) =>
          usePortfolioHistory(address, days),
        {
          wrapper: makeWrapper(freshClient()),
          initialProps: { address: A, days: 30 },
        }
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      rerender({ address: A, days: 90 });
      expect(result.current.isPlaceholderData).toBe(true);
      expect(result.current.data?.points[0]?.sol).toBe("A30");
    });

    it("別 wallet への切替では前の wallet のチャートを出さない", async () => {
      jest
        .spyOn(api, "getPortfolioHistory")
        .mockImplementation((w) =>
          w === A ? Promise.resolve(point("A30")) : new Promise(() => {})
        );
      const { result, rerender } = renderHook(
        ({ address, days }: { address: string; days: number }) =>
          usePortfolioHistory(address, days),
        {
          wrapper: makeWrapper(freshClient()),
          initialProps: { address: A, days: 30 },
        }
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      rerender({ address: B, days: 30 });
      expect(result.current.isPlaceholderData).toBe(false);
      expect(result.current.data).toBeUndefined();
    });
  });
});
