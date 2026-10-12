/**
 * useWalletQuerySync — hook の配線テスト (API 効率化計画 §4.0 / Phase A-4)
 *
 * 純判定は wallet-query-sync.test.ts。ここでは walletStore の遷移を実際に流して、
 *   - cold start の復元では invalidate しない (mount 時の取得と二重にしない)
 *   - 接続した wallet の key だけ invalidate し、他 wallet の保持 cache は触らない
 *   - 切断では何もしない
 *   - recentWallets から外れた wallet の cache と日次履歴を消す
 * を QueryClient の実 cache で確かめる。
 */
import React, { type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";

import { createQueryClient } from "./queryClient";
import { useWalletStore } from "./walletStore";
import { useWalletQuerySync } from "./useWalletQuerySync";
import type { ConnectedAuthorization } from "./mwa";
import { usePortfolioHistoryStore } from "../stores/portfolioHistory";
import { useWatchStore } from "../stores/watch";

jest.mock("./mwa", () => ({
  __esModule: true,
  connectWallet: jest.fn(),
  reauthorizeWallet: jest.fn(),
  disconnectWallet: jest.fn(),
  DEFAULT_IDENTITY: { name: "Seasonals", uri: "https://x", icon: "i" },
}));

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

const auth = (address: string): ConnectedAuthorization => ({
  address,
  label: "Phantom Account",
  authToken: "tok",
  walletUriBase: null,
  chain: "solana:mainnet",
});

function setup(): { qc: QueryClient; unmount: () => void } {
  const qc = createQueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 5_000 } },
  });
  for (const addr of [A, B]) {
    qc.setQueryData(["positions", addr], []);
    qc.setQueryData(["earn-positions", addr], {});
    qc.setQueryData(["wallet-time-events", addr], []);
    qc.setQueryData(["portfolio-history", addr, 30], { points: [] });
  }
  qc.setQueryData(["positions"], []);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { unmount } = renderHook(() => useWalletQuerySync(), { wrapper });
  return { qc, unmount };
}

const invalidatedOf = (qc: QueryClient, address: string | null) =>
  qc
    .getQueryCache()
    .getAll()
    .filter((q) => (address === null ? q.queryKey.length === 1 : q.queryKey[1] === address))
    .map((q) => q.state.isInvalidated);

beforeEach(() => {
  useWalletStore.getState().reset();
  useWatchStore.getState().reset();
  jest.restoreAllMocks();
});

describe("useWalletQuerySync", () => {
  it("cold start の復元 (復元完了前に mount → authorization と connected が同時に戻る) では invalidate しない", () => {
    jest.spyOn(useWalletStore.persist, "hasHydrated").mockReturnValue(false);
    let finish: (() => void) | null = null;
    jest
      .spyOn(useWalletStore.persist, "onFinishHydration")
      .mockImplementation((cb) => {
        finish = () => cb(useWalletStore.getState());
        return () => undefined;
      });
    const { qc, unmount } = setup();
    act(() => {
      // walletStore の merge と同じ 1 回の set
      useWalletStore.setState({
        authorization: auth(A),
        status: "connected",
        recentWallets: [{ address: A, lastConnectedAt: 1 }],
      });
      (useWalletStore.persist.hasHydrated as jest.Mock).mockReturnValue(true);
      finish?.();
    });
    expect(invalidatedOf(qc, A)).toEqual([false, false, false, false]);
    unmount();
    qc.clear();
  });

  it("接続した wallet の key だけ invalidate (他 wallet / fixture key は保持のまま)", () => {
    const { qc, unmount } = setup();
    act(() => {
      useWalletStore.setState({ status: "connecting" });
    });
    act(() => {
      useWalletStore.setState({
        authorization: auth(A),
        status: "connected",
        recentWallets: [{ address: A, lastConnectedAt: 1 }],
      });
    });
    expect(invalidatedOf(qc, A)).toEqual([true, true, true, true]);
    expect(invalidatedOf(qc, B)).toEqual([false, false, false, false]);
    expect(invalidatedOf(qc, null)).toEqual([false]);
    unmount();
    qc.clear();
  });

  it("切断では何もしない (cache は保持)", () => {
    useWalletStore.setState({ authorization: auth(A), status: "connected" });
    const { qc, unmount } = setup();
    act(() => {
      useWalletStore.setState({ authorization: null, status: "idle" });
    });
    expect(invalidatedOf(qc, A)).toEqual([false, false, false, false]);
    expect(qc.getQueryData(["positions", A])).toEqual([]);
    unmount();
    qc.clear();
  });

  it("recentWallets から外れた wallet の cache と日次履歴を消し、残る wallet は触らない", () => {
    const forget = jest.spyOn(usePortfolioHistoryStore.getState(), "forget");
    useWalletStore.setState({
      recentWallets: [
        { address: B, lastConnectedAt: 2 },
        { address: A, lastConnectedAt: 1 },
      ],
    });
    const { qc, unmount } = setup();
    act(() => {
      useWalletStore.setState({ recentWallets: [{ address: B, lastConnectedAt: 2 }] });
    });
    expect(qc.getQueryCache().getAll().some((q) => q.queryKey[1] === A)).toBe(false);
    expect(qc.getQueryCache().getAll().filter((q) => q.queryKey[1] === B)).toHaveLength(4);
    expect(forget).toHaveBeenCalledWith(A);
    unmount();
    qc.clear();
  });

  it("watch-only mode: watchlist から外した address の cache と日次履歴を消す", () => {
    const forget = jest.spyOn(usePortfolioHistoryStore.getState(), "forget");
    useWatchStore.getState().addWatch(A);
    useWatchStore.getState().addWatch(B);
    const { qc, unmount } = setup();
    act(() => {
      useWatchStore.getState().removeWatch(A);
    });
    expect(qc.getQueryCache().getAll().some((q) => q.queryKey[1] === A)).toBe(false);
    expect(qc.getQueryCache().getAll().filter((q) => q.queryKey[1] === B)).toHaveLength(4);
    expect(forget).toHaveBeenCalledWith(A);
    unmount();
    qc.clear();
  });

  it("watch-only mode: recentWallets に残る address は watchlist から外しても消さない", () => {
    useWalletStore.setState({ recentWallets: [{ address: A, lastConnectedAt: 1 }] });
    useWatchStore.getState().addWatch(A);
    const { qc, unmount } = setup();
    act(() => {
      useWatchStore.getState().removeWatch(A);
    });
    expect(qc.getQueryCache().getAll().filter((q) => q.queryKey[1] === A)).toHaveLength(4);
    unmount();
    qc.clear();
  });

  it("recentWallets から外れても watch 中の address の cache は残す", () => {
    useWalletStore.setState({
      recentWallets: [
        { address: B, lastConnectedAt: 2 },
        { address: A, lastConnectedAt: 1 },
      ],
    });
    useWatchStore.getState().addWatch(A);
    const { qc, unmount } = setup();
    act(() => {
      useWalletStore.setState({ recentWallets: [{ address: B, lastConnectedAt: 2 }] });
    });
    expect(qc.getQueryCache().getAll().filter((q) => q.queryKey[1] === A)).toHaveLength(4);
    unmount();
    qc.clear();
  });
});
