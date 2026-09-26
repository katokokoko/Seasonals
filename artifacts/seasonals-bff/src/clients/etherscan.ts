/**
 * Etherscan API V2 — address の tx 履歴 (評価額履歴の差分の出所)
 *
 * Infura RPC だけでは address 別の過去 tx を引けない (eth_getLogs は 10k block
 * 制限で 1 年分に数百 call、しかも native ETH / gas / internal tx は取れない)。
 * Etherscan の account module は 3 本で全部そろう:
 *   - txlist         : 通常 tx (value と **gas 代**。失敗 tx でも gas は払う)
 *   - txlistinternal : contract から来る ETH (Lido withdrawal の claim 等)
 *   - tokentx        : ERC-20 Transfer
 * V2 は `chainid` を変えるだけで Base / Arbitrum 等にも使える
 * (新チェーン追加の手順: docs/portfolio-history-design.md)。
 *
 * - key は server env `ETHERSCAN_API_KEY` のみ。エラー文言に key / URL を出さない
 * - free tier は 3〜5 req/s。全 call を直列 + 最小間隔で流す
 * - 値はすべて string のまま返す (bigint 化は呼び手、CLAUDE.md §3)
 */

import { sanitizeError } from "../ethereum/client";
import { fetchWithTimeout } from "./http";

const API_URL = "https://api.etherscan.io/v2/api";
/** 1 page の件数。page × offset ≤ 10000 が API の上限 */
export const ETHERSCAN_PAGE_SIZE = 1000;
/** 1 action あたりの page 上限 (= 最大 5000 件)。超えたら「取り切れていない」 */
export const ETHERSCAN_MAX_PAGES = 5;
/** free tier (3 req/s) に収まる最小間隔 */
const MIN_GAP_MS = 350;
const FETCH_TIMEOUT_MS = 15_000;

export type EtherscanAction = "txlist" | "txlistinternal" | "tokentx";

/** 通常 tx / internal tx の共通部分 (Etherscan の field 名のまま) */
export interface EtherscanTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError?: string;
  gasUsed?: string;
  gasPrice?: string;
}

export interface EtherscanTokenTx extends EtherscanTx {
  contractAddress: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
}

export class EtherscanNotConfiguredError extends Error {
  constructor() {
    super("ETHERSCAN_API_KEY is not configured");
    this.name = "EtherscanNotConfiguredError";
  }
}

export function etherscanApiKey(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const key = env.ETHERSCAN_API_KEY?.trim();
  return key ? key : null;
}

let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** 全 call を直列化して最小間隔を空ける (free tier の rate limit 対策) */
function scheduled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

export function _resetEtherscanQueueForTest(): void {
  lastCallAt = 0;
  queue = Promise.resolve();
}

interface EtherscanEnvelope<T> {
  status?: string;
  message?: string;
  result?: T[] | string;
}

async function fetchPage<T>(
  action: EtherscanAction,
  address: string,
  page: number,
  key: string,
  chainId: number
): Promise<T[]> {
  const params = new URLSearchParams({
    chainid: String(chainId),
    module: "account",
    action,
    address,
    startblock: "0",
    endblock: "99999999",
    page: String(page),
    offset: String(ETHERSCAN_PAGE_SIZE),
    sort: "desc",
    apikey: key,
  });
  try {
    const res = await scheduled(() =>
      fetchWithTimeout(`${API_URL}?${params.toString()}`, { method: "GET" }, FETCH_TIMEOUT_MS)
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} from etherscan`);
    const body = (await res.json()) as EtherscanEnvelope<T>;
    if (Array.isArray(body.result)) return body.result;
    // status "0" + "No transactions found" は「0 件」であって失敗ではない
    if (/no transactions found/i.test(body.message ?? "")) return [];
    throw new Error(
      `etherscan ${action}: ${typeof body.result === "string" ? body.result : body.message ?? "unexpected response"}`
    );
  } catch (err) {
    throw new Error(sanitizeError(err));
  }
}

/**
 * 新しい順に page を読み、`cutoffSec` より古い tx に届くか件数が尽きたら止める。
 * `complete` = cutoff か wallet の最初の tx まで取り切れたか (page 上限なら false)。
 */
export async function fetchAccountHistory<T extends EtherscanTx>(
  action: EtherscanAction,
  address: string,
  opts: { cutoffSec: number; chainId?: number; maxPages?: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ rows: T[]; complete: boolean }> {
  const key = etherscanApiKey(env);
  if (!key) throw new EtherscanNotConfiguredError();
  const rows: T[] = [];
  const maxPages = opts.maxPages ?? ETHERSCAN_MAX_PAGES;
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage<T>(action, address, page, key, opts.chainId ?? 1);
    rows.push(...batch);
    const oldest = batch.length
      ? Math.min(...batch.map((r) => Number(r.timeStamp)))
      : Infinity;
    if (batch.length < ETHERSCAN_PAGE_SIZE || oldest <= opts.cutoffSec) {
      return { rows, complete: true };
    }
  }
  return { rows, complete: false };
}
