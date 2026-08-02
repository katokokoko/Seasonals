/**
 * walletStore — テスト
 *
 * mwa.ts は完全に mock し、store の状態遷移と error handling を検証する。
 * persist (expo-secure-store) は jest.setup.js で in-memory mock 済。
 */

import * as SecureStore from "expo-secure-store";

import { useWalletStore } from "./walletStore";
import * as mwa from "./mwa";
import type { ConnectedAuthorization } from "./mwa";

jest.mock("./mwa", () => ({
  __esModule: true,
  connectWallet: jest.fn(),
  reauthorizeWallet: jest.fn(),
  disconnectWallet: jest.fn(),
  DEFAULT_IDENTITY: { name: "Seasonals", uri: "https://x", icon: "i" },
}));

const mockedMwa = mwa as jest.Mocked<typeof mwa>;

const FAKE_AUTH: ConnectedAuthorization = {
  address: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  label: "Phantom Account",
  authToken: "tok_abc",
  walletUriBase: null,
  chain: "solana:devnet",
};

const FAKE_AUTH_REFRESHED: ConnectedAuthorization = {
  ...FAKE_AUTH,
  authToken: "tok_refreshed",
};

beforeEach(() => {
  jest.clearAllMocks();
  // store を毎テスト初期化 (Zustand はモジュールスコープで生きている)
  useWalletStore.getState().reset();
});

describe("walletStore — 初期状態", () => {
  it("authorization=null / status=idle / error=null", () => {
    const s = useWalletStore.getState();
    expect(s.authorization).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.error).toBeNull();
  });
});

describe("connect", () => {
  it("成功すると authorization セット + status=connected", async () => {
    mockedMwa.connectWallet.mockResolvedValue(FAKE_AUTH);

    await useWalletStore.getState().connect();

    const s = useWalletStore.getState();
    expect(s.status).toBe("connected");
    expect(s.authorization).toEqual(FAKE_AUTH);
    expect(s.error).toBeNull();
  });

  it("opts を connectWallet にそのまま渡す", async () => {
    mockedMwa.connectWallet.mockResolvedValue(FAKE_AUTH);
    const opts = {
      chain: "solana:mainnet" as const,
      identity: { name: "X", uri: "u", icon: "i" },
    };
    await useWalletStore.getState().connect(opts);
    expect(mockedMwa.connectWallet).toHaveBeenCalledWith(opts);
  });

  it("失敗すると status=error + error メッセージ + throw", async () => {
    mockedMwa.connectWallet.mockRejectedValue(new Error("user_cancelled"));

    await expect(useWalletStore.getState().connect()).rejects.toThrow(
      "user_cancelled"
    );

    const s = useWalletStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("user_cancelled");
    expect(s.authorization).toBeNull();
  });

  it("connecting 中の中間状態を経由する", async () => {
    let resolveConn: (a: ConnectedAuthorization) => void = () => undefined;
    mockedMwa.connectWallet.mockImplementation(
      () => new Promise((r) => (resolveConn = r))
    );

    const promise = useWalletStore.getState().connect();
    expect(useWalletStore.getState().status).toBe("connecting");
    resolveConn(FAKE_AUTH);
    await promise;
    expect(useWalletStore.getState().status).toBe("connected");
  });
});

