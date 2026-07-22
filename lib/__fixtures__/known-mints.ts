/**
 * known-mints — SPL mint pubkey → Seasonals protocol/category 登録 (Phase 8.1)
 *
 * Helius DAS `getAssetsByOwner` で取得した token を Position に map する際の
 * registry。mint が hit すれば protocol_id / category / 表示 asset symbol を
 * 確定でき、未知の mint は `wallet_holding` として generic 表示する。
 *
 * 規約:
 * - mint pubkey は base58 string。Solana mainnet の canonical mint を使う。
 * - decimals は Helius からも返るが、registry に持っておく方が早い (BFF / mobile
 *   どちらでも参照されるため lib に置く)。
 * - 将来 Kamino kToken / Jupiter JLP 等を追加する場合は
 *   ここに entry を増やすだけで OK (BFF / mobile の差分なし)。
 *
 * @see CLAUDE.md §11.3 Position
 * @see Phase 8.1 plan: Helius mainnet positions
 */

import { PositionCategory } from "../types/enums";

export interface KnownMint {
  /** SPL mint pubkey (base58) */
  mint: string;
  /** Seasonals 内 protocol_id (`marinade` / `jito` / `sanctum` / `wallet_holding`) */
  protocol_id: string;
  /** Position.category */
  category: PositionCategory;
  /** UI 表示用 symbol */
  asset_symbol: string;
  /** mint 固有 decimals */
  decimals: number;
}

/**
 * Phase 8.1 MVP: liquid staking SOL 3 種 + 主要 stable 2 種。
 * Key は mint pubkey (lookup 用)、value は KnownMint。
 */
export const KNOWN_PROTOCOL_MINTS: Record<string, KnownMint> = {
  // ── Liquid Staking SOL ──
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: {
    mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    protocol_id: "marinade",
    category: PositionCategory.Staking,
    asset_symbol: "mSOL",
    decimals: 9,
  },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: {
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    protocol_id: "jito",
    category: PositionCategory.Staking,
    asset_symbol: "JitoSOL",
    decimals: 9,
  },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: {
    mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    protocol_id: "sanctum",
    category: PositionCategory.Staking,
    asset_symbol: "bSOL",
    decimals: 9,
  },

  // ── Save (旧 Solend) main pool cToken (Phase 8.15c) ──
  // deposit (reserve liquidity) で wallet に mint される受取 SPL。decimals は underlying と同一。
  "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk": {
    mint: "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk",
    protocol_id: "savefi",
    category: PositionCategory.Lending,
    asset_symbol: "cUSDC",
    decimals: 6,
  },
  "5h6ssFpeDeRbzsEHDbTQNH7nVGgsKrZydxdSTnLm6QdV": {
    mint: "5h6ssFpeDeRbzsEHDbTQNH7nVGgsKrZydxdSTnLm6QdV",
    protocol_id: "savefi",
    category: PositionCategory.Lending,
    asset_symbol: "cSOL",
    decimals: 9,
  },

  // ── Native SOL ──
  // Helius DAS は wrapped native SOL (WSOL) を mint "So111...1112" として返す。
  // wallet 残高は別途 `getNativeBalance` で取得可能だが本 MVP は wrapped のみ。
  So11111111111111111111111111111111111111112: {
    mint: "So11111111111111111111111111111111111111112",
    protocol_id: "wallet_holding",
    category: PositionCategory.Other,
    asset_symbol: "SOL",
    decimals: 9,
  },

  // ── Stable ──
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    protocol_id: "wallet_holding",
    category: PositionCategory.Stable,
    asset_symbol: "USDC",
    decimals: 6,
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    protocol_id: "wallet_holding",
    category: PositionCategory.Stable,
    asset_symbol: "USDT",
    decimals: 6,
  },
};

/** convenience: mint pubkey から KnownMint を解決 (未知なら undefined) */
export function lookupKnownMint(mint: string): KnownMint | undefined {
  return KNOWN_PROTOCOL_MINTS[mint];
}
