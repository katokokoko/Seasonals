/**
 * services/mwa — テスト
 *
 * `transact` を mock して MWA wrapper の正規化ロジックを検証:
 * - base64 → base58 address 変換
 * - default chain / identity の扱い
 * - reauthorize の auth_token / chain 受け渡し
 * - signTransactions / signMessages の前段 reauthorize 呼び出し
 *
 * 実機の MWA 通信は emulator で別途確認 (test 範囲外)。
 */

/**
 * @solana/web3.js は jest 環境で `rpc-websockets` resolve に失敗するため mock。
 * 本テストは services/mwa.ts の wrapper API contract (transact 経由の呼出 / 戻り値の
 * 正規化形 / option 受け渡し) を担保する。base64 ↔ base58 変換の正しさは
 * @solana/web3.js library 側でカバー済として trust する。
 */
jest.mock("@solana/web3.js", () => {
  // jest.mock factory は hoisting されるため、file scope const を参照できない。
  // fixture 値は factory 内に inline する (test 本体側の FIXTURE_BASE58 と一致させる)。
  const FIXTURE = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
  class MockPublicKey {
    constructor(input) {
      this._input = input;
    }
    toBase58() {
      if (typeof this._input === "string") return this._input;
      return FIXTURE;
    }
    toBytes() {
      return new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    }
  }
  return { PublicKey: MockPublicKey };
});

jest.mock("@solana-mobile/mobile-wallet-adapter-protocol-web3js", () => ({
  transact: jest.fn(),
}));

import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";

import {
  connectWallet,
  disconnectWallet,
  reauthorizeWallet,
  signMessages,
  signTransactions,
  DEFAULT_IDENTITY,
  type ConnectedAuthorization,
} from "./mwa";

// ─────────────────────────────────────────────────────────────────────────────
// Mock setup
// ─────────────────────────────────────────────────────────────────────────────

const transactMock = transact as jest.MockedFunction<typeof transact>;

const mockWallet = {
  authorize: jest.fn(),
  reauthorize: jest.fn(),
  deauthorize: jest.fn(),
  signTransactions: jest.fn(),
  signMessages: jest.fn(),
};

// fixture wallet (lib/__fixtures__/wallets.ts と同一 address)
const FIXTURE_BASE58 = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
// 任意の base64 input。mock の PublicKey は bytes input なら FIXTURE_BASE58 を返す
const FIXTURE_BASE64_INPUT = "Y4Z2v0NL30JLAxsuLg=="; // any valid-looking base64
// signMessages 経路で生成される base64 = MockPublicKey.toBytes() の base64 表現
const EXPECTED_BASE64_FROM_BYTES = Buffer.from(
  new Uint8Array([0x01, 0x02, 0x03, 0x04])
).toString("base64");

beforeEach(() => {
  transactMock.mockReset();
  Object.values(mockWallet).forEach((fn) => fn.mockReset());
  // default: transact が callback に mockWallet を渡す
  transactMock.mockImplementation(async (cb) =>
    // any cast: protocol type は厳しいが test では shape さえ合えばよい
    cb(mockWallet as unknown as Parameters<typeof cb>[0])
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// connectWallet
// ─────────────────────────────────────────────────────────────────────────────

describe("connectWallet", () => {
  it("authorize を呼んで base58 address に正規化", async () => {
    mockWallet.authorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT, label: "Phantom Account" }],
      auth_token: "tok_abc",
      wallet_uri_base: "https://phantom.app",
    });

    const auth = await connectWallet();

    expect(auth.address).toBe(FIXTURE_BASE58);
    expect(auth.label).toBe("Phantom Account");
    expect(auth.authToken).toBe("tok_abc");
    expect(auth.walletUriBase).toBe("https://phantom.app");
    expect(auth.chain).toBe("solana:devnet");
  });

  it("default chain は solana:devnet, identity は DEFAULT_IDENTITY", async () => {
    mockWallet.authorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT }],
      auth_token: "t",
      wallet_uri_base: null,
    });

    await connectWallet();

    expect(mockWallet.authorize).toHaveBeenCalledWith({
      chain: "solana:devnet",
      identity: DEFAULT_IDENTITY,
    });
  });

  it("opts.chain / identity の override が authorize に渡る", async () => {
    mockWallet.authorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT }],
      auth_token: "t",
      wallet_uri_base: null,
    });

    await connectWallet({
      chain: "solana:mainnet",
      identity: { name: "Custom", uri: "https://example.com", icon: "icon.png" },
    });

    expect(mockWallet.authorize).toHaveBeenCalledWith({
      chain: "solana:mainnet",
      identity: { name: "Custom", uri: "https://example.com", icon: "icon.png" },
    });
  });

  it("accounts[0] が無いと throw", async () => {
    mockWallet.authorize.mockResolvedValue({
      accounts: [],
      auth_token: "t",
      wallet_uri_base: null,
    });
    await expect(connectWallet()).rejects.toThrow("mwa_no_account_returned");
  });

  it("wallet_uri_base が null なら walletUriBase: null", async () => {
    mockWallet.authorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT }],
      auth_token: "t",
      wallet_uri_base: null,
    });
    const auth = await connectWallet();
    expect(auth.walletUriBase).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reauthorizeWallet
