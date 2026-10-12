/**
 * Ethereum の評価額履歴 source (portfolio/engine の ChainHistorySource 実装)
 *
 * Solana 8.58 と同じ「現在残高 − tx 差分 → 各時刻の残高 × その時刻の価格」。
 * chain 固有なのは入力の取り方だけ:
 *   - 現在残高: RPC (getBalance + balanceOf multicall)
 *   - 差分    : Etherscan V2 (txlist / txlistinternal / tokentx)。native ETH は
 *               **gas 代まで**差し引く (Solana の nativeBalanceChange が fee 込みなのと同じ厳密さ)
 *   - 過去価格: DefiLlama (`ethereum:<address>`、native は `coingecko:ethereum`)
 *   - 現在価格: Chainlink (ETH / USDC / USDe / stETH、stale は使わない) → 無ければ DefiLlama
 *
 * 対象は lib/config/eth-assets.ts の registry + Pendle PT のみ (spam token を数えない)。
 * 既知の近似は応答で明示する:
 *   - stETH は rebase が Transfer に出ないため過去残高がやや過大 → approximated
 *   - Aave V4 は wallet の ERC-20 ではなく AaveKit が USD 集計しか返さない
 *     → 履歴から除外 (`excluded_from_history`)、holdings には現在値として載せる
 */

import {
  ETH_ASSET_ADDRESS,
  ETH_ASSETS,
  ETH_NATIVE_KEY,
  pendlePtAsset,
  type EthAsset,
} from "@workspace/lib/config/eth-assets";
import { PositionCategory } from "@workspace/lib/types";

import {
  EtherscanNotConfiguredError,
  etherscanApiKey,
  fetchAccountHistory,
  type EtherscanTokenTx,
  type EtherscanTx,
} from "../clients/etherscan";
import { anchorSeries, fetchLlamaPriceSeries } from "../clients/llama-history";
import type { PriceSeries } from "../clients/pyth-history";
import {
  createHistoryEngine,
  type ExtraHolding,
  type HistoryInputs,
} from "../portfolio/engine";
import type { BalanceDelta, HistoryAsset } from "../portfolio-history";
import { erc20Abi } from "./abis";
import { getAavePositions, type AavePositionView } from "./aave";
import { getEthClient, sanitizeError } from "./client";
import { fetchPendleMarkets } from "./pendle";
import { priceEthAssetsNow } from "./prices";

const UINT_RE = /^[0-9]+$/;

// ── 純関数: Etherscan の行 → 符号付き差分 ─────────────────────────────────────

export interface EtherscanHistoryRows {
  txs: EtherscanTx[];
  internals: EtherscanTx[];
  tokenTxs: EtherscanTokenTx[];
}

/**
 * Etherscan の 3 種の行を `BalanceDelta[]` にする (全て bigint、§4.5)。
 *
 * - 通常 tx: 受取 `+value`、送信 `−value` (**成功時のみ**)。送信者は失敗 tx でも
 *   `gasUsed × gasPrice` を払う (txlist の gasPrice は実効 gas price)
 * - internal tx: contract から / への ETH (失敗は無視)
 * - ERC-20: `isTracked(contract)` のものだけ (registry + PT。spam を数えない)
 * - 自己送金は + と − が両方立って相殺される (gas だけが残る)
 */
