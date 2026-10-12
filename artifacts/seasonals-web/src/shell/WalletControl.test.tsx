/**
 * WalletControl — 検出した wallet を並べ、選んだ wallet の address で接続する。
 */
import { vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { _resetWalletsForTest } from "../services/evmWallet";
import { _resetSolanaWalletsForTest, _setWalletsApiForTest } from "../services/solanaWallet";
import { fakeSolanaWallet, fakeWalletsApi, SOL_OWNER } from "../testing/fakeSolanaWallet";
import { useSession } from "../state/session";
import { WalletControl } from "./WalletControl";

const MM = "0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11";
const OKX = "0x2222222222222222222222222222222222222222";
const ICON = "data:image/svg+xml;base64,PHN2Zy8+";

function announce(rdns: string, name: string, icon: string, request: (args: { method: string }) => Promise<unknown>) {
  const provider = { request: vi.fn(request), on: vi.fn(), removeListener: vi.fn() };
  const handler = () =>
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: rdns, name, icon, rdns }, provider } }));
  window.addEventListener("eip6963:requestProvider", handler);
  cleanups.push(() => window.removeEventListener("eip6963:requestProvider", handler));
  return provider;
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  useSession.setState({ watchlist: [], connected: {}, lastSolanaWallet: null });
  _setWalletsApiForTest(fakeWalletsApi());
});
afterEach(() => {
  // 先に unmount してから store を空にする (act 外の更新にしない)
  cleanup();
  for (const c of cleanups.splice(0)) c();
  _resetWalletsForTest();
  _resetSolanaWalletsForTest();
  _setWalletsApiForTest(null);
});

function openPopover() {
  render(<WalletControl />);
  fireEvent.click(screen.getByRole("button", { name: /Connect wallet/ }));
}

test("検出した wallet を全部並べ、選んだ wallet の address で接続する", async () => {
  const mm = announce("io.metamask", "MetaMask", ICON, async () => [MM]);
  const okx = announce("com.okex.wallet", "OKX Wallet", ICON, async () => [OKX]);
  openPopover();
  const list = screen.getByRole("list", { name: "Detected wallets" });
  expect(list.textContent).toContain("MetaMask");
  expect(list.textContent).toContain("OKX Wallet");

  fireEvent.click(screen.getByRole("button", { name: /MetaMask/ }));
  await waitFor(() => expect(useSession.getState().connected.ethereum?.address).toBe(MM));
  expect(useSession.getState().connected.ethereum?.wallet).toMatchObject({ name: "MetaMask", rdns: "io.metamask" });
  expect(okx.request).not.toHaveBeenCalled();
  expect(mm.request).toHaveBeenCalledTimes(1);
  // 接続した wallet の行に connected が付く
  expect(screen.getByRole("button", { name: /MetaMask/ }).className).toContain("is-connected");
});

test("wallet 側で拒否されたら、その wallet 名で伝える", async () => {
  announce("io.metamask", "MetaMask", ICON, async () => {
    throw Object.assign(new Error("User rejected the request."), { code: 4001 });
  });
  openPopover();
  fireEvent.click(screen.getByRole("button", { name: /MetaMask/ }));
  expect((await screen.findByRole("alert")).textContent).toBe("Request was rejected in MetaMask.");
  expect(useSession.getState().connected.ethereum).toBeUndefined();
});

test("data:image/ 以外の icon は表示しない (汎用 icon に置き換える)", () => {
  announce("io.metamask", "MetaMask", ICON, async () => [MM]);
  announce("example.bad", "Bad Wallet", "https://evil.example/x.png", async () => [OKX]);
  openPopover();
  const imgs = [...document.querySelectorAll<HTMLImageElement>(".wallet-choice img")].map((i) => i.getAttribute("src"));
  expect(imgs).toEqual([ICON]);
  expect(screen.getByRole("button", { name: /Bad Wallet/ }).querySelector("svg.wallet-icon")).toBeTruthy();
});

test("wallet が 1 つも無ければ、その旨と watch を案内する", () => {
  openPopover();
  expect(screen.getByText(/No browser wallet detected/)).toBeTruthy();
});

describe("Solana (Wallet Standard)", () => {
  test("検出した Solana wallet を並べ、選ぶと base58 address で接続する", async () => {
    const phantom = fakeSolanaWallet({ name: "Phantom" });
    _setWalletsApiForTest(fakeWalletsApi([phantom, fakeSolanaWallet({ name: "Solflare" })]));
    openPopover();
    const list = screen.getByRole("list", { name: "Detected Solana wallets" });
    expect(list.textContent).toContain("Phantom");
    expect(list.textContent).toContain("Solflare");
    fireEvent.click(screen.getByRole("button", { name: /Phantom/ }));
    await waitFor(() => expect(useSession.getState().connected.solana?.address).toBe(SOL_OWNER));
    expect(useSession.getState().lastSolanaWallet).toBe("Phantom");
    expect(phantom.connectFn).toHaveBeenCalledWith(undefined);
  });

  test("reload 後は前回の wallet に silent で 1 回だけ戻す", async () => {
    const phantom = fakeSolanaWallet({ name: "Phantom" });
    useSession.setState({ lastSolanaWallet: "Phantom" });
    _setWalletsApiForTest(fakeWalletsApi([phantom]));
    render(<WalletControl />);
    await waitFor(() => expect(useSession.getState().connected.solana?.address).toBe(SOL_OWNER));
    expect(phantom.connectFn).toHaveBeenCalledTimes(1);
    expect(phantom.connectFn).toHaveBeenCalledWith({ silent: true });
  });

  test("Solana wallet で拒否されたら、その wallet 名で伝える", async () => {
    _setWalletsApiForTest(
      fakeWalletsApi([
        fakeSolanaWallet({
          name: "Solflare",
          connect: async () => {
            throw new Error("User rejected the request");
          },
        }),
      ])
    );
    openPopover();
    fireEvent.click(screen.getByRole("button", { name: /Solflare/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Request was rejected in Solflare.");
    expect(useSession.getState().connected.solana).toBeUndefined();
  });

  test("接続中の Solana address を外すと wallet 側も切断し、silent 再接続の記録も消す", async () => {
    const phantom = fakeSolanaWallet({ name: "Phantom" });
    _setWalletsApiForTest(fakeWalletsApi([phantom]));
    openPopover();
    fireEvent.click(screen.getByRole("button", { name: /Phantom/ }));
    await waitFor(() => expect(useSession.getState().connected.solana).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(useSession.getState().connected.solana).toBeUndefined();
    expect(useSession.getState().lastSolanaWallet).toBeNull();
    await waitFor(() => expect(phantom.disconnectFn).toHaveBeenCalledTimes(1));
  });
});
