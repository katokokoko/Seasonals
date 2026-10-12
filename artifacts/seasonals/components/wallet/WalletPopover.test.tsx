/**
 * WalletPopover — watch-only mode の入口 (web の WalletControl の移植)
 *
 *   - 不正 address はエラー表示で store を変えない
 *   - 正しい address は watchlist の先頭に入り選択される (popover は閉じる)
 *   - watch 中は Watching card / tag / "Stop watching" / "+ Add Wallet" の sublabel が変わる
 *   - row の select / remove
 *   - watch の操作は MWA (connectWallet) を一切呼ばない
 *   - fixture variant (USE_ONCHAIN=false) では watch section を出さない
 *
 * jest は USE_ONCHAIN=false なので config を getter 付きで mock して onchain build を再現する。
 */
let mockUseOnchain = true;
jest.mock("../../services/config", () => {
  const actual = jest.requireActual("../../services/config");
  // object spread は getter を定義時に 1 回評価して値に潰すので defineProperty で張る。
  // __esModule も残す (無いと babel の interop が値を copy して getter が効かない)
  const mocked = { ...actual, __esModule: true };
  Object.defineProperty(mocked, "USE_ONCHAIN", {
    enumerable: true,
    get: () => mockUseOnchain,
  });
  return mocked;
});
jest.mock("../../services/mwa", () => ({
  __esModule: true,
  connectWallet: jest.fn(),
  reauthorizeWallet: jest.fn(),
  disconnectWallet: jest.fn(),
  signTransactions: jest.fn(),
  DEFAULT_IDENTITY: { name: "Seasonals", uri: "https://x", icon: "i" },
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { WalletPopover } from "./WalletPopover";
import { connectWallet } from "../../services/mwa";
import { useWalletStore } from "../../services/walletStore";
import { useWatchStore } from "../../stores/watch";
import { useComingSoon } from "../../stores/comingSoon";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const W = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

function renderPopover(onClose = jest.fn()) {
  render(
    <WalletPopover visible anchorTop={80} onClose={onClose} testID="wp" />
  );
  return onClose;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseOnchain = true;
});

afterEach(() => {
  act(() => {
    useWatchStore.getState().reset();
    useWalletStore.getState().reset();
  });
});

describe("WalletPopover — watch-only mode", () => {
  it("不正な address はエラーを出し、watchlist を変えない", () => {
    const onClose = renderPopover();
    fireEvent.changeText(screen.getByTestId("wp-watch-input"), "not-an-address");
    fireEvent.press(screen.getByTestId("wp-watch-submit"));
    expect(screen.getByTestId("wp-watch-error")).toBeTruthy();
    expect(screen.getByText("Enter a valid Solana address.")).toBeTruthy();
    expect(useWatchStore.getState().watchlist).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(connectWallet).not.toHaveBeenCalled();
  });

  it("正しい address (前後の空白は trim) を watch すると選択されて閉じる。MWA は呼ばない", () => {
    const onClose = renderPopover();
    fireEvent.changeText(screen.getByTestId("wp-watch-input"), `  ${W}\n`);
    fireEvent.press(screen.getByTestId("wp-watch-submit"));
    expect(useWatchStore.getState()).toMatchObject({ watchlist: [W], selected: W });
    expect(onClose).toHaveBeenCalled();
    expect(connectWallet).not.toHaveBeenCalled();
  });

  it("watch 中は Watching card と tag、sublabel、Stop watching を出す", () => {
    useWatchStore.getState().addWatch(W);
    renderPopover();
    expect(screen.getByTestId("wp-watching")).toBeTruthy();
    expect(screen.getByText("Watching (read-only)")).toBeTruthy();
    expect(screen.getByText("watching")).toBeTruthy();
    // card の label と "+ Add Wallet" の sublabel
    expect(screen.getAllByText("Connect a wallet to sign")).toHaveLength(2);

    fireEvent.press(screen.getByTestId("wp-stop-watching"));
    expect(useWatchStore.getState()).toMatchObject({ watchlist: [W], selected: null });
    expect(connectWallet).not.toHaveBeenCalled();
  });

  it("row の tap で選択、× で watchlist から外す", () => {
    useWatchStore.getState().addWatch(W);
    useWatchStore.getState().addWatch(A); // [A, W]、selected A
    renderPopover();
    fireEvent.press(screen.getByTestId(`wp-watch-row-${W}`));
    expect(useWatchStore.getState().selected).toBe(W);

    fireEvent.press(screen.getByTestId(`wp-watch-remove-${A}`));
    expect(useWatchStore.getState().watchlist).toEqual([W]);
    expect(connectWallet).not.toHaveBeenCalled();
  });

  it("接続中に watch を足すと toast で『切断時に表示』を伝える (接続 wallet が優先)", () => {
    act(() => {
      useWalletStore.setState({
        authorization: {
          address: A,
          label: "Phantom",
          authToken: "tok",
          walletUriBase: null,
          chain: "solana:mainnet",
        },
        status: "connected",
      });
    });
    const show = jest.spyOn(useComingSoon.getState(), "show");
    renderPopover();
    fireEvent.changeText(screen.getByTestId("wp-watch-input"), W);
    fireEvent.press(screen.getByTestId("wp-watch-submit"));
    expect(show).toHaveBeenCalledWith(
      "Added to watchlist — shown when you disconnect"
    );
    // 接続 wallet があるので Watching card は出ない
    expect(screen.queryByTestId("wp-watching")).toBeNull();
    expect(connectWallet).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it("fixture variant (USE_ONCHAIN=false) では watch section を出さない", () => {
    mockUseOnchain = false;
    useWatchStore.getState().addWatch(W);
    renderPopover();
    expect(screen.queryByTestId("wp-watch-input")).toBeNull();
    expect(screen.queryByTestId("wp-watching")).toBeNull();
    expect(screen.queryByTestId(`wp-watch-row-${W}`)).toBeNull();
  });
});