export function ethDeltasFromEtherscan(
  address: string,
  rows: EtherscanHistoryRows,
  isTracked: (key: string) => boolean
): BalanceDelta[] {
  const me = address.toLowerCase();
  const out: BalanceDelta[] = [];
  const push = (timeStamp: string, key: string, amount: bigint) => {
    const timestamp = Number(timeStamp);
    if (!Number.isFinite(timestamp) || amount === 0n) return;
    out.push({ timestamp, mint: key, amount });
  };
  const uint = (v: string | undefined): bigint | null =>
    typeof v === "string" && UINT_RE.test(v) ? BigInt(v) : null;

  for (const tx of rows.txs) {
    const from = tx.from?.toLowerCase();
    const to = tx.to?.toLowerCase();
    const value = uint(tx.value) ?? 0n;
    const ok = tx.isError !== "1";
    if (from === me) {
      const gas = (uint(tx.gasUsed) ?? 0n) * (uint(tx.gasPrice) ?? 0n);
      push(tx.timeStamp, ETH_NATIVE_KEY, -(gas + (ok ? value : 0n)));
    }
    if (to === me && ok) push(tx.timeStamp, ETH_NATIVE_KEY, value);
  }
  for (const tx of rows.internals) {
    if (tx.isError === "1") continue;
    const value = uint(tx.value);
    if (value === null) continue;
    if (tx.from?.toLowerCase() === me) push(tx.timeStamp, ETH_NATIVE_KEY, -value);
    if (tx.to?.toLowerCase() === me) push(tx.timeStamp, ETH_NATIVE_KEY, value);
  }
  for (const tx of rows.tokenTxs) {
    const key = tx.contractAddress?.toLowerCase();
    if (!key || !isTracked(key)) continue;
    const value = uint(tx.value);
    if (value === null) continue;
    if (tx.from?.toLowerCase() === me) push(tx.timeStamp, key, -value);
    if (tx.to?.toLowerCase() === me) push(tx.timeStamp, key, value);
  }
  return out;
}

// 現在単価の合成 (Chainlink → 換算 → Llama) は prices.ts に移した (Strategy Brief と共有)
export { chainlinkToUsd8 } from "./prices";

/** Aave V4 の spoke 別 net balance → holdings の現在値 (履歴には入らない) */
export function aaveExtraHoldings(positions: AavePositionView[]): ExtraHolding[] {
  const out: ExtraHolding[] = [];
  for (const p of positions) {
    const usd = p.netBalanceUsd;
    if (!usd || !/^[0-9]+\.[0-9]{8}$/.test(usd) || /^0\.0+$/.test(usd)) continue;
    out.push({
      symbol: `Aave V4 · ${p.spokeName}`,
      protocol_id: "aave",
      category: PositionCategory.Lending,
      usd,
      deposited: true,
      in_history: false,
    });
  }
  return out;
}

// ── I/O: 入力の取得 ───────────────────────────────────────────────────────

const PT_CACHE_TTL_MS = 60 * 60_000;
let ptCache: { at: number; data: Map<string, string> } | null = null;

/** Pendle PT address (小文字) → 表示名 "PT-<market>"。1 時間 cache、失敗は空 */
async function pendlePtNames(): Promise<Map<string, string>> {
  if (ptCache && Date.now() - ptCache.at < PT_CACHE_TTL_MS) return ptCache.data;
  try {
    const markets = await fetchPendleMarkets();
    const data = new Map<string, string>();
    for (const m of markets) {
      const pt = (m.pt.includes("-") ? m.pt.split("-")[1]! : m.pt).toLowerCase();
      data.set(pt, `PT-${m.name}`);
    }
    ptCache = { at: Date.now(), data };
    return data;
  } catch {
    return ptCache?.data ?? new Map();
  }
}

export function _clearEthereumHistoryCacheForTest(): void {
  ptCache = null;
}

