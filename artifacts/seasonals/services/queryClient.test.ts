/**
 * queryClient — 8.93 の復帰配線 (attachAppStateFocus / errorRetryInterval)。
 * NetInfo は入れない方針 (backlog §E.3.5) なので、復帰経路はこの 2 つ +
 * api.ts の onFail="throw" (api-fallback.test.ts) で全部。
 */
import {
  AppState,
  type AppStateStatus,
  type NativeEventSubscription,
} from "react-native";
import { focusManager } from "@tanstack/react-query";

import {
  DEFAULT_QUERY_OPTIONS,
  attachAppStateFocus,
} from "./queryClient";
import { errorRetryInterval } from "./queries";

describe("attachAppStateFocus (8.93)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    focusManager.setFocused(undefined); // default (managed) に戻す
  });

  it("AppState active/background を focusManager に反映し、cleanup で購読解除する", () => {
    let handler: ((state: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_type, fn) => {
        handler = fn;
        return { remove } as unknown as NativeEventSubscription;
      });

    const detach = attachAppStateFocus();
    expect(handler).toBeDefined();

    handler!("background");
    expect(focusManager.isFocused()).toBe(false);
    handler!("active");
    expect(focusManager.isFocused()).toBe(true);

    detach();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("refetchOnWindowFocus が default で有効 (配線とセット)", () => {
    expect(DEFAULT_QUERY_OPTIONS.defaultOptions?.queries?.refetchOnWindowFocus).toBe(
      true
    );
  });
});

describe("errorRetryInterval (8.93)", () => {
  it("error の時だけ 30 秒、それ以外はポーリングしない", () => {
    expect(errorRetryInterval({ state: { status: "error" } })).toBe(30_000);
    expect(errorRetryInterval({ state: { status: "success" } })).toBe(false);
    expect(errorRetryInterval({ state: { status: "pending" } })).toBe(false);
  });
});
