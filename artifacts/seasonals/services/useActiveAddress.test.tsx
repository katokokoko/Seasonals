/**
 * useActiveAddress — walletStore と watch store の合成 hook (watch-only mode)
 *
 * jest は USE_ONCHAIN=false なので config を mock して onchain build を再現する
 * (queries-onchain.test.tsx と同じ)。MWA は呼ばれない前提で mock だけ置く。
 */
jest.mock("./config", () => ({
  ...jest.requireActual("./config"),
  USE_ONCHAIN: true,
}));

jest.mock("./mwa", () => ({
  __esModule: true,
  connectWallet: jest.fn(),
  reauthorizeWallet: jest.fn(),
  disconnectWallet: jest.fn(),
  DEFAULT_IDENTITY: { name: "Seasonals", uri: "https://x", icon: "i" },
}));

import { act, renderHook } from "@testing-library/react-native";

import { useActiveAddress } from "./useActiveAddress";
import { useWalletStore } from "./walletStore";
import { connectWallet } from "./mwa";
import { useWatchStore } from "../stores/watch";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const W = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

afterEach(() => {
  act(() => {
    useWatchStore.getState().reset();
    useWalletStore.setState({ authorization: null, status: "idle" });
  });
});

describe("useActiveAddress", () => {
  it("未接続 + watch 無しは none", () => {
    const { result } = renderHook(() => useActiveAddress());
    expect(result.current).toEqual({ address: null, mode: "none", canSign: false });
  });

  it("watch address を足すと watch mode になり、MWA には触れない", () => {
    const { result } = renderHook(() => useActiveAddress());
    act(() => {
      useWatchStore.getState().addWatch(W);
    });
    expect(result.current).toEqual({ address: W, mode: "watch", canSign: false });
    expect(connectWallet).not.toHaveBeenCalled();
  });

  it("接続 wallet があれば watch より優先される", () => {
    const { result } = renderHook(() => useActiveAddress());
    act(() => {
      useWatchStore.getState().addWatch(W);
      useWalletStore.setState({
        authorization: {
          address: A,
          label: "Phantom Account",
          authToken: "tok",
          walletUriBase: null,
          chain: "solana:mainnet",
        },
        status: "connected",
      });
    });
    expect(result.current).toEqual({ address: A, mode: "connected", canSign: true });
  });
});
