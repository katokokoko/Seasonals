/**
 * Ethereum mainnet の contract address / API endpoint。
 * すべて公式資料で確認済み (2026-09-26、docs/web/WORKLOG.md):
 * - Ethena sUSDe: docs.ethena.fi (v3 §17)
 * - Lido: docs.lido.fi/deployed-contracts/
 * - Uniswap CCA: github.com/Uniswap/continuous-clearing-auction (README deployments、v2.1.0 を含む 4 factory)
 * - Pendle: api-v2.pendle.finance/core/docs (v2/markets/all, v1/dashboard/positions/database/{user}, v3/sdk/{chainId}/convert)
 */
import { ETH_ASSET_ADDRESS } from "@workspace/lib/config/eth-assets";

// token address の canonical は lib/config/eth-assets.ts (portfolio と共有)
export const ETHENA = {
  sUSDe: ETH_ASSET_ADDRESS.sUSDe,
  USDe: ETH_ASSET_ADDRESS.USDe,
} as const;

export const LIDO = {
  stETH: ETH_ASSET_ADDRESS.stETH,
  wstETH: ETH_ASSET_ADDRESS.wstETH,
  withdrawalQueue: "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
} as const;

export const CCA = {
  factories: [
    { version: "v2.1.0", address: "0x000000001F26a0044BaA66024e7b6599c61963F8" },
    { version: "v2.0.0", address: "0x00cCa200BF124dBfA848937c553864f4B4CE0632" },
    { version: "v1.1.0", address: "0xCCccCcCAE7503Cac057829BF2811De42E16e0bD5" },
    { version: "v1.0.0", address: "0x0000ccaDF55C911a2FbC0BB9d2942Aa77c6FAa1D" },
  ],
  lens: "0xc3C65F5453A3674aDb693cbdA3C842545cD30f53",
} as const;

export const PENDLE_API = "https://api-v2.pendle.finance/core";
/**
 * Pendle PYLpOracle (mainnet)。PT / YT の SY 建て TWAP を返す。2026-09-26 に eth_getCode と
 * getOracleState / getPtToSyRate / getYtToSyRate の応答で実在を確認済み
 */
export const PENDLE_PY_LP_ORACLE = "0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2";
export const MAINNET_CHAIN_ID = 1;
