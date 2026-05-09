/**
 * Menu listings — Menu drawer の protocol catalog 表示専用 fixture
 *
 * これは display 用 catalog で、Position / Protocol 型 (§11.2) とは別軸。
 * - APY / TVL / asset / icon_color はカードの右上 / 下に表示するメタ
 * - deposited 状態は positions 集計から runtime で算出 (本 fixture に持たない)
 *
 * 実 production では Adapter SDK (§13) が同等情報を返す前提で、
 * 本 fixture は MVP の "Menu に並ぶ protocol が prototype 通り" を担保する。
 */

import { PositionCategory } from "../types/enums";
import { COLOR } from "../design-system";

/**
 * 外部 protocol の brand color (Seasonals palette には属さない).
 * §6 「色は DS.color.* token 経由」は Seasonals UI 用 token への規約で、
 * 本値は third-party protocol icon の placeholder 色として menu-listings 内に閉じ込める。
 * 実 production ではプロトコル公式 logo asset に置換予定。
 */
const PROTOCOL_DARK_ICON_BG = "#0E1F3A";

export interface MenuListing {
  /** Position.protocol_id と一致する場合は deposited 判定に使う */
  protocol_id: string;
  display_name: string;
  category: PositionCategory;
  /** 表示用 asset symbol ("USDC" / "SOL" / "JitoSOL" 等) */
  asset: string;
  /** 0..1 (例: 0.071 = 7.10%) */
  apy: number;
  /** M SOL 単位 (例: 4.4 = 4.4M SOL TVL) */
  tvl_msol: number;
  /** icon の正方形背景色 token (brand palette から選ぶ) */
  icon_color: string;
}

export const fixtureMenuListings: MenuListing[] = [
  // ─── LENDING ──────────────────────────────────────────────
  {
    protocol_id: "kamino",
    display_name: "Kamino Lend",
    category: PositionCategory.Lending,
    asset: "USDC",
    apy: 0.071,
    tvl_msol: 4.4,
    icon_color: PROTOCOL_DARK_ICON_BG,
  },
  {
    protocol_id: "marginfi",
    display_name: "MarginFi",
    category: PositionCategory.Lending,
    asset: "USDC",
    apy: 0.083,
    tvl_msol: 3.1,
    icon_color: PROTOCOL_DARK_ICON_BG,
  },
  {
    protocol_id: "jupiter_lend",
    display_name: "Jupiter Lend",
    category: PositionCategory.Lending,
    asset: "USDC",
    apy: 0.089,
    tvl_msol: 5.7,
    icon_color: PROTOCOL_DARK_ICON_BG,
  },

  // ─── STAKING ──────────────────────────────────────────────
  {
    protocol_id: "marinade",
    display_name: "Marinade",
    category: PositionCategory.Staking,
    asset: "SOL",
    apy: 0.068,
    tvl_msol: 12.0,
    icon_color: COLOR.caramel,
  },
  {
    protocol_id: "sanctum",
    display_name: "Sanctum",
    category: PositionCategory.Staking,
    asset: "SOL",
    apy: 0.072,
    tvl_msol: 5.8,
    icon_color: COLOR.sodaDeep,
  },

  // ─── RESTAKING ────────────────────────────────────────────
  {
    protocol_id: "jito",
    display_name: "Jito",
    category: PositionCategory.Restaking,
    asset: "JitoSOL",
    apy: 0.082,
    tvl_msol: 10.5,
    icon_color: COLOR.melonDeep,
  },
  {
    protocol_id: "symbiotic",
    display_name: "Symbiotic Universal Staking Framework",
    category: PositionCategory.Restaking,
    asset: "SOL",
    apy: 0.105,
    tvl_msol: 7.7,
    icon_color: PROTOCOL_DARK_ICON_BG,
  },

  // ─── VAULT ─────────────────────────────────────────────────
  {
    protocol_id: "kamino_vault",
    display_name: "Kamino Vault",
    category: PositionCategory.Vault,
    asset: "USDC",
    apy: 0.0815,
    tvl_msol: 6.2,
    icon_color: PROTOCOL_DARK_ICON_BG,
  },

  // ─── LP ────────────────────────────────────────────────────
  {
    protocol_id: "meteora",
    display_name: "Meteora",
    category: PositionCategory.LP,
    asset: "USDC-USDT",
    apy: 0.092,
    tvl_msol: 8.9,
    icon_color: COLOR.straw,
  },

  // ─── PT-YT ────────────────────────────────────────────────
  {
    protocol_id: "ratex",
    display_name: "RateX",
    category: PositionCategory.PTYT,
    asset: "PT-jupSOL",
    apy: 0.123,
    tvl_msol: 2.4,
    icon_color: COLOR.cherry,
  },

  // ─── STABLE (yield-bearing stablecoins) ──────────────────
  {
    protocol_id: "ondo",
    display_name: "Ondo USDY",
    category: PositionCategory.Stable,
    asset: "USDY",
    apy: 0.0530,
    tvl_msol: 3.6,
    icon_color: COLOR.melonText,
  },
];
