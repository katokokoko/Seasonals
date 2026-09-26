/**
 * Ethereum mainnet の contract address / API endpoint。
 * すべて公式資料で確認済み (2026-09-26、docs/web/WORKLOG.md):
 * - Ethena sUSDe: docs.ethena.fi (v3 §17)
 * - Lido: docs.lido.fi/deployed-contracts/
 * - Uniswap CCA: github.com/Uniswap/continuous-clearing-auction (README deployments、v2.1.0 を含む 4 factory)
 * - Pendle: api-v2.pendle.finance/core/docs (v2/markets/all, v1/dashboard/positions/database/{user}, v3/sdk/{chainId}/convert)
 */
export const ETHENA = {
  sUSDe: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
} as const;

export const LIDO = {
  stETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
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
export const MAINNET_CHAIN_ID = 1;
