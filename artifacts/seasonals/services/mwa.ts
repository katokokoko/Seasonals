/**
 * Mobile Wallet Adapter — thin wrapper (CLAUDE.md §5 / §10 task #4)
 *
 * `@solana-mobile/mobile-wallet-adapter-protocol-web3js` を一段抽象化した service。
 * Mobile UI は `walletStore` / `useWallet` 経由でしか触らない (本層を直接 import する
 * のは store / 緊急時のテスト用途のみ)。
 *
 * セキュリティ:
 * - **秘密鍵を一切扱わない**。MWA 経由で wallet app (Phantom / Seeker Seed Vault) に
 *   署名を委譲し、署名済 transaction だけを受け取る (CLAUDE.md §5 / §32.2 fail-closed)
 * - authToken は秘密鍵ではないが「再認可をスキップできる証」として機微度が高いため、
 *   永続化は `expo-secure-store` を経由 (walletStore 側で実装)
 *
 * MWA protocol で yields される base64 address と `@solana/web3.js` の base58 を
 * 相互変換する責務もここに閉じ込める (上位層は base58 string で扱う)。
 *
 * @see https://docs.solanamobile.com/react-native/quickstart
 * @see CLAUDE.md §12 (MWA primary reference)
 */

import {
  transact,
  type Web3MobileWallet,
} from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import {
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type SolanaChain =
  | "solana:devnet"
  | "solana:testnet"
  | "solana:mainnet"
  | "solana:mainnet-beta";

export interface MwaIdentity {
  /** wallet 側に表示される dApp name */
  name: string;
  /** dApp の origin URI (universal link / web URL) */
  uri: string;
  /** favicon path (relative to uri) */
  icon: string;
}

export const DEFAULT_IDENTITY: MwaIdentity = {
  name: "Seasonals",
  uri: "https://seasonals.app",
  icon: "favicon.ico",
};

/** authorize / reauthorize 結果を Mobile UI が扱いやすい形に正規化したもの */
export interface ConnectedAuthorization {
  /** base58 wallet address */
  address: string;
  /** wallet が提供する人間可読な account label (任意) */
  label: string | null;
  /** MWA 再認可用 token (本人が保持する限り wallet UI を再表示せずに署名できる) */
  authToken: string;
  /** wallet host が deep link に使う URI base hint */
  walletUriBase: string | null;
  /** 接続中の chain */
  chain: SolanaChain;
}

export interface ConnectOptions {
  chain?: SolanaChain;
  identity?: MwaIdentity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** MWA protocol の base64 encoded address を base58 に変換 */
function toBase58(addressBase64: string): string {
  return new PublicKey(Buffer.from(addressBase64, "base64")).toBase58();
}

/** base58 → base64 (signMessages 等で MWA 側に渡す際に使う) */
function toBase64(addressBase58: string): string {
  return Buffer.from(new PublicKey(addressBase58).toBytes()).toString("base64");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 新規 wallet 接続。Phantom / Solflare / Seed Vault 等の wallet UI を起動。
 * 成功時は `ConnectedAuthorization` を返す。失敗時は throw (caller が catch)。
 */
export async function connectWallet(
  opts: ConnectOptions = {}
): Promise<ConnectedAuthorization> {
  const chain = opts.chain ?? "solana:devnet";
  const identity = opts.identity ?? DEFAULT_IDENTITY;

  return await transact(async (wallet: Web3MobileWallet) => {
    const result = await wallet.authorize({ chain, identity });
    const account = result.accounts[0];
    if (!account) {
      throw new Error("mwa_no_account_returned");
    }
    return {
      address: toBase58(account.address),
      label: account.label ?? null,
      authToken: result.auth_token,
      walletUriBase: result.wallet_uri_base ?? null,
      chain,
    };
  });
}

/**
 * 既存 authToken で再認可。wallet UI が出ずに silent re-auth できるのが理想だが、
 * wallet 側の policy で UI が再表示されることもある (期待値: 透過 reauth)。
 */
export async function reauthorizeWallet(
  prev: ConnectedAuthorization,
  opts: ConnectOptions = {}
): Promise<ConnectedAuthorization> {
  const identity = opts.identity ?? DEFAULT_IDENTITY;

  return await transact(async (wallet: Web3MobileWallet) => {
    const result = await wallet.reauthorize({
      auth_token: prev.authToken,
      identity,
    });
    const account = result.accounts[0];
    if (!account) {
      throw new Error("mwa_no_account_returned");
    }
    return {
      address: toBase58(account.address),
      label: account.label ?? null,
      authToken: result.auth_token,
      walletUriBase: result.wallet_uri_base ?? null,
      chain: prev.chain,
    };
  });
}

/** 接続を解除。authToken は wallet 側で revoke される。 */
export async function disconnectWallet(
  auth: ConnectedAuthorization
): Promise<void> {
  await transact(async (wallet: Web3MobileWallet) => {
    await wallet.deauthorize({ auth_token: auth.authToken });
  });
}

/**
 * 1〜N 個の transaction を一括署名。MWA は同一 session 内で sign + (optional) send。
 * 本関数は **sign のみ** で broadcast はしない。broadcast は services/api 側で行う。
 */
export async function signTransactions<
  T extends Transaction | VersionedTransaction
>(auth: ConnectedAuthorization, transactions: T[]): Promise<T[]> {
  return (await transact(async (wallet: Web3MobileWallet) => {
    await wallet.reauthorize({
      auth_token: auth.authToken,
      identity: DEFAULT_IDENTITY,
    });
    return await wallet.signTransactions({ transactions });
  })) as T[];
}

/**
 * Sign + on-chain broadcast を MWA に委譲。Phantom が internally に Devnet RPC へ
 * broadcast する (Mobile 側で Connection を持たなくて済む)。
 *
 * 戻り値は base58 signature の配列 (transactions と同順)。
 * fee 不足 / blockhash 期限切れ等は wallet 側で error UI が出る。
 */
export async function signAndSendTransactions<
  T extends Transaction | VersionedTransaction
>(auth: ConnectedAuthorization, transactions: T[]): Promise<string[]> {
  return await transact(async (wallet: Web3MobileWallet) => {
    // Phase 8.6.1: reauthorize は auth_token 検証で失敗するケースがあるため、
    // fresh authorize で session を確立する。Phantom mobile は authorize 後の
    // signAndSendTransactions を確実に処理する。
    try {
      await wallet.reauthorize({
        auth_token: auth.authToken,
        identity: DEFAULT_IDENTITY,
      });
    } catch {
      // reauthorize 失敗時は新規 authorize に fallback (chain は保存値を流用)
      await wallet.authorize({
        chain: auth.chain,
        identity: DEFAULT_IDENTITY,
      });
    }
    const result = await wallet.signAndSendTransactions({ transactions });
    if (!result || result.length === 0) {
      throw new Error(
        "Wallet returned empty signatures. The wallet may not support this transaction type."
      );
    }
    return result;
  });
}

/**
 * 任意 byte 列の署名 (off-chain 認証 / SIWS 等の用途)。
 * MWA spec で `addresses` は base64、payloads は raw bytes。
 */
export async function signMessages(
  auth: ConnectedAuthorization,
  messages: Uint8Array[]
): Promise<Uint8Array[]> {
  const addressBase64 = toBase64(auth.address);
  return await transact(async (wallet: Web3MobileWallet) => {
    await wallet.reauthorize({
      auth_token: auth.authToken,
      identity: DEFAULT_IDENTITY,
    });
    return await wallet.signMessages({
      addresses: [addressBase64],
      payloads: messages,
    });
  });
}
