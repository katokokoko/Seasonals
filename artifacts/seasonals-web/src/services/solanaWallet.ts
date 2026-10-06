/**
 * Browser の Solana wallet — Wallet Standard での検出 / 接続 / 署名 (sign-only)。
 * Seeker 版の MWA (`artifacts/seasonals/services/mwa.ts`) に相当する web 側の層。
 *
 * - 検出: `getWallets()` が `wallet-standard:app-ready` を出し、`wallet-standard:register-wallet` を聞く
 *   (Phantom / Solflare / Backpack などはこれで名乗る)。EIP-6963 版 (`evmWallet.ts`) と同じく
 *   useSyncExternalStore で並べる
 * - 署名: `solana:signTransaction` (可変長引数、1 回の承認で N 本)。送信はしない — 署名済 bytes を
 *   BFF `/tx/submit` が Helius で broadcast する (Seeker と同じ経路、CLAUDE.md §5)
 * - tx は base64 ↔ Uint8Array のまま扱い、@solana/web3.js を web に入れない
 *
 * Seasonals は秘密鍵を扱わない。署名は常に wallet 側。
 */
import { useEffect, useSyncExternalStore } from "react";
import { getWallets, type Wallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
  type SolanaSignTransactionInput,
} from "@solana/wallet-standard-features";
import { SOLANA_MAINNET_CHAIN } from "@solana/wallet-standard-chains";
import { isSolanaAddress } from "@workspace/lib/config/chains";

export { SOLANA_MAINNET_CHAIN };

export interface SolanaDetectedWallet {
  name: string;
  /** data URI。表示前に safeWalletIcon で確かめる */
  icon: string;
  wallet: Wallet;
}

/** 失敗理由を UI で出し分けるための code 付き error */
export class SolanaWalletError extends Error {
  constructor(
    public readonly code: "not_connected" | "account_mismatch" | "unsupported_version" | "incomplete_signatures" | "no_account",
    message: string
  ) {
    super(message);
    this.name = "SolanaWalletError";
  }
}

type ConnectFeature = StandardConnectFeature[typeof StandardConnect];
type DisconnectFeature = StandardDisconnectFeature[typeof StandardDisconnect];
type EventsFeature = StandardEventsFeature[typeof StandardEvents];
type SignFeature = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

function feature<T>(w: Wallet, name: string): T | undefined {
  return (w.features as Record<string, unknown>)[name] as T | undefined;
}

/** Solana mainnet で接続と署名ができる wallet か */
export function isSolanaStandardWallet(w: Wallet): boolean {
  return (
    w.chains.includes(SOLANA_MAINNET_CHAIN) &&
    typeof feature<ConnectFeature>(w, StandardConnect)?.connect === "function" &&
    typeof feature<SignFeature>(w, SolanaSignTransaction)?.signTransaction === "function"
  );
}

// ── 検出 store (useSyncExternalStore 用、snapshot は更新ごとに差し替える) ──
let wallets: SolanaDetectedWallet[] = [];
const listeners = new Set<() => void>();
let walletsApi: Wallets | null = null;
let injectedApi: Wallets | null = null;
let offs: Array<() => void> = [];

function refresh() {
  if (!walletsApi) return;
  const next: SolanaDetectedWallet[] = [];
  for (const w of walletsApi.get()) {
    // 同じ名前の wallet が 2 回名乗っても 1 件 (先勝ち)
    if (!isSolanaStandardWallet(w) || next.some((n) => n.name === w.name)) continue;
    next.push({ name: w.name, icon: w.icon, wallet: w });
  }
  if (next.length === wallets.length && next.every((n, i) => n.wallet === wallets[i]!.wallet)) return;
  wallets = next;
  for (const l of listeners) l();
}

