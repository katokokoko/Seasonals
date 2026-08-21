/**
 * Menu protocol entries (Phase 6.1) — 12 主要 Solana DeFi protocols × 階層 pools
 *
 * 数値は 2026-07 baseline (Phase 8.32 で DefiLlama / 各 protocol API 実測値に refresh。
 * 2026 年の Solana TVL -56% 局面を反映。live overlay が届く pool は実行時に上書き)。
 * Mobile の Menu drawer で render される。pools[] 内の pool は `protocol_id`
 * (deposited 判定 in MenuDrawer) と独立に持ち、各 pool 単位で APY / TVL / borrowed
 * を表示する。
 *
 * 実 production では BFF /menu-listings endpoint が DefiLlama / 各 protocol の SDK
 * を経由して同 shape を返す予定 (現状 fixture を BFF と Mobile の両側で共有)。
 *
 * @see lib/types/protocol-pool.ts (型定義)
 * @see CLAUDE.md §3 数値表現規約 (display-only carve-out)
 */

import { PositionCategory } from "../types/enums";
import { COLOR } from "../design-system";
import type { ProtocolMenuEntry } from "../types/protocol-pool";

// 外部 protocol icon の bg (DS palette 外、§6 規約 carve-out)。
// ロゴ PNG は地色を焼き込んだ不透明画像で、iconBox は overflow:hidden の角丸。
// **画像の地色と一致させる**こと (ずれると角に別色が覗く)。
const ICON_BG_DARK = "#0E1F3A";
const ICON_BG_BLACK = "#000000"; // exponent.png の地色
const ICON_BG_HYLO = "#1A1818"; // hylo.png の地色