describe("disconnect", () => {
  it("接続中の auth は deauthorize → authorization clear + status=idle", async () => {
    mockedMwa.connectWallet.mockResolvedValue(FAKE_AUTH);
    await useWalletStore.getState().connect();
    mockedMwa.disconnectWallet.mockResolvedValue();

    await useWalletStore.getState().disconnect();

    expect(mockedMwa.disconnectWallet).toHaveBeenCalledWith(FAKE_AUTH);
    const s = useWalletStore.getState();
    expect(s.authorization).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("deauthorize が失敗しても local 状態は clear される", async () => {
    mockedMwa.connectWallet.mockResolvedValue(FAKE_AUTH);
    await useWalletStore.getState().connect();
    mockedMwa.disconnectWallet.mockRejectedValue(new Error("already_revoked"));

    await useWalletStore.getState().disconnect();

    expect(useWalletStore.getState().authorization).toBeNull();
    expect(useWalletStore.getState().status).toBe("idle");
  });

  it("auth が無い状態で disconnect しても安全 (no-op + idle)", async () => {
    await useWalletStore.getState().disconnect();
    expect(mockedMwa.disconnectWallet).not.toHaveBeenCalled();
    expect(useWalletStore.getState().status).toBe("idle");
  });
});

describe("reauthorize", () => {
  it("auth が無い場合は no-op (transact を呼ばない)", async () => {
    await useWalletStore.getState().reauthorize();
    expect(mockedMwa.reauthorizeWallet).not.toHaveBeenCalled();
    expect(useWalletStore.getState().status).toBe("idle");
  });

  it("成功すると refreshed authorization にすり替わる", async () => {
    mockedMwa.connectWallet.mockResolvedValue(FAKE_AUTH);
    await useWalletStore.getState().connect();
    mockedMwa.reauthorizeWallet.mockResolvedValue(FAKE_AUTH_REFRESHED);

    await useWalletStore.getState().reauthorize();

    expect(mockedMwa.reauthorizeWallet).toHaveBeenCalledWith(FAKE_AUTH);
    const s = useWalletStore.getState();
    expect(s.status).toBe("connected");
    expect(s.authorization?.authToken).toBe("tok_refreshed");
  });

  it("失敗すると authorization clear + status=error", async () => {
    mockedMwa.connectWallet.mockResolvedValue(FAKE_AUTH);
    await useWalletStore.getState().connect();
    mockedMwa.reauthorizeWallet.mockRejectedValue(new Error("auth_revoked"));

    await useWalletStore.getState().reauthorize();

    const s = useWalletStore.getState();
    expect(s.authorization).toBeNull();
    expect(s.status).toBe("error");
    expect(s.error).toBe("auth_revoked");
  });
});

describe("rehydrate — 再起動後の復元 (8.67)", () => {
  const seed = async (payload: unknown) =>
    SecureStore.setItemAsync(
      "seasonals.wallet.v1",
      JSON.stringify({ state: payload, version: 0 })
    );

  it("保存済 authorization があれば status=connected で戻る", async () => {
    // persist は authorization だけを保存する (status は session-only)。
    // 復元後に status を戻さないと、画面ごとに接続状態の判定が割れる
    await seed({ authorization: FAKE_AUTH });
    await useWalletStore.persist.rehydrate();

    const s = useWalletStore.getState();
    expect(s.authorization).toEqual(FAKE_AUTH);
    expect(s.status).toBe("connected");
    // wallet アプリを立ち上げる reauthorize は起動時に呼ばない
    expect(mockedMwa.reauthorizeWallet).not.toHaveBeenCalled();
  });

  it("保存が無い / authorization=null なら idle のまま (connected を騙らない)", async () => {
    await SecureStore.deleteItemAsync("seasonals.wallet.v1");
    await useWalletStore.persist.rehydrate();
    expect(useWalletStore.getState().status).toBe("idle");

    await seed({ authorization: null });
    await useWalletStore.persist.rehydrate();
    const s = useWalletStore.getState();
    expect(s.authorization).toBeNull();
    expect(s.status).toBe("idle");
  });
});

describe("reset", () => {
  it("authorization / status / error を初期値に戻す", async () => {
    mockedMwa.connectWallet.mockResolvedValue(FAKE_AUTH);
    await useWalletStore.getState().connect();
    expect(useWalletStore.getState().authorization).not.toBeNull();

    useWalletStore.getState().reset();

    const s = useWalletStore.getState();
    expect(s.authorization).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.error).toBeNull();
  });
});