/** 検出を始める (何度呼んでもよい) */
export function discoverSolanaWallets() {
  if (typeof window === "undefined" || walletsApi) return;
  walletsApi = injectedApi ?? getWallets();
  offs = [walletsApi.on("register", refresh), walletsApi.on("unregister", refresh)];
  refresh();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const snapshot = () => wallets;

export function useDetectedSolanaWallets(): SolanaDetectedWallet[] {
  useEffect(() => discoverSolanaWallets(), []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// ── 接続中の wallet ──
let active: { wallet: SolanaDetectedWallet; account: WalletAccount } | null = null;
let detach: (() => void) | null = null;
const accountListeners = new Set<(address: string | null) => void>();

/** mainnet で使える base58 account を 1 つ選ぶ (account.chains が空の wallet は wallet 全体の chains に従う) */
function pickAccount(accounts: readonly WalletAccount[]): WalletAccount | undefined {
  return accounts.find((a) => isSolanaAddress(a.address) && (a.chains.length === 0 || a.chains.includes(SOLANA_MAINNET_CHAIN)));
}

function attach(next: typeof active) {
  detach?.();
  detach = null;
  active = next;
  if (!next) return;
  const events = feature<EventsFeature>(next.wallet.wallet, StandardEvents);
  if (!events) return;
  detach = events.on("change", ({ accounts }) => {
    if (!accounts || !active) return;
    const acct = pickAccount(accounts);
    if (acct) active = { ...active, account: acct };
    else attach(null);
    for (const cb of accountListeners) cb(acct?.address ?? null);
  });
}

/**
 * 接続して base58 address を返す。silent = 既に許可済みなら prompt を出さずに戻す
 * (wallet によっては無視されるので、呼び手は reload 直後の 1 回だけ使う)
 */
export async function connectSolanaWallet(w: SolanaDetectedWallet, opts: { silent?: boolean } = {}): Promise<string> {
  const connect = feature<ConnectFeature>(w.wallet, StandardConnect);
  if (!connect) throw new SolanaWalletError("not_connected", `${w.name} cannot connect.`);
  const out = await connect.connect(opts.silent ? { silent: true } : undefined);
  const account = pickAccount(out.accounts.length > 0 ? out.accounts : w.wallet.accounts);
  if (!account) throw new SolanaWalletError("no_account", `${w.name} returned no Solana mainnet account.`);
  attach({ wallet: w, account });
  return account.address;
}

/** Seasonals 側の接続を解く。wallet が standard:disconnect を持っていれば wallet 側の許可も外す */
export async function disconnectSolanaWallet(): Promise<void> {
  const w = active?.wallet.wallet;
  attach(null);
  const disconnect = w ? feature<DisconnectFeature>(w, StandardDisconnect) : undefined;
  try {
    await disconnect?.disconnect();
  } catch {
    /* wallet 側の切断失敗は Seasonals の状態に影響しない */
  }
}

export function activeSolanaAddress(): string | null {
  return active?.account.address ?? null;
}

/** 接続中の wallet で account が切り替わった / 外れた */
export function onSolanaAccountsChanged(cb: (address: string | null) => void): () => void {
  accountListeners.add(cb);
  return () => {
    accountListeners.delete(cb);
  };
}

/**
 * BFF が組んだ v0 tx (bytes) を接続 wallet で一括署名する (承認 1 回、送信しない)。
 * - owner は tx の fee payer。接続 account と違えば wallet を開く前に止める
 * - Meteora / Orca の deposit は BFF の使い捨て keypair で部分署名済み。wallet は自分の署名だけを足す
 * - 返る bytes の本数が足りなければ失敗 (Seeker の ActionModal L413 と同じ検査)
 */
export async function signSolanaTransactions(owner: string, txs: Uint8Array[]): Promise<Uint8Array[]> {
  if (!active) throw new SolanaWalletError("not_connected", "Connect a Solana wallet to sign.");
  if (active.account.address !== owner) {
    throw new SolanaWalletError("account_mismatch", `The connected wallet account is not ${owner}. Switch accounts in ${active.wallet.name}.`);
  }
  const sign = feature<SignFeature>(active.wallet.wallet, SolanaSignTransaction);
  if (!sign) throw new SolanaWalletError("not_connected", `${active.wallet.name} cannot sign Solana transactions.`);
  if (!sign.supportedTransactionVersions.includes(0)) {
    throw new SolanaWalletError("unsupported_version", `${active.wallet.name} does not support versioned (v0) transactions.`);
  }
  const account = active.account;
  const inputs = txs.map((transaction): SolanaSignTransactionInput => ({ account, transaction, chain: SOLANA_MAINNET_CHAIN }));
  const outputs = await sign.signTransaction(...inputs);
  if (outputs.length !== txs.length || outputs.some((o) => !(o?.signedTransaction instanceof Uint8Array))) {
    throw new SolanaWalletError("incomplete_signatures", "Wallet did not return all signed transactions.");
  }
  return outputs.map((o) => o.signedTransaction);
}

/**
 * wallet 側での拒否か。Phantom は EIP-1193 と同じ 4001、Solflare / Backpack は message だけの Error を投げる
 */
export function isSolanaUserRejection(e: unknown): boolean {
  if ((e as { code?: unknown } | null)?.code === 4001) return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /reject|declin|cancel|denied|closed/i.test(msg);
}

/** test 用: getWallets() は window 単位の singleton で消せないので、差し替え可能にする */
export function _setWalletsApiForTest(api: Wallets | null) {
  injectedApi = api;
}

export function _resetSolanaWalletsForTest() {
  for (const off of offs) off();
  offs = [];
  walletsApi = null;
  wallets = [];
  for (const l of listeners) l();
  attach(null);
  accountListeners.clear();
}
