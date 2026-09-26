/**
 * evmWallet — EIP-6963 で複数の browser wallet を検出し、選んだ wallet だけに話しかける。
 * window.ethereum を奪い合う拡張 (OKX など) があっても、他の wallet を選べることを固定する。
 */
import { vi } from "vitest";
import {
  _resetWalletsForTest,
  connectWallet,
  discoverWallets,
  LEGACY_WAIT_MS,
  onAccountsChanged,
  safeWalletIcon,
  useDetectedWallets,
  type DetectedWallet,
  type Eip1193,
} from "./evmWallet";
import { act, cleanup, renderHook } from "@testing-library/react";

const ICON = "data:image/svg+xml;base64,PHN2Zy8+";

function fakeProvider(account: string) {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const provider = {
    request: vi.fn(async () => [account]),
    on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => handlers.set(ev, cb)),
    removeListener: vi.fn((ev: string) => handlers.delete(ev)),
  };
  return { provider, fire: (ev: string, ...args: unknown[]) => handlers.get(ev)?.(...args) };
}

/** 本物の wallet と同じく、requestProvider を受けたら名乗る */
function installAnnouncer(rdns: string, name: string, provider: Eip1193) {
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: `${rdns}-uuid`, name, icon: ICON, rdns }, provider }) })
    );
  window.addEventListener("eip6963:requestProvider", announce);
  return () => window.removeEventListener("eip6963:requestProvider", announce);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  // 先に unmount してから store を空にする (act 外の更新にしない)
  cleanup();
  for (const c of cleanups.splice(0)) c();
  _resetWalletsForTest();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.useRealTimers();
});

test("名乗った wallet を全部並べる (同じ rdns は 1 件)", () => {
  const mm = fakeProvider("0xaaa");
  const okx = fakeProvider("0xbbb");
  cleanups.push(installAnnouncer("io.metamask", "MetaMask", mm.provider));
  cleanups.push(installAnnouncer("com.okex.wallet", "OKX Wallet", okx.provider));
  const { result } = renderHook(() => useDetectedWallets());
  expect(result.current.map((w) => w.info.name)).toEqual(["MetaMask", "OKX Wallet"]);
  // 2 回目の requestProvider で名乗り直されても増えない
  act(() => discoverWallets());
  expect(result.current).toHaveLength(2);
});

test("6963 で誰も名乗らなければ window.ethereum を 1 件だけ出す", () => {
  vi.useFakeTimers();
  const legacy = fakeProvider("0xccc");
  (window as unknown as { ethereum: unknown }).ethereum = { ...legacy.provider, isMetaMask: true, isOkxWallet: true };
  const { result } = renderHook(() => useDetectedWallets());
  expect(result.current).toHaveLength(0);
  act(() => void vi.advanceTimersByTime(LEGACY_WAIT_MS));
  expect(result.current).toHaveLength(1);
  expect(result.current[0]).toMatchObject({ legacy: true, info: { name: "OKX Wallet" } });
});

test("6963 の wallet が名乗ったら legacy の window.ethereum は出さない", () => {
  vi.useFakeTimers();
  (window as unknown as { ethereum: unknown }).ethereum = fakeProvider("0xccc").provider;
  const { result } = renderHook(() => useDetectedWallets());
  act(() => void vi.advanceTimersByTime(LEGACY_WAIT_MS));
  expect(result.current[0]?.legacy).toBe(true);
  const mm = fakeProvider("0xaaa");
  cleanups.push(installAnnouncer("io.metamask", "MetaMask", mm.provider));
  act(() => discoverWallets());
  expect(result.current.map((w) => w.info.name)).toEqual(["MetaMask"]);
});

test("選んだ wallet の provider にだけ eth_requestAccounts を送る", async () => {
  const mm = fakeProvider("0xaaa");
  const okx = fakeProvider("0xbbb");
  cleanups.push(installAnnouncer("com.okex.wallet", "OKX Wallet", okx.provider));
  cleanups.push(installAnnouncer("io.metamask", "MetaMask", mm.provider));
  const { result } = renderHook(() => useDetectedWallets());
  const metamask = result.current.find((w) => w.info.rdns === "io.metamask") as DetectedWallet;
  await expect(connectWallet(metamask)).resolves.toBe("0xaaa");
  expect(mm.provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
  expect(okx.provider.request).not.toHaveBeenCalled();
});

test("accountsChanged は接続中の wallet だけを聞き、切り替えたら前の wallet から外れる", async () => {
  const mm = fakeProvider("0xaaa");
  const okx = fakeProvider("0xbbb");
  cleanups.push(installAnnouncer("io.metamask", "MetaMask", mm.provider));
  cleanups.push(installAnnouncer("com.okex.wallet", "OKX Wallet", okx.provider));
  const { result } = renderHook(() => useDetectedWallets());
  const [metamask, okxWallet] = result.current as [DetectedWallet, DetectedWallet];
  const seen: Array<string | null> = [];
  onAccountsChanged((a) => seen.push(a));

  await connectWallet(metamask);
  okx.fire("accountsChanged", ["0xignored"]);
  mm.fire("accountsChanged", ["0xa2"]);
  mm.fire("accountsChanged", []);
  expect(seen).toEqual(["0xa2", null]);

  await connectWallet(okxWallet);
  expect(mm.provider.removeListener).toHaveBeenCalled();
  mm.fire("accountsChanged", ["0xignored"]);
  okx.fire("accountsChanged", ["0xb2"]);
  expect(seen).toEqual(["0xa2", null, "0xb2"]);
});

test("icon は data:image/ の URI だけ使う", () => {
  expect(safeWalletIcon(ICON)).toBe(ICON);
  expect(safeWalletIcon("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  expect(safeWalletIcon("https://evil.example/icon.png")).toBeNull();
  expect(safeWalletIcon("javascript:alert(1)")).toBeNull();
  expect(safeWalletIcon("data:text/html,<script>")).toBeNull();
  expect(safeWalletIcon("")).toBeNull();
});
