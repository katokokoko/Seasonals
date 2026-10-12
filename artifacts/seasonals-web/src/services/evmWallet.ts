/**
 * Browser の EVM wallet — 検出 (EIP-6963) と address の取得のみ。
 * 署名は wallet 側で行い、Seasonals は秘密鍵を扱わない (CLAUDE.md §5)。
 *
 * 複数の拡張 (MetaMask / OKX / Rabby …) が入っていると `window.ethereum` は最後に
 * 書いた 1 つに上書きされる (OKX が取りがち)。EIP-6963 では各 wallet が
 * `eip6963:announceProvider` で自分の provider を名乗るので、それを並べて選ばせる。
 * 6963 非対応の古い wallet だけのときは `window.ethereum` を 1 件として出す。
 */
import { useEffect, useSyncExternalStore } from "react";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}

/** EIP-6963 の EIP6963ProviderInfo */
export interface WalletInfo {
  uuid: string;
  name: string;
  /** data URI (RFC-2397)。表示前に safeWalletIcon で確かめる */
  icon: string;
  rdns: string;
}

export interface DetectedWallet {
  info: WalletInfo;
  provider: Eip1193;
  /** EIP-6963 で名乗らなかった `window.ethereum` */
  legacy?: boolean;
}

const ANNOUNCE = "eip6963:announceProvider";
const REQUEST = "eip6963:requestProvider";
/** 6963 の応答を待ってから legacy fallback を判断するまでの猶予 */
export const LEGACY_WAIT_MS = 300;
const LEGACY_RDNS = "legacy.injected";

// ── 検出 store (useSyncExternalStore 用、snapshot は更新ごとに差し替える) ──
let wallets: DetectedWallet[] = [];
const listeners = new Set<() => void>();
let started = false;
let legacyTimer: ReturnType<typeof setTimeout> | undefined;

function emit(next: DetectedWallet[]) {
  wallets = next;
  for (const l of listeners) l();
}

function isProvider(p: unknown): p is Eip1193 {
  return typeof (p as Eip1193 | null)?.request === "function";
}

function onAnnounce(e: Event) {
  const detail = (e as CustomEvent<{ info?: Partial<WalletInfo>; provider?: unknown }>).detail;
  const info = detail?.info;
  if (!info?.rdns || !info.name || !isProvider(detail.provider)) return;
  const own = wallets.filter((w) => !w.legacy);
  // 同じ wallet が 2 回名乗っても 1 件 (先勝ち)
  if (own.some((w) => w.info.rdns === info.rdns)) return;
  const wallet: DetectedWallet = {
    info: { uuid: info.uuid ?? info.rdns, name: info.name, icon: info.icon ?? "", rdns: info.rdns },
    provider: detail.provider,
  };
  // 6963 で名乗った wallet が 1 つでもあれば、上書き合戦の結果である window.ethereum は出さない
  emit([...own, wallet]);
}

function legacyName(p: Record<string, unknown>): string {
  if (p.isOkxWallet || p.isOKExWallet) return "OKX Wallet";
  if (p.isRabby) return "Rabby";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isPhantom) return "Phantom";
  if (p.isBraveWallet) return "Brave Wallet";
  // 多くの wallet が互換のため isMetaMask を立てるので最後に見る
  if (p.isMetaMask) return "MetaMask";
  return "Browser wallet";
}

function addLegacyIfNone() {
  if (wallets.length > 0) return;
  const p = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!isProvider(p)) return;
  const name = legacyName(p as unknown as Record<string, unknown>);
  emit([{ info: { uuid: "legacy", name, icon: "", rdns: LEGACY_RDNS }, provider: p, legacy: true }]);
}

/** 検出を始める (何度呼んでもよい。2 回目以降は wallet に名乗り直しを頼むだけ) */
export function discoverWallets() {
  if (typeof window === "undefined") return;
  if (!started) {
    started = true;
    window.addEventListener(ANNOUNCE, onAnnounce);
    legacyTimer = setTimeout(addLegacyIfNone, LEGACY_WAIT_MS);
  }
  window.dispatchEvent(new Event(REQUEST));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const snapshot = () => wallets;

export function useDetectedWallets(): DetectedWallet[] {
  useEffect(() => discoverWallets(), []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * wallet の icon は data:image/ の URI だけを <img> で出す (EIP-6963 の推奨)。
 * それ以外 (http URL / javascript: など) は使わない
 */
export function safeWalletIcon(icon: string): string | null {
  return /^data:image\/(png|svg\+xml|webp|jpeg|gif)[;,]/i.test(icon) ? icon : null;
}

// ── 接続中の wallet (accountsChanged はこの provider だけを聞く) ──
let active: DetectedWallet | null = null;
let detach: (() => void) | null = null;
const accountListeners = new Set<(address: string | null) => void>();

function attach(w: DetectedWallet | null) {
  detach?.();
  detach = null;
  active = w;
  const p = w?.provider;
  if (!p?.on) return;
  const h = (...args: unknown[]) => {
    const accounts = args[0] as string[] | undefined;
    for (const cb of accountListeners) cb(accounts?.[0] ?? null);
  };
  p.on("accountsChanged", h);
  detach = () => p.removeListener?.("accountsChanged", h);
}

export async function connectWallet(w: DetectedWallet): Promise<string> {
  const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error(`${w.info.name} returned no account.`);
  attach(w);
  return first;
}

/** Seasonals 側の接続を解く (wallet の権限はそのまま。以後 accountsChanged を聞かない) */
export function disconnectWallet() {
  attach(null);
}

export function activeWallet(): DetectedWallet | null {
  return active;
}

/** 接続中の wallet で account が切り替わった / 外れた (空配列なら null) */
export function onAccountsChanged(cb: (address: string | null) => void): () => void {
  accountListeners.add(cb);
  return () => {
    accountListeners.delete(cb);
  };
}

/** EIP-1193 の userRejectedRequest */
export function isUserRejection(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 4001;
}

export function _resetWalletsForTest() {
  if (typeof window !== "undefined") window.removeEventListener(ANNOUNCE, onAnnounce);
  clearTimeout(legacyTimer);
  started = false;
  emit([]);
  attach(null);
  accountListeners.clear();
}