export async function loadEthereumHistoryInputs(
  address: string,
  days: number,
  nowSeconds: number
): Promise<HistoryInputs | null> {
  if (!etherscanApiKey()) throw new EtherscanNotConfiguredError();
  const client = getEthClient();
  if (!client) throw new Error("Ethereum RPC is not configured");
  const cutoffSec = nowSeconds - days * 86_400;

  // 1. 差分 (Etherscan は client 側で直列化される) と PT 一覧、Aave (現在値のみ)
  const [txs, internals, tokenTxs, ptNames, aave] = await Promise.all([
    fetchAccountHistory<EtherscanTx>("txlist", address, { cutoffSec }),
    fetchAccountHistory<EtherscanTx>("txlistinternal", address, { cutoffSec }),
    fetchAccountHistory<EtherscanTokenTx>("tokentx", address, { cutoffSec }),
    pendlePtNames(),
    getAavePositions(address).catch(() => [] as AavePositionView[]),
  ]);

  // 2. 対象 asset = registry + wallet に出入りした Pendle PT
  const tracked = new Map<string, EthAsset>(ETH_ASSETS.map((a) => [a.key, a]));
  for (const t of tokenTxs.rows) {
    const key = t.contractAddress?.toLowerCase();
    const name = key ? ptNames.get(key) : undefined;
    if (!key || !name || tracked.has(key)) continue;
    const decimals = Number(t.tokenDecimal);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    tracked.set(key, pendlePtAsset(t.contractAddress, name, decimals));
  }
  const deltas = ethDeltasFromEtherscan(
    address,
    { txs: txs.rows, internals: internals.rows, tokenTxs: tokenTxs.rows },
    (key) => tracked.has(key)
  );

  // 3. 現在残高 (RPC)。失敗は上流障害として throw (route で 503)
  const erc20s = [...tracked.values()].filter((a) => a.address !== null);
  let ethBalance: bigint;
  let tokenBalances: Array<{ status: string; result?: unknown }>;
  try {
    [ethBalance, tokenBalances] = await Promise.all([
      client.getBalance({ address: address as `0x${string}` }),
      client.multicall({
        contracts: erc20s.map((a) => ({
          address: a.address!,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [address as `0x${string}`],
        })),
        allowFailure: true,
      }),
    ]);
  } catch (err) {
    throw new Error(sanitizeError(err));
  }
  const current = new Map<string, bigint>();
  if (ethBalance > 0n) current.set(ETH_NATIVE_KEY, ethBalance);
  erc20s.forEach((a, i) => {
    const r = tokenBalances[i];
    if (r?.status === "success" && typeof r.result === "bigint" && r.result > 0n) {
      current.set(a.key, r.result);
    }
  });

  // 今も持っているか、window 内に出入りがあった asset だけを値付けする
  const active = [...tracked.values()].filter(
    (a) => current.has(a.key) || deltas.some((d) => d.mint === a.key)
  );
  const extraHoldings = aaveExtraHoldings(aave);
  if (active.length === 0 && extraHoldings.length === 0) return null;

  // 4. 現在単価: Chainlink (stale は使わない) → on-chain 換算 → DefiLlama (prices.ts)
  const currentUsd = await priceEthAssetsNow(active.map((a) => a.key));

  const assets: HistoryAsset[] = active.map((a) => ({
    mint: a.key,
    symbol: a.symbol,
    decimals: a.decimals,
    deposited: a.deposited,
    currentUsd8: currentUsd.get(a.key),
    protocolId: a.protocolId,
    category: a.category,
  }));

  return {
    current,
    assets,
    deltas,
    oldestSeen: Math.min(
      nowSeconds,
      ...[...txs.rows, ...internals.rows, ...tokenTxs.rows]
        .map((r) => Number(r.timeStamp))
        .filter(Number.isFinite)
    ),
    fetchedDays: days,
    complete: txs.complete && internals.complete && tokenTxs.complete,
    extraHoldings,
    ...(extraHoldings.length > 0 ? { excludedFromHistory: ["Aave V4"] } : {}),
    approximatedSymbols: active
      .filter((a) => a.rebasing && current.has(a.key))
      .map((a) => a.symbol),
  };
}

/** 過去価格: DefiLlama (1 リクエストで全 asset)。右端は現在単価に揃える */
export async function ethereumPriceSeries(
  assets: HistoryAsset[],
  fromSec: number,
  toSec: number,
  stepSec: number
): Promise<Map<string, PriceSeries>> {
  const series = await fetchLlamaPriceSeries(
    assets.map((a) => a.mint),
    fromSec,
    toSec,
    stepSec,
    "ethereum"
  );
  const out = new Map<string, PriceSeries>();
  for (const a of assets) {
    const s = series.get(a.mint);
    if (s) out.set(a.mint, anchorSeries(s, a.currentUsd8));
  }
  return out;
}

export const ethereumHistoryEngine = createHistoryEngine({
  chain: "ethereum",
  nativePriceKey: ETH_NATIVE_KEY,
  loadInputs: loadEthereumHistoryInputs,
  priceSeries: ethereumPriceSeries,
});
