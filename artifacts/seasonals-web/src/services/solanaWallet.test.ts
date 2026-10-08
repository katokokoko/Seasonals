/**
 * solanaWallet — Wallet Standard の検出 / 接続 / 一括署名 / 拒否判定。
 */
import { act, renderHook } from "@testing-library/react";
import { fakeAccount, fakeSolanaWallet, fakeWalletsApi, signedMarker, SOL_OTHER, SOL_OWNER } from "../testing/fakeSolanaWallet";
import {
  _resetSolanaWalletsForTest,
  _setWalletsApiForTest,
  activeSolanaAddress,
  connectSolanaWallet,
  disconnectSolanaWallet,
  isSolanaStandardWallet,
  isSolanaUserRejection,
  onSolanaAccountsChanged,
  signSolanaTransactions,
  SolanaWalletError,
  useDetectedSolanaWallets,
} from "./solanaWallet";

afterEach(() => {
  _resetSolanaWalletsForTest();
  _setWalletsApiForTest(null);
});

function detect(api = fakeWalletsApi()) {
  _setWalletsApiForTest(api);
  const hook = renderHook(() => useDetectedSolanaWallets());
  return { api, hook };
}

test("Solana mainnet で connect と signTransaction を持つ wallet だけを並べ、名前で重複を除く", () => {
  const phantom = fakeSolanaWallet({ name: "Phantom" });
  const evmOnly = fakeSolanaWallet({ name: "MetaMask", chains: ["eip155:1"] });
  const dup = fakeSolanaWallet({ name: "Phantom" });
  const { hook, api } = detect(fakeWalletsApi([phantom, evmOnly]));
  expect(hook.result.current.map((w) => w.name)).toEqual(["Phantom"]);
  // 遅れて名乗った wallet も拾う (Phantom は page load 後に register することがある)
  act(() => {
    api.register(fakeSolanaWallet({ name: "Solflare" }), dup);
  });
  expect(hook.result.current.map((w) => w.name)).toEqual(["Phantom", "Solflare"]);
  expect(isSolanaStandardWallet(evmOnly)).toBe(false);
});

test("本物の getWallets() でも wallet-standard:register-wallet で名乗った wallet を拾う", () => {
  const solflare = fakeSolanaWallet({ name: "Solflare" });
  const hook = renderHook(() => useDetectedSolanaWallets());
  act(() => {
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", {
        detail: ({ register }: { register: (...w: unknown[]) => void }) => register(solflare),
      })
    );
  });
  expect(hook.result.current.map((w) => w.name)).toContain("Solflare");
});

test("connect は mainnet の base58 address を返し、silent を wallet に渡す", async () => {
  const w = fakeSolanaWallet();
  const { hook } = detect(fakeWalletsApi([w]));
  const address = await connectSolanaWallet(hook.result.current[0]!, { silent: true });
  expect(address).toBe(SOL_OWNER);
  expect(w.connectFn).toHaveBeenCalledWith({ silent: true });
  expect(activeSolanaAddress()).toBe(SOL_OWNER);
});

test("mainnet の account を返さない wallet は接続しない", async () => {
  const w = fakeSolanaWallet({ connect: async () => ({ accounts: [fakeAccount(SOL_OWNER, ["solana:devnet"])] }) });
  const { hook } = detect(fakeWalletsApi([w]));
  await expect(connectSolanaWallet(hook.result.current[0]!)).rejects.toMatchObject({ code: "no_account" });
  expect(activeSolanaAddress()).toBeNull();
});

test("wallet 側で account が切り替わる / 外れると通知する", async () => {
  const w = fakeSolanaWallet();
  const { hook } = detect(fakeWalletsApi([w]));
  await connectSolanaWallet(hook.result.current[0]!);
  const seen: Array<string | null> = [];
  onSolanaAccountsChanged((a) => seen.push(a));
  w.emitChange([fakeAccount(SOL_OTHER)]);
  expect(activeSolanaAddress()).toBe(SOL_OTHER);
  w.emitChange([]);
  expect(seen).toEqual([SOL_OTHER, null]);
  expect(activeSolanaAddress()).toBeNull();
});

test("disconnect は wallet の standard:disconnect も呼ぶ", async () => {
  const w = fakeSolanaWallet();
  const { hook } = detect(fakeWalletsApi([w]));
  await connectSolanaWallet(hook.result.current[0]!);
  await disconnectSolanaWallet();
  expect(w.disconnectFn).toHaveBeenCalledTimes(1);
  expect(activeSolanaAddress()).toBeNull();
});

describe("signSolanaTransactions", () => {
  async function connected(opts: Parameters<typeof fakeSolanaWallet>[0] = {}) {
    const w = fakeSolanaWallet(opts);
    const { hook } = detect(fakeWalletsApi([w]));
    await connectSolanaWallet(hook.result.current[0]!);
    return w;
  }
  const txs = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])];

  test("全 tx を 1 回の呼び出し (承認 1 回) で署名し、順番どおりに返す", async () => {
    const w = await connected();
    const out = await signSolanaTransactions(SOL_OWNER, txs);
    expect(w.signFn).toHaveBeenCalledTimes(1);
    expect(w.signFn.mock.calls[0]).toHaveLength(2);
    expect(w.signFn.mock.calls[0]![0]).toMatchObject({ chain: "solana:mainnet", transaction: txs[0] });
    expect(out).toEqual(txs.map(signedMarker));
  });

  test("接続 account と owner が違えば wallet を開かずに止める", async () => {
    const w = await connected();
    await expect(signSolanaTransactions(SOL_OTHER, txs)).rejects.toMatchObject({ code: "account_mismatch" });
    expect(w.signFn).not.toHaveBeenCalled();
  });

  test("v0 tx に対応しない wallet は wallet を開かずに止める", async () => {
    const w = await connected({ versions: ["legacy"] });
    await expect(signSolanaTransactions(SOL_OWNER, txs)).rejects.toMatchObject({ code: "unsupported_version" });
    expect(w.signFn).not.toHaveBeenCalled();
  });

  test("wallet が返した本数が足りなければ失敗にする", async () => {
    await connected({ sign: async (...inputs) => [{ signedTransaction: inputs[0]!.transaction }] });
    await expect(signSolanaTransactions(SOL_OWNER, txs)).rejects.toBeInstanceOf(SolanaWalletError);
  });

  test("未接続なら not_connected", async () => {
    await expect(signSolanaTransactions(SOL_OWNER, txs)).rejects.toMatchObject({ code: "not_connected" });
  });
});

test("拒否の判定: 4001 と、message だけの Error (Solflare / Backpack)", () => {
  expect(isSolanaUserRejection(Object.assign(new Error("x"), { code: 4001 }))).toBe(true);
  expect(isSolanaUserRejection(new Error("User rejected the request."))).toBe(true);
  expect(isSolanaUserRejection(new Error("Transaction cancelled"))).toBe(true);
  expect(isSolanaUserRejection(new Error("Blockhash not found"))).toBe(false);
});
