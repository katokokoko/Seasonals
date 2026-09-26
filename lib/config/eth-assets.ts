/**
 * Ethereum mainnet の asset registry — 評価額履歴 / Allocation donut の対象。
 *
 * **ここに載っている token (+ Pendle PT) だけ** を portfolio に数える。wallet に
 * 送りつけられる spam token を評価額に混ぜないため (Solana の KNOWN_PROTOCOL_MINTS
 * と同じ考え方)。address は公式資料で確認済みの値 (BFF の ethereum/config.ts と
 * ethereum/pricing.ts もここを参照する)。
 *
 * category は Seeker の Allocation と同じ規則:
 *   - wallet に置いてある stablecoin → `stable` (Solana の wallet_stable と同じ)
 *   - native / wrapped の base asset → `other` (Solana の wallet_sol と同じ)
 *   - LST → `staking`、yield-bearing stable → `stable`、PT → `pt_yt`
 */

import { PositionCategory } from "../types/enums";

export interface EthAsset {
  /** 小文字 address。native ETH は擬似キー "ETH" */
  key: string;
  /** checksum address (contract call 用)。native ETH は null */
  address: `0x${string}` | null;
  symbol: string;
  decimals: number;
  /** ProtocolBadge / ブランド色の key */
  protocolId: string;
  category: PositionCategory;
  /** protocol に預けたもの (Deposited スコープ) */
  deposited: boolean;
  /**
   * 残高が Transfer 無しで増える (rebase)。tx 差分からの逆算では過去残高が
   * 過大になるので、履歴では「近似」と明示する
   */
  rebasing?: boolean;
}

/** native ETH の asset key (ERC-20 address と衝突しない) */
export const ETH_NATIVE_KEY = "ETH";

export const ETH_ASSET_ADDRESS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  sUSDe: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  stETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
} as const;

function erc20(
  symbol: keyof typeof ETH_ASSET_ADDRESS,
  decimals: number,
  protocolId: string,
  category: PositionCategory,
  deposited: boolean,
  extra: Partial<EthAsset> = {}
): EthAsset {
  const address = ETH_ASSET_ADDRESS[symbol];
  return {
    key: address.toLowerCase(),
    address,
    symbol,
    decimals,
    protocolId,
    category,
    deposited,
    ...extra,
  };
}

export const ETH_ASSETS: readonly EthAsset[] = [
  {
    key: ETH_NATIVE_KEY,
    address: null,
    symbol: "ETH",
    decimals: 18,
    protocolId: "ethereum",
    category: PositionCategory.Other,
    deposited: false,
  },
  erc20("WETH", 18, "ethereum", PositionCategory.Other, false),
  erc20("USDC", 6, "wallet_stable", PositionCategory.Stable, false),
  erc20("USDT", 6, "wallet_stable", PositionCategory.Stable, false),
  erc20("USDe", 18, "ethena", PositionCategory.Stable, false),
  erc20("sUSDe", 18, "ethena", PositionCategory.Stable, true),
  erc20("stETH", 18, "lido", PositionCategory.Staking, true, { rebasing: true }),
  erc20("wstETH", 18, "lido", PositionCategory.Staking, true),
];

const BY_KEY = new Map(ETH_ASSETS.map((a) => [a.key, a]));

/** asset key (小文字 address / "ETH") → registry entry */
export function findEthAsset(key: string): EthAsset | undefined {
  return BY_KEY.get(key === ETH_NATIVE_KEY ? key : key.toLowerCase());
}

/** Pendle PT は market ごとに address が違うので registry ではなく動的に作る */
export function pendlePtAsset(
  address: string,
  symbol: string,
  decimals: number
): EthAsset {
  return {
    key: address.toLowerCase(),
    address: address as `0x${string}`,
    symbol,
    decimals,
    protocolId: "pendle",
    category: PositionCategory.PTYT,
    deposited: true,
  };
}
