/**
 * SKR cooldown の mobile data layer (docs/skr-r0-implementation.md §3、R0-06)
 * - fixture に fallback しない (test 環境でも fetch を呼ぶ)
 * - 10 秒 abort、不正 body / 別 scope / slot 後退は error で旧値を保持 (= stale)
 * - refetch (tap / 手動 refresh) は HTTP を再取得する
 * - wallet 切替で旧 wallet の応答を表示しない
 */
import React, { type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import {
  FIXTURE_SKR_WALLET,
  fixtureCooldownStateCoolingDown,
  fixtureCooldownStateDemoCoolingDown,
  fixtureCooldownStateUnavailable,
} from "@workspace/lib/__fixtures__";
import type { CooldownStateResponse } from "@workspace/lib/types";

import { BffError, getSkrStakingState, SKR_STATE_TIMEOUT_MS } from "./api";
import { BFF_BASE_URL } from "./config";
import { queryKeys, useSkrStakingState } from "./queries";
import { createQueryClient } from "./queryClient";
import { useSkrStakingView } from "./useSkrStakingView";
import { WALLET_SCOPED_QUERY_KEYS } from "./wallet-query-sync";

const W = FIXTURE_SKR_WALLET;
const OTHER = "9hQpJ4xRwY7nKsT2bGvCmHdEq6jPzN5fLrXk3aBoMyVc";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

function freshClient(): QueryClient {
  return createQueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5_000 } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function withSlot(s: CooldownStateResponse, slot: number): CooldownStateResponse {
  return { ...s, slot };
}

describe("getSkrStakingState", () => {
  it("BFF を no-store で読み、test 環境でも fixture に fallback しない", async () => {
    fetchMock.mockResolvedValue(okResponse(fixtureCooldownStateCoolingDown));
    const out = await getSkrStakingState(W, "live");
    expect(out).toEqual(fixtureCooldownStateCoolingDown);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BFF_BASE_URL}/protocols/skr-staking/state?wallet=${W}&source=live`);
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeDefined();
  });

  it("通信失敗は throw (fixture / demo で埋めない)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await expect(getSkrStakingState(W, "live")).rejects.toThrow("Network request failed");
  });

  it("10 秒で abort する", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
          );
        })
    );
    const p = getSkrStakingState(W, "live");
    jest.advanceTimersByTime(SKR_STATE_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("HTTP 400 は BFF の error code を持つ BffError", async () => {
    fetchMock.mockResolvedValue(errResponse(400, { error: "invalid_wallet_address" }));
    await expect(getSkrStakingState(W, "live")).rejects.toMatchObject({
      name: "BffError",
      code: "invalid_wallet_address",
    });
  });

  it("不正な body は invalid_skr_state_response", async () => {
    fetchMock.mockResolvedValue(okResponse({ ...fixtureCooldownStateCoolingDown, schema_version: 2 }));
    await expect(getSkrStakingState(W, "live")).rejects.toMatchObject({ code: "invalid_skr_state_response" });
  });

  it("要求と違う wallet / source の応答は skr_scope_mismatch", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ...fixtureCooldownStateCoolingDown, wallet_address: OTHER }));
    await expect(getSkrStakingState(W, "live")).rejects.toBeInstanceOf(BffError);
    fetchMock.mockResolvedValueOnce(okResponse(fixtureCooldownStateDemoCoolingDown));
    await expect(getSkrStakingState(W, "live")).rejects.toMatchObject({ code: "skr_scope_mismatch" });
  });
});

describe("useSkrStakingState", () => {
  it("query key は source / cluster / wallet を含み、wallet 切替の対象", () => {
    expect(queryKeys.skrStakingState("live", "mainnet-beta", W)).toEqual(["skr-staking", "live", "mainnet-beta", W]);
    expect(WALLET_SCOPED_QUERY_KEYS).toContain("skr-staking");
  });

  it("未接続 (address null) は fetch しない", async () => {
    const client = freshClient();
    const { result } = renderHook(() => useSkrStakingState(null), { wrapper: wrapperFor(client) });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetch (tap / 手動 refresh) は HTTP を再取得する", async () => {
    fetchMock.mockResolvedValue(okResponse(fixtureCooldownStateCoolingDown));
    const client = freshClient();
    const { result } = renderHook(() => useSkrStakingState(W), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(queryKeys.skrStakingState("live", "mainnet-beta", W))).toEqual(fixtureCooldownStateCoolingDown);
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("slot が後退した応答で上書きしない (旧値を残して error)", async () => {
    const base = fixtureCooldownStateCoolingDown;
    fetchMock
      .mockResolvedValueOnce(okResponse(withSlot(base, base.slot! + 10)))
      .mockResolvedValueOnce(okResponse(withSlot(base, base.slot! + 5)));
    const client = freshClient();
    const { result } = renderHook(() => useSkrStakingState(W), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("skr_slot_regression");
    expect(result.current.data?.slot).toBe(base.slot! + 10);
  });

  it("fresh を持っている時の unavailable は上書きしない (取消済みと解釈しない)", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(fixtureCooldownStateCoolingDown))
      .mockResolvedValueOnce(okResponse(fixtureCooldownStateUnavailable));
    const client = freshClient();
    const { result } = renderHook(() => useSkrStakingState(W), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.error?.message).toBe("skr_not_fresh"));
    expect(result.current.data?.events).toHaveLength(1);
  });
});

describe("useSkrStakingView (R0-06 鮮度・scope)", () => {
  it("取得直後は fresh、再取得失敗で stale (旧値は残す)", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(fixtureCooldownStateCoolingDown))
      .mockRejectedValueOnce(new TypeError("Network request failed"));
    const client = freshClient();
    const { result } = renderHook(() => useSkrStakingView(W), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.freshness).toBe("fresh"));
    expect(result.current.scope).toEqual({ source: "live", cluster: "mainnet-beta", wallet_address: W });
    expect(result.current.observedAt).toBe(fixtureCooldownStateCoolingDown.observed_at);
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.freshness).toBe("stale"));
    expect(result.current.state?.events).toHaveLength(1);
  });

  it("初回から失敗なら unavailable (fixture を出さない)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    const client = freshClient();
    const { result } = renderHook(() => useSkrStakingView(W), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.freshness).toBe("unavailable"));
    expect(result.current.state).toBeUndefined();
  });

  it("wallet を切り替えたら旧 wallet の応答を表示しない", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes(W) ? okResponse(fixtureCooldownStateCoolingDown) : new Promise(() => {})
    );
    const client = freshClient();
    const { result, rerender } = renderHook(({ addr }: { addr: string | null }) => useSkrStakingView(addr), {
      wrapper: wrapperFor(client),
      initialProps: { addr: W as string | null },
    });
    await waitFor(() => expect(result.current.freshness).toBe("fresh"));
    rerender({ addr: OTHER });
    expect(result.current.address).toBe(OTHER);
    expect(result.current.state).toBeUndefined();
    expect(result.current.freshness).toBe("loading");
    rerender({ addr: null });
    expect(result.current.state).toBeUndefined();
    expect(result.current.scope).toBeNull();
  });
});
