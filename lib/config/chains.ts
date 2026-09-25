/**
 * Supported chains — Web の SupportedChainIcons (docs/web/ui-spec-v2.md §1) と
 * TimelineEvent.chain の canonical source。UI 側でリストを hardcode しない。
 *
 * - Solana: 既存 Seeker / BFF の対象 (spec §4.3)
 * - Ethereum: ETHGlobal Tokyo 2026 で追加 (docs/web/WORKLOG.md)。読み取りは mainnet、
 *   実行デモは Anvil fork のみ
 *
 * CAIP-2 identifiers: https://chainagnostic.org/CAIPs/caip-2
 */

export type ChainId = "solana" | "ethereum";

export interface ChainInfo {
  id: ChainId;
  name: string;
  /** CAIP-2 chain id */
  caip2: string;
  /** block explorer の tx / address URL prefix */
  explorer: { tx: string; address: string };
}

export const SUPPORTED_CHAINS: readonly ChainInfo[] = [
  {
    id: "solana",
    name: "Solana",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    explorer: {
      tx: "https://solscan.io/tx/",
      address: "https://solscan.io/account/",
    },
  },
  {
    id: "ethereum",
    name: "Ethereum",
    caip2: "eip155:1",
    explorer: {
      tx: "https://etherscan.io/tx/",
      address: "https://etherscan.io/address/",
    },
  },
] as const;

export function chainInfo(id: ChainId): ChainInfo {
  const found = SUPPORTED_CHAINS.find((c) => c.id === id);
  if (!found) throw new Error(`unknown chain: ${id}`);
  return found;
}

/** 0x + 40 hex = EVM address */
export function isEvmAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** base58 32..44 文字 = Solana address (BFF /time-events/wallet と同じ判定) */
export function isSolanaAddress(v: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

export function chainOfAddress(v: string): ChainId | null {
  if (isEvmAddress(v)) return "ethereum";
  if (isSolanaAddress(v)) return "solana";
  return null;
}
