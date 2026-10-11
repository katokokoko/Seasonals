/**
 * services/queries — onchain build の enabled 判定 (API 効率化計画 Phase A-1 / §4.0)
 *
 * jest は USE_ONCHAIN=false (fixture variant) なので、ここだけ config を mock して
 * onchain build を再現する。IS_TEST_ENV は true のまま (HTTP は撃たず fixture path)。
 *   - 未接続の usePositions(null) は BFF `/positions` (常に []) を撃たない
 *   - useTimeEvents (fixture の /time-events) は撃たない
 *   - 接続中の usePositions(address) は従来どおり取得する
 */
jest.mock("./config", () => ({
  ...jest.requireActual("./config"),
  USE_ONCHAIN: true,
}));

import React, { type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";

import { usePositions, useTimeEvents } from "./queries";
import { createQueryClient } from "./queryClient";
import * as api from "./api";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";

/** テストごとに fresh な client (wrapper の再 render で作り直さない) */
function makeWrapper() {
  const client = createQueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 5_000 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("onchain build の enabled", () => {
  it("未接続の usePositions(null) は取得しない", async () => {
    const spy = jest.spyOn(api, "getPositions");
    const { result } = renderHook(() => usePositions(null), { wrapper: makeWrapper() });
    await Promise.resolve();
    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("useTimeEvents は取得しない (onchain の calendar は wallet events と SKR だけ)", async () => {
    const spy = jest.spyOn(api, "getTimeEvents");
    const { result } = renderHook(() => useTimeEvents(), { wrapper: makeWrapper() });
    await Promise.resolve();
    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("接続中の usePositions(address) は取得する", async () => {
    const spy = jest.spyOn(api, "getPositions");
    const { result } = renderHook(() => usePositions(A), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(A, expect.any(AbortSignal));
  });
});