export const fixtureMenuListings: ProtocolMenuEntry[] = [
  // ─── 1. Jupiter ────────────────────────────────────────────
  {
    protocol_id: "jupiter",
    display_name: "Jupiter",
    primary_category: PositionCategory.Lending,
    supported_assets: ["USDC", "SOL"],
    icon_id: "jupiter",
    icon_bg: ICON_BG_DARK,
    // 8.27: 旧 "jupiter_jlp_lending" は Jupiter に実体が無く削除 —
    // JLP lending の実体は kamino entry の kamino_jlp (main market JLP reserve)
    pools: [
      {
        pool_id: "jupiter_usdc_main",
        name: "USDC Main",
        category: PositionCategory.Lending,
        asset: "USDC",
        apy: 0.0407,
        tvl_usd: 320_000_000,
        borrowed_usd: 180_000_000,
      },
      {
        pool_id: "jupiter_jupsol",
        name: "JupSOL",
        category: PositionCategory.Lending,
        asset: "SOL",
        apy: 0.072,
        tvl_usd: 80_000_000,
      },
    ],
  },

  // ─── 2. Kamino ─────────────────────────────────────────────
  {
    protocol_id: "kamino",
    display_name: "Kamino",
    primary_category: PositionCategory.Lending,
    supported_assets: ["USDC", "SOL", "JLP"],
    icon_id: "kamino",
    icon_bg: ICON_BG_DARK,
    pools: [
      {
        pool_id: "kamino_usdc_main",
        name: "USDC Main Market",
        category: PositionCategory.Lending,
        asset: "USDC",
        apy: 0.0551,
        tvl_usd: 1_200_000_000,
        borrowed_usd: 700_000_000,
      },
      {
        pool_id: "kamino_sol_main",
        name: "SOL Main Market",
        category: PositionCategory.Lending,
        asset: "SOL",
        apy: 0.0480,
        tvl_usd: 850_000_000,
        borrowed_usd: 300_000_000,
      },
      // 8.27: main market の実 JLP reserve に接続 (KAMINO_MARKETS kamino_jlp)。
      // supply APY ~0% が実態 (JLP の利回りは価格上昇に内在)。live overlay が実値表示
      {
        pool_id: "kamino_jlp",
        name: "JLP Reserve",
        category: PositionCategory.Lending,
        asset: "JLP",
        apy: 0.0,
        tvl_usd: 1_900_000,
      },
      // Phase 8.15d: 実在の kVault に接続 (KAMINO_VAULTS registry と pool_id 一致必須)
      {
        pool_id: "kamino_steakhouse_usdc",
        name: "Steakhouse USDC Vault",
        category: PositionCategory.Vault,
        asset: "USDC",
        apy: 0.0402,
        tvl_usd: 19_800_000,
      },
      {
        pool_id: "kamino_allez_sol_vault",
        name: "Allez SOL Vault",
        category: PositionCategory.Vault,
        asset: "SOL",
        apy: 0.112,
        tvl_usd: 6_300_000,
      },
    ],
  },

  // ─── 3. Solstice ───────────────────────────────────────────
  {
    protocol_id: "solstice",
    display_name: "Solstice",
    primary_category: PositionCategory.Stable,
    supported_assets: ["USDC"],
    icon_id: "solstice",
    icon_bg: COLOR.melonDeep,
    // Phase 8.24: 実トークンは eUSX (staked USX)。sUSD は誤記だった。
    // APY は Exponent underlyingApy (~3.8%) を /menu-listings が live overlay。
    pools: [
      {
        pool_id: "solstice_eusx",
        name: "eUSX Yield",
        category: PositionCategory.Stable,
        asset: "USDC",
        deposit_asset: "USDC",
        apy: 0.038,
        tvl_usd: 42_000_000,
      },
    ],
  },

  // ─── 4. Sanctum ────────────────────────────────────────────
  {
    protocol_id: "sanctum",
    display_name: "Sanctum",
    primary_category: PositionCategory.Staking,
    supported_assets: ["SOL"],
    icon_id: "sanctum",
    icon_bg: COLOR.sodaDeep,
    pools: [
      {
        pool_id: "sanctum_inf",
        name: "INF Pool",
        category: PositionCategory.Staking,
        asset: "SOL",
        apy: 0.0780,
        tvl_usd: 158_000_000,
      },
      {
        pool_id: "sanctum_jitosol",
        name: "JitoSOL",
        category: PositionCategory.Staking,
        asset: "SOL",
        apy: 0.0720,
        tvl_usd: 780_000_000,
        // Phase 8.37 (レビュー L-F1): swap-earn registry に sanctum/jitoSOL 実体なし (asset fallback だと INF に化ける) — 実装まで view-only
        display_only: true,
      },
      {
        pool_id: "sanctum_bsol",
        name: "bSOL",
        category: PositionCategory.Staking,
        asset: "SOL",
        apy: 0.0690,
        tvl_usd: 69_000_000,
        // Phase 8.37 (レビュー L-F1): swap-earn registry に sanctum/bSOL 実体なし (同上) — 実装まで view-only
        display_only: true,
      },
    ],
  },

  // ─── 5. Perena ─────────────────────────────────────────────
  {
    protocol_id: "perena",
    display_name: "Perena",
    primary_category: PositionCategory.Stable,
    supported_assets: ["USDC"],
    icon_id: "perena",
    icon_bg: COLOR.melonText,
    pools: [
      {
        pool_id: "perena_usd_star",
        name: "USD* Stable",
        category: PositionCategory.Stable,
        asset: "USDC",
        apy: 0.093, // 8.25: 実測近似 (live は api.perena.org 7d APY で overlay)
        tvl_usd: 5_000_000,
      },
      {
        pool_id: "perena_tri_stable",
        name: "Tri-Stable Pool",
        category: PositionCategory.LP,
        asset: "USDC-USDT-PYUSD",
        apy: 0.0630,
        tvl_usd: 3_000_000,
        deposit_asset: "USDC",
        // Phase 8.37 (レビュー L-F1): tri-pool の実 adapter 未実装 (fallback だと USD* 単独になる) — 実装まで view-only
        display_only: true,
      },
    ],
  },

  // ─── 6. SaveFi (Save Finance) ──────────────────────────────
  {
    protocol_id: "savefi",
    display_name: "Save",
    primary_category: PositionCategory.Lending,
    supported_assets: ["USDC", "SOL"],
    icon_id: "savefi",
    icon_bg: COLOR.cherry,
    pools: [
      {
        pool_id: "savefi_usdc_main",
        name: "USDC Main",
        category: PositionCategory.Lending,
        asset: "USDC",
        apy: 0.0490,
        tvl_usd: 21_900_000,
        borrowed_usd: 16_200_000,
      },
      {
        pool_id: "savefi_sol_main",
        name: "SOL Main",
        category: PositionCategory.Lending,
        asset: "SOL",
        apy: 0.0420,
        tvl_usd: 16_100_000,
        borrowed_usd: 10_500_000,
      },
      {
        // main market 外の isolated pool — per-reserve API 未登録のため概算 (8.32)
        pool_id: "savefi_turbo_sol",
        name: "Turbo SOL",
        category: PositionCategory.Lending,
        asset: "SOL",
        apy: 0.0680,
        tvl_usd: 3_000_000,
        borrowed_usd: 2_000_000,
        // Phase 8.37 (レビュー L-F1): SAVE_MARKETS に未登録 (fallback だと sol_main に入金される) — 実装まで view-only
        display_only: true,
      },
    ],
  },

  // ─── 7. Marinade ───────────────────────────────────────────
  {
    protocol_id: "marinade",
    display_name: "Marinade",
    primary_category: PositionCategory.Staking,
    supported_assets: ["SOL"],
    icon_id: "marinade",
    icon_bg: COLOR.caramel,
    pools: [
      {
        pool_id: "marinade_msol",
        name: "mSOL Liquid Staking",
        category: PositionCategory.Staking,
        asset: "SOL",
        apy: 0.0680,
        tvl_usd: 187_000_000,
      },
    ],
  },

  // ─── 8. Meteora ────────────────────────────────────────────
  {
    protocol_id: "meteora",
    display_name: "Meteora",
    primary_category: PositionCategory.LP,
    supported_assets: ["USDC", "SOL"],
    icon_id: "meteora",
    icon_bg: COLOR.straw,
    pools: [
      // TVL は datapi 実測 (2026-07-22)。DLMM pool は集中流動性のため
      // pool 単位の TVL は小さい (protocol 全体 ~$180M とは別物)
      {
        pool_id: "meteora_usdc_usdt_dlmm",
        name: "USDC-USDT DLMM",
        category: PositionCategory.LP,
        asset: "USDC-USDT",
        apy: 0.0920,
        tvl_usd: 270_000,
        deposit_asset: "USDC",
      },
      {
        pool_id: "meteora_sol_usdc_dlmm",
        name: "SOL-USDC DLMM",
        category: PositionCategory.LP,
        asset: "SOL-USDC",
        apy: 0.2850,
        tvl_usd: 4_900_000,
        deposit_asset: "USDC",
      },
      {
        pool_id: "meteora_jitosol_sol_dlmm",
        name: "JitoSOL-SOL DLMM",
        category: PositionCategory.LP,
        asset: "JitoSOL-SOL",
        apy: 0.0580,
        tvl_usd: 2_800_000,
        deposit_asset: "SOL",
      },
    ],
  },

  // ─── 9. Jito ──────────────────────────────────────────────
  {
    protocol_id: "jito",
    display_name: "Jito",
    primary_category: PositionCategory.Restaking,
    supported_assets: ["SOL"],
    icon_id: "jito",
    icon_bg: COLOR.melonDeep,
    pools: [
      {
        pool_id: "jito_jitosol",
        name: "JitoSOL",
        category: PositionCategory.Staking,
        asset: "SOL",
        apy: 0.0740,
        tvl_usd: 780_000_000,
      },
      {
        pool_id: "jito_restaking_vault",
        name: "Jito Restaking Vault",
        category: PositionCategory.Restaking,
        asset: "JitoSOL",
        apy: 0.0890,
        tvl_usd: 14_500_000,
        deposit_asset: "SOL",
        // Phase 8.37 (レビュー L-F1): restaking の実 adapter 未実装 (fallback だと jitoSOL swap になる) — 実装まで view-only
        display_only: true,
      },
    ],
  },

  // ─── 10. Orca ──────────────────────────────────────────────
  {
    protocol_id: "orca",
    display_name: "Orca",
    primary_category: PositionCategory.LP,
    supported_assets: ["USDC", "SOL"],
    icon_id: "orca",
    icon_bg: COLOR.sodaText,
    // APY/TVL は Orca pool stats API 実測値ベース (2026-07-10、表示専用 fixture)
    pools: [
      {
        pool_id: "orca_usdc_usdt_whirlpool",
        name: "USDC-USDT Whirlpool",
        category: PositionCategory.LP,
        asset: "USDC-USDT",
        apy: 0.055,
        tvl_usd: 1_200_000,
        deposit_asset: "USDC",
      },
      {
        pool_id: "orca_sol_usdc_whirlpool",
        name: "SOL-USDC Whirlpool",
        category: PositionCategory.LP,
        asset: "SOL-USDC",
        apy: 0.46, // week APR (day は変動が大きい)
        tvl_usd: 32_500_000,
        deposit_asset: "USDC",
      },
      {
        pool_id: "orca_jitosol_sol_whirlpool",
        name: "JitoSOL-SOL Whirlpool",
        category: PositionCategory.LP,
        asset: "JitoSOL-SOL",
        apy: 0.011,
        tvl_usd: 31_400_000,
        deposit_asset: "SOL",
      },
    ],
  },

  // ─── 11. Hylo (Phase 8.27 — swap-earn 方式) ────────────────
  {
    protocol_id: "hylo",
    display_name: "Hylo",
    primary_category: PositionCategory.Staking,
    supported_assets: ["SOL", "USDC"],
    icon_id: "hylo",
    icon_bg: ICON_BG_HYLO,
    pools: [
      {
        pool_id: "hylo_hylosol",
        name: "hyloSOL Staking",
        category: PositionCategory.Staking,
        asset: "SOL",
        apy: 0.061, // live は Exponent underlyingApy で overlay
        tvl_usd: 20_000_000,
      },
      {
        pool_id: "hylo_shyusd",
        name: "sHYUSD Stability Pool",
        category: PositionCategory.Stable,
        asset: "USDC",
        apy: 0.10, // 実値ソース未発見 (Exponent hyUSD implied 近似)
        tvl_usd: 11_000_000,
      },
    ],
  },

  // ─── 12. Exponent (Phase 8.33 — read-only PT 一覧) ─────────
  // pools は BFF /menu-listings が live markets (api.exponent.finance) で置換する。
  // 本 fixture は offline/test 用 snapshot (2026-08-09 実測、lib/config/exponent-markets.ts
  // の 12 market full mirror と同期)。PT market は 1〜4 ヶ月で世代交代するため満期を
  // 過ぎた pool は buildExponentMenuPools の maturity filter で除外される
  // (menu に腐った pool は出ない)。
  {
    protocol_id: "exponent",
    display_name: "Exponent",
    primary_category: PositionCategory.PTYT,
    supported_assets: [
      "USX",
      "ONyc",
      "xSOL",
      "eUSX",
      "hyloSOL",
      "hyloSOL+",
      "hyUSD",
      "stSLX",
      "srONyc",
      "BulkSOL",
      "rkuSOL",
      "fragSOL",
    ],
    icon_id: "exponent",
    icon_bg: ICON_BG_BLACK,
    pools: [
      {
        pool_id: "exponent_pt_usx_20260916",
        name: "PT USX · 2026-09-16",
        category: PositionCategory.PTYT,
        asset: "USX",
        apy: 0.0472, // implied APY = PT 固定利回り
        tvl_usd: 36_500_000,
        display_only: true,
      },
      {
        pool_id: "exponent_pt_onyc_20260910",
        name: "PT ONyc · 2026-09-10",
        category: PositionCategory.PTYT,
        asset: "ONyc",
        apy: 0.1488,
        tvl_usd: 32_600_000,
        display_only: true,
      },
      {
        pool_id: "exponent_pt_xsol_20260812",
        name: "PT xSOL · 2026-08-12",
        category: PositionCategory.PTYT,
        asset: "xSOL",
        apy: 0.3652,
        tvl_usd: 0, // quote が xSOL 建てで USD 換算不能 (偽 USD を出さない)
        display_only: true,
      },
      {
        pool_id: "exponent_pt_eusx_20260916",
        name: "PT eUSX · 2026-09-16",
        category: PositionCategory.PTYT,
        asset: "eUSX",
        apy: 0.0611,
        tvl_usd: 5_800_000,
        display_only: true,
      },
      // ── 以下 2026-08-09 probe で追加 (maturity 順)。SOL/SLX quote は
      //    xSOL と同じく USD 換算不能 → tvl_usd 0 (偽 USD を出さない) ──
      {
        pool_id: "exponent_pt_hylosol_20260812",
        name: "PT hyloSOL · 2026-08-12",
        category: PositionCategory.PTYT,
        asset: "hyloSOL",
        apy: 0.139,
        tvl_usd: 0, // SOL quote
        display_only: true,
      },
      {
        pool_id: "exponent_pt_hylosolplus_20260812",
        name: "PT hyloSOL+ · 2026-08-12",
        category: PositionCategory.PTYT,
        asset: "hyloSOL+",
        apy: 0.4032,
        tvl_usd: 0, // SOL quote
        display_only: true,
      },
      {
        pool_id: "exponent_pt_hyusd_20260812",
        name: "PT hyUSD · 2026-08-12",
        category: PositionCategory.PTYT,
        asset: "hyUSD",
        apy: 0.1511,
        tvl_usd: 480_000,
        display_only: true,
      },
      {
        pool_id: "exponent_pt_stslx_20260821",
        name: "PT stSLX · 2026-08-21",
        category: PositionCategory.PTYT,
        asset: "stSLX",
        apy: 0.234,
        tvl_usd: 0, // SLX quote
        display_only: true,
      },
      {
        pool_id: "exponent_pt_sronyc_20260910",
        name: "PT srONyc · 2026-09-10",
        category: PositionCategory.PTYT,
        asset: "srONyc",
        apy: 0.1007,
        tvl_usd: 390_000,
        display_only: true,
      },
      {
        pool_id: "exponent_pt_bulksol_20261031",
        name: "PT BulkSOL · 2026-10-31",
        category: PositionCategory.PTYT,
        asset: "BulkSOL",
        apy: 0.0766,
        tvl_usd: 0, // SOL quote
        display_only: true,
      },
      {
        pool_id: "exponent_pt_rkusol_20261031",
        name: "PT rkuSOL · 2026-10-31",
        category: PositionCategory.PTYT,
        asset: "rkuSOL",
        apy: 0.0643,
        tvl_usd: 0, // SOL quote
        display_only: true,
      },
      {
        pool_id: "exponent_pt_fragsol_20261215",
        name: "PT fragSOL · 2026-12-15",
        category: PositionCategory.PTYT,
        asset: "fragSOL",
        apy: 0.0787,
        tvl_usd: 0, // SOL quote
        display_only: true,
      },
    ],
  },
];
