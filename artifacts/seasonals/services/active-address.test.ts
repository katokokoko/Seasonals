/**
 * resolveActiveAddress — 読み取り address / mode / canSign の合成 (watch-only mode)
 */
import { resolveActiveAddress } from "./active-address";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const W = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

const base = {
  useOnchain: true,
  connectedAddress: null,
  isConnected: false,
  watchAddress: null,
};

describe("resolveActiveAddress", () => {
  it("fixture variant (useOnchain=false) は接続 / watch に依らず none", () => {
    expect(
      resolveActiveAddress({
        ...base,
        useOnchain: false,
        connectedAddress: A,
        isConnected: true,
        watchAddress: W,
      })
    ).toEqual({ address: null, mode: "none", canSign: false });
  });

  it("接続 wallet があれば watch より優先 (connected、署名可)", () => {
    expect(
      resolveActiveAddress({
        ...base,
        connectedAddress: A,
        isConnected: true,
        watchAddress: W,
      })
    ).toEqual({ address: A, mode: "connected", canSign: true });
  });

  it("authorization はあるが status が connected でない間も connected 表示 (署名は不可)", () => {
    expect(
      resolveActiveAddress({ ...base, connectedAddress: A, isConnected: false })
    ).toEqual({ address: A, mode: "connected", canSign: false });
  });

  it("接続が無く watch address があれば watch (署名不可)", () => {
    expect(resolveActiveAddress({ ...base, watchAddress: W })).toEqual({
      address: W,
      mode: "watch",
      canSign: false,
    });
  });

  it("どちらも無ければ none", () => {
    expect(resolveActiveAddress(base)).toEqual({
      address: null,
      mode: "none",
      canSign: false,
    });
  });
});