// ─────────────────────────────────────────────────────────────────────────────

describe("reauthorizeWallet", () => {
  const prev: ConnectedAuthorization = {
    address: FIXTURE_BASE58,
    label: null,
    authToken: "old_tok",
    walletUriBase: null,
    chain: "solana:devnet",
  };

  it("auth_token と identity を渡して reauthorize を呼ぶ", async () => {
    mockWallet.reauthorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT, label: null }],
      auth_token: "new_tok",
      wallet_uri_base: null,
    });

    const refreshed = await reauthorizeWallet(prev);

    expect(mockWallet.reauthorize).toHaveBeenCalledWith({
      auth_token: "old_tok",
      identity: DEFAULT_IDENTITY,
    });
    expect(refreshed.authToken).toBe("new_tok");
    expect(refreshed.chain).toBe("solana:devnet"); // prev.chain を継承
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disconnectWallet
// ─────────────────────────────────────────────────────────────────────────────

describe("disconnectWallet", () => {
  it("auth_token を渡して deauthorize を呼ぶ", async () => {
    mockWallet.deauthorize.mockResolvedValue(undefined);
    await disconnectWallet({
      address: FIXTURE_BASE58,
      label: null,
      authToken: "tok_to_revoke",
      walletUriBase: null,
      chain: "solana:devnet",
    });
    expect(mockWallet.deauthorize).toHaveBeenCalledWith({
      auth_token: "tok_to_revoke",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// signTransactions / signMessages
// ─────────────────────────────────────────────────────────────────────────────

describe("signTransactions", () => {
  const auth: ConnectedAuthorization = {
    address: FIXTURE_BASE58,
    label: null,
    authToken: "tok",
    walletUriBase: null,
    chain: "solana:devnet",
  };

  it("reauthorize 後に signTransactions を呼ぶ", async () => {
    mockWallet.reauthorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT }],
      auth_token: "tok",
      wallet_uri_base: null,
    });
    const fakeTxs = [{ tx: 1 }, { tx: 2 }];
    mockWallet.signTransactions.mockResolvedValue(fakeTxs);

    const out = await signTransactions(auth, fakeTxs as never[]);

    expect(mockWallet.reauthorize).toHaveBeenCalled();
    expect(mockWallet.signTransactions).toHaveBeenCalledWith({
      transactions: fakeTxs,
    });
    expect(out).toBe(fakeTxs);
  });
});

describe("signMessages", () => {
  const auth: ConnectedAuthorization = {
    address: FIXTURE_BASE58,
    label: null,
    authToken: "tok",
    walletUriBase: null,
    chain: "solana:devnet",
  };

  it("addresses は base64 で渡される (base58→base64 変換)", async () => {
    mockWallet.reauthorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT }],
      auth_token: "tok",
      wallet_uri_base: null,
    });
    const payloads = [new Uint8Array([1, 2, 3])];
    mockWallet.signMessages.mockResolvedValue(payloads);

    await signMessages(auth, payloads);

    expect(mockWallet.signMessages).toHaveBeenCalledWith({
      addresses: [EXPECTED_BASE64_FROM_BYTES],
      payloads,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.76: baseUri (接続済み wallet を直接開く / Android チューザー抑止)
// ─────────────────────────────────────────────────────────────────────────────

describe("8.76: transact への baseUri 透過", () => {
  const PHANTOM = "https://phantom.app";
  const authWithBase: ConnectedAuthorization = {
    address: FIXTURE_BASE58,
    label: null,
    authToken: "tok",
    walletUriBase: PHANTOM,
    chain: "solana:devnet",
  };

  beforeEach(() => {
    mockWallet.reauthorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT }],
      auth_token: "tok",
      wallet_uri_base: PHANTOM,
    });
  });

  it("signTransactions は walletUriBase を { baseUri } で渡す", async () => {
    const txs = [{ tx: 1 }];
    mockWallet.signTransactions.mockResolvedValue(txs);
    await signTransactions(authWithBase, txs as never[]);
    expect(transactMock).toHaveBeenCalledWith(expect.any(Function), {
      baseUri: PHANTOM,
    });
  });

  it("signMessages / disconnectWallet / reauthorizeWallet も同様", async () => {
    mockWallet.signMessages.mockResolvedValue([new Uint8Array([1])]);
    await signMessages(authWithBase, [new Uint8Array([1])]);
    expect(transactMock).toHaveBeenLastCalledWith(expect.any(Function), {
      baseUri: PHANTOM,
    });

    mockWallet.deauthorize.mockResolvedValue(undefined);
    await disconnectWallet(authWithBase);
    expect(transactMock).toHaveBeenLastCalledWith(expect.any(Function), {
      baseUri: PHANTOM,
    });

    await reauthorizeWallet(authWithBase);
    expect(transactMock).toHaveBeenLastCalledWith(expect.any(Function), {
      baseUri: PHANTOM,
    });
  });

  it("walletUriBase が null なら第 2 引数を渡さない (従来挙動 = OS チューザー)", async () => {
    const txs = [{ tx: 1 }];
    mockWallet.signTransactions.mockResolvedValue(txs);
    await signTransactions(
      { ...authWithBase, walletUriBase: null },
      txs as never[]
    );
    expect(transactMock.mock.calls[0]!.length).toBe(1);
  });

  it("connectWallet は picker で選ばれた opts.baseUri を透過する", async () => {
    mockWallet.authorize.mockResolvedValue({
      accounts: [{ address: FIXTURE_BASE64_INPUT }],
      auth_token: "t",
      wallet_uri_base: PHANTOM,
    });
    await connectWallet({ baseUri: "https://solflare.com" });
    expect(transactMock).toHaveBeenCalledWith(expect.any(Function), {
      baseUri: "https://solflare.com",
    });
  });

  it("ERROR_WALLET_NOT_FOUND なら素の transact (チューザー) に fallback して結果を返す", async () => {
    const txs = [{ tx: 1 }];
    mockWallet.signTransactions.mockResolvedValue(txs);
    transactMock
      .mockRejectedValueOnce(
        Object.assign(new Error("wallet not found"), {
          code: "ERROR_WALLET_NOT_FOUND",
        })
      )
      .mockImplementationOnce(async (cb) =>
        cb(mockWallet as unknown as Parameters<typeof cb>[0])
      );

    const out = await signTransactions(authWithBase, txs as never[]);

    expect(out).toBe(txs);
    expect(transactMock).toHaveBeenCalledTimes(2);
    expect(transactMock.mock.calls[0]![1]).toEqual({ baseUri: PHANTOM });
    expect(transactMock.mock.calls[1]!.length).toBe(1); // fallback は config なし
  });

  it("wallet-not-found 以外のエラーは fallback せずそのまま throw", async () => {
    transactMock.mockRejectedValueOnce(new Error("user declined"));
    await expect(
      signTransactions(authWithBase, [{ tx: 1 }] as never[])
    ).rejects.toThrow("user declined");
    expect(transactMock).toHaveBeenCalledTimes(1);
  });
});
