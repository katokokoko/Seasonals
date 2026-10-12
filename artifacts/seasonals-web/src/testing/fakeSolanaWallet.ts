/**
 * test 用の偽 Wallet Standard wallet と `Wallets` API。
 * `getWallets()` は window 単位の singleton で test 間に消せないため、`_setWalletsApiForTest` で差し替えて使う。
 */
import { vi } from "vitest";
import type { Wallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { SolanaSignTransactionInput } from "@solana/wallet-standard-features";

export const SOL_OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const SOL_OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const FAKE_ICON = "data:image/svg+xml;base64,PHN2Zy8+" as const;

export function fakeAccount(address = SOL_OWNER, chains: string[] = ["solana:mainnet"]): WalletAccount {
  return {
    address,
    publicKey: new Uint8Array(32),
    chains: chains as WalletAccount["chains"],
    features: ["solana:signTransaction"],
  };
}

export interface FakeWalletOptions {
  name?: string;
  address?: string;
  chains?: string[];
  versions?: Array<"legacy" | 0>;
  /** 既定: connect は account を 1 つ返す */
  connect?: (input?: { silent?: boolean }) => Promise<{ accounts: WalletAccount[] }>;
  /** 既定: 各 tx の末尾に 0xff を足した bytes を「署名済み」として返す */
  sign?: (...inputs: SolanaSignTransactionInput[]) => Promise<Array<{ signedTransaction: Uint8Array }>>;
  disconnect?: () => Promise<void>;
}

export interface FakeWallet extends Wallet {
  /** standard:events の change を発火する */
  emitChange(accounts: WalletAccount[]): void;
  connectFn: ReturnType<typeof vi.fn>;
  signFn: ReturnType<typeof vi.fn>;
  disconnectFn: ReturnType<typeof vi.fn>;
}

export function signedMarker(tx: Uint8Array): Uint8Array {
  return Uint8Array.from([...tx, 0xff]);
}

export function fakeSolanaWallet(opts: FakeWalletOptions = {}): FakeWallet {
  const account = fakeAccount(opts.address ?? SOL_OWNER);
  const changeListeners = new Set<(p: { accounts?: WalletAccount[] }) => void>();
  const connectFn = vi.fn(opts.connect ?? (async () => ({ accounts: [account] })));
  const signFn = vi.fn(
    opts.sign ?? (async (...inputs: SolanaSignTransactionInput[]) => inputs.map((i) => ({ signedTransaction: signedMarker(i.transaction) })))
  );
  const disconnectFn = vi.fn(opts.disconnect ?? (async () => {}));
  return {
    version: "1.0.0",
    name: opts.name ?? "Phantom",
    icon: FAKE_ICON,
    chains: (opts.chains ?? ["solana:mainnet", "solana:devnet"]) as Wallet["chains"],
    accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: connectFn },
      "standard:disconnect": { version: "1.0.0", disconnect: disconnectFn },
      "standard:events": {
        version: "1.0.0",
        on: (_e: "change", l: (p: { accounts?: WalletAccount[] }) => void) => {
          changeListeners.add(l);
          return () => changeListeners.delete(l);
        },
      },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: opts.versions ?? ["legacy", 0], signTransaction: signFn },
    },
    emitChange: (accounts) => {
      for (const l of changeListeners) l({ accounts });
    },
    connectFn,
    signFn,
    disconnectFn,
  };
}

/** register / unregister を即時に通知する最小の Wallets API */
export function fakeWalletsApi(initial: Wallet[] = []): Wallets {
  let list: Wallet[] = [...initial];
  const ls = { register: new Set<(...w: Wallet[]) => void>(), unregister: new Set<(...w: Wallet[]) => void>() };
  return {
    get: () => list,
    on: (event, listener) => {
      ls[event].add(listener as (...w: Wallet[]) => void);
      return () => {
        ls[event].delete(listener as (...w: Wallet[]) => void);
      };
    },
    register: (...ws) => {
      list = [...list, ...ws];
      for (const l of ls.register) l(...ws);
      return () => {
        list = list.filter((w) => !ws.includes(w));
        for (const l of ls.unregister) l(...ws);
      };
    },
  };
}
