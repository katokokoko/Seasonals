/**
 * Uniswap CCA (Continuous Clearing Auction) indexer + event 導出 (Ethereum v3 §3 Uniswap CCA)
 *
 * - 4 factory (v1.0.0〜v2.1.0) の AuctionCreated を getLogs で index
 * - Infura の getLogs は 10,000 block/回 が上限 (実測 2026-09-26) → 10k 分割、指数 backoff で再試行、
 *   範囲超過エラー時は分割幅を半分に。進捗 (scan 済み範囲 + auction 一覧) を .data/cca-index.json に保存し、
 *   再起動後は続きから (最新側を先に、次に過去へ遡る)
 * - 時刻は block 単位。現在 block から 12 秒/block で推定し「≈」表示 (v3 §17)
 * - 公開: 直近 / 開催中 auction の start / end / claim。address 別: BidSubmitted(owner) から bid ごとの
 *   exit / claim / refund
 */
import { decodeAbiParameters, decodeEventLog, pad, toEventSelector, toHex, type AbiEvent, type PublicClient } from "viem";
import { estimateBlockTime } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import { getEthClient, sanitizeError } from "./client";
import { auctionParametersAbi, ccaAuctionAbi, ccaFactoryAbi, erc20Abi } from "./abis";
import { CCA } from "./config";
import { baseEvent, etherscanAddress } from "./common";
import { registerPublicSource, registerUserSource } from "./events";
import { loadJson, saveJson } from "../persistence";

/** 最も古い factory (v1.0.0) の deploy block (getCode の二分探索で実測、2026-09-26) */
export const CCA_DEPLOY_MIN_BLOCK = 23_780_787n;
const MAX_CHUNK = 10_000n;
const THROTTLE_MS = 0; // getLogs の間隔は client の throttledFetch が保証する
const RECENT_BLOCKS = 7n * 7_200n; // address 別 bid の探索は終了後 ~7 日まで
const PUBLIC_RECENT_BLOCKS = 2n * 7_200n; // 公開 feed は開催中・予定 + 終了後 ~2 日
const PUBLIC_MIN_DURATION = 600n; // ~2h 未満の極短 auction (試験的なもの) は公開 feed から外す
const PUBLIC_MAX = 12;
const STORE = "cca-index";

export interface CcaAuction {
  auction: string;
  token: string;
  factory: string;
  amount: string; // uint256 (token smallest unit)
  currency: string;
  startBlock: string;
  endBlock: string;
  claimBlock: string;
  floorPriceQ96: string;
  requiredCurrencyRaised: string;
  createdBlock: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  currencySymbol?: string;
  currencyDecimals?: number;
  graduated?: boolean | null;
}

interface IndexState {
  /** scan 済み範囲 [low, high] (low > high なら未 scan) */
  low: string;
  high: string;
  auctions: CcaAuction[];
}

let state: IndexState | null = null;
let running: Promise<void> | null = null;
let lastError: string | null = null;

function load(): IndexState {
  if (!state) state = loadJson<IndexState>(STORE) ?? { low: "1", high: "0", auctions: [] };
  return state;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 指数 backoff 付き getLogs。範囲超過なら分割幅を半分にして呼び出し側に知らせる */
async function getLogsChunk(client: PublicClient, from: bigint, to: bigint) {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.getLogs({ address: CCA.factories.map((f) => f.address), event: ccaFactoryAbi[0], fromBlock: from, toBlock: to });
    } catch (e) {
      const msg = sanitizeError(e);
      if (/exceeds limit|range/i.test(msg) && to > from) throw new RangeError(msg);
      if (attempt >= 5) throw new Error(msg);
      await sleep(delay);
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

export function decodeAuctionCreated(log: {
  address: string;
  blockNumber: bigint | null;
  args: { auction?: string; token?: string; amount?: bigint; configData?: `0x${string}` };
}): CcaAuction | null {
  const { auction, token, amount, configData } = log.args;
  if (!auction || !token || amount === undefined || !configData) return null;
  try {
    const [p] = decodeAbiParameters(auctionParametersAbi, configData);
    return {
      auction,
      token,
      factory: log.address,
      amount: amount.toString(),
      currency: p.currency,
      startBlock: p.startBlock.toString(),
      endBlock: p.endBlock.toString(),
      claimBlock: p.claimBlock.toString(),
      floorPriceQ96: p.floorPrice.toString(),
      requiredCurrencyRaised: p.requiredCurrencyRaised.toString(),
      createdBlock: (log.blockNumber ?? 0n).toString(),
    };
  } catch {
    return null;
  }
}

async function scanStep(client: PublicClient, latest: bigint): Promise<boolean> {
  const s = load();
  let low = BigInt(s.low);
  let high = BigInt(s.high);
  let from: bigint;
  let to: bigint;
  if (low > high) {
    // 初回: 最新から遡る
    to = latest;
    from = latest - MAX_CHUNK + 1n;
  } else if (high < latest) {
    from = high + 1n;
    to = latest - high > MAX_CHUNK ? high + MAX_CHUNK : latest;
  } else if (low > CCA_DEPLOY_MIN_BLOCK) {
    to = low - 1n;
    from = to - MAX_CHUNK + 1n < CCA_DEPLOY_MIN_BLOCK ? CCA_DEPLOY_MIN_BLOCK : to - MAX_CHUNK + 1n;
  } else {
    return false; // 全範囲 scan 済み
  }
  let span = to - from + 1n;
  for (;;) {
    try {
      const logs = await getLogsChunk(client, to - span + 1n, to);
      for (const l of logs) {
        const a = decodeAuctionCreated(l as never);
        if (a && !s.auctions.some((x) => x.auction.toLowerCase() === a.auction.toLowerCase())) s.auctions.push(a);
      }
      const doneFrom = to - span + 1n;
      if (low > high) {
        low = doneFrom;
        high = to;
      } else if (doneFrom > high) high = to;
      else low = doneFrom;
      s.low = low.toString();
      s.high = high.toString();
      saveJson(STORE, s);
      return true;
    } catch (e) {
      if (e instanceof RangeError && span > 1_000n) {
        span /= 2n;
        continue;
      }
      throw e;
    }
  }
}

/** background indexing を開始 (多重起動しない)。完了まで chunk ごとに進捗保存 */
export function ensureIndexing(): void {
  const client = getEthClient();
  if (!client || running) return;
  running = (async () => {
    try {
      let latest = await client.getBlockNumber();
      for (let i = 0; ; i++) {
        const more = await scanStep(client, latest);
        if (!more) break;
        await sleep(THROTTLE_MS);
        if (i % 20 === 0) latest = await client.getBlockNumber();
      }
      lastError = null;
    } catch (e) {
      lastError = sanitizeError(e);
    } finally {
      running = null;
    }
  })();
}

export function indexProgress() {
  const s = load();
  const low = BigInt(s.low);
  const high = BigInt(s.high);
  const scanned = low > high ? 0n : high - low + 1n;
  return {
    auctions: s.auctions.length,
    scannedBlocks: scanned.toString(),
    fromBlock: s.low,
    toBlock: s.high,
    complete: low <= high && low <= CCA_DEPLOY_MIN_BLOCK,
    running: running !== null,
    lastError,
  };
}

async function enrich(client: PublicClient, list: CcaAuction[], latest: bigint): Promise<void> {
  const need = list.filter((a) => a.tokenSymbol === undefined || (a.graduated == null && BigInt(a.endBlock) <= latest));
  if (need.length === 0) return;
  const calls = need.flatMap((a) => [
    { address: a.token as `0x${string}`, abi: erc20Abi, functionName: "symbol" as const },
    { address: a.token as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
    ...(a.currency === "0x0000000000000000000000000000000000000000"
      ? []
      : [
          { address: a.currency as `0x${string}`, abi: erc20Abi, functionName: "symbol" as const },
          { address: a.currency as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
        ]),
    { address: a.auction as `0x${string}`, abi: ccaAuctionAbi, functionName: "isGraduated" as const },
  ]);
  const res = await client.multicall({ contracts: calls as never, allowFailure: true });
  let i = 0;
  for (const a of need) {
    const pick = () => res[i++] as { status: string; result?: unknown };
    const sym = pick();
    const dec = pick();
    // 失敗 (429 等) は未設定のまま残し、次回再取得する
    if (sym.status === "success") a.tokenSymbol = String(sym.result);
    if (dec.status === "success") a.tokenDecimals = Number(dec.result);
    if (a.currency === "0x0000000000000000000000000000000000000000") {
      a.currencySymbol = "ETH";
      a.currencyDecimals = 18;
    } else {
      const cs = pick();
      const cd = pick();
      if (cs.status === "success") a.currencySymbol = String(cs.result);
      if (cd.status === "success") a.currencyDecimals = Number(cd.result);
    }
    const g = pick();
    if (BigInt(a.endBlock) <= latest && g.status === "success") a.graduated = Boolean(g.result);
  }
  saveJson(STORE, load());
}

const RISK = "A high floor price relative to demand can lose funds (Uniswap CCA docs). Times are estimated from block numbers (≈12 s/block).";

export function deriveAuctionPublicEvents(a: CcaAuction, head: { block: number; timestampSec: number }, observedAt: string): TimelineEvent[] {
  const sym = a.tokenSymbol ?? "Token";
  const t = (b: string) => estimateBlockTime(Number(b), head);
  const base = {
    protocol: "cca",
    protocolName: "Uniswap CCA",
    asset: `${sym} auction`,
    atApprox: true,
    requiresWallet: false,
    source: "cca:factory-logs",
    observedAt,
    links: [etherscanAddress(a.auction)],
    metrics: [
      ...(a.tokenDecimals !== undefined ? [{ label: "Tokens offered", kind: "token" as const, value: { value: a.amount, decimals: a.tokenDecimals, symbol: sym } }] : []),
      ...(a.currencyDecimals !== undefined
        ? [
            {
              label: "Required raise to graduate",
              kind: "token" as const,
              value: { value: a.requiredCurrencyRaised, decimals: a.currencyDecimals, symbol: a.currencySymbol ?? "currency" },
            },
          ]
        : []),
      { label: "Graduation", kind: "text" as const, value: a.graduated == null ? "Not decided yet" : a.graduated ? "Graduated" : "Not graduated (refunds)" },
      {
        label: "Token contract",
        kind: "text" as const,
        value: `${a.token.slice(0, 8)}…${a.token.slice(-6)} — the symbol is chosen by the token creator; verify the contract before bidding.`,
      },
      { label: "Blocks", kind: "text" as const, value: `start ${a.startBlock} · end ${a.endBlock} · claim ${a.claimBlock}` },
      { label: "Risk", kind: "text" as const, value: RISK },
    ],
  };
  const out: TimelineEvent[] = [];
  if (Number(a.startBlock) > head.block)
    out.push(baseEvent({ ...base, id: `ethereum:cca:auction_start:${a.auction.toLowerCase()}`, kind: "auction_start", title: `${sym} auction starts`, at: t(a.startBlock) }));
  out.push(baseEvent({ ...base, id: `ethereum:cca:auction_end:${a.auction.toLowerCase()}`, kind: "auction_end", title: `${sym} auction ends`, at: t(a.endBlock) }));
  if (a.graduated !== false && a.claimBlock !== a.endBlock)
    out.push(baseEvent({ ...base, id: `ethereum:cca:auction_claim:${a.auction.toLowerCase()}`, kind: "auction_claim", title: `${sym} auction claim opens`, at: t(a.claimBlock) }));
  return out;
}

export interface CcaBid {
  auction: string;
  bidId: string;
  priceQ96: string;
  amount: string;
  exited: boolean;
  claimed: boolean;
}

export function deriveBidEvents(owner: string, a: CcaAuction, bid: CcaBid, head: { block: number; timestampSec: number }, observedAt: string): TimelineEvent[] {
  const sym = a.tokenSymbol ?? "token";
  const ended = head.block >= Number(a.endBlock);
  const claimOpen = head.block >= Number(a.claimBlock);
  const idBase = `${owner.toLowerCase()}:${a.auction.toLowerCase()}:${bid.bidId}`;
  const amount = a.currencyDecimals !== undefined ? { amount: { value: bid.amount, decimals: a.currencyDecimals, symbol: a.currencySymbol ?? "currency" } } : {};
  const common = {
    protocol: "cca",
    protocolName: "Uniswap CCA",
    asset: `${sym} bid #${bid.bidId}`,
    atApprox: true,
    owner,
    ...amount,
    links: [etherscanAddress(a.auction)],
    source: "cca:bid-logs",
    observedAt,
    metrics: [{ label: "Risk", kind: "text" as const, value: RISK }],
  };
  if (ended && a.graduated === false) {
    return [
      baseEvent({
        ...common,
        id: `ethereum:cca:auction_refund:${idBase}`,
        kind: "auction_refund",
        title: `${sym} auction did not graduate — refund`,
        at: estimateBlockTime(Number(a.endBlock), head),
        settled: bid.exited,
        actions: [{ actionType: "cca_exit_bid", label: "Exit bid (refund)", requiresWallet: true, availability: bid.exited ? "not_yet" : "available", ...(bid.exited ? { reason: "Already exited." } : {}), params: { auction: a.auction, bidId: bid.bidId } }],
      }),
    ];
  }
  return [
    baseEvent({
      ...common,
      id: `ethereum:cca:auction_end:${idBase}`,
      kind: "auction_end",
      title: `${sym} auction ends — exit bid`,
      at: estimateBlockTime(Number(a.endBlock), head),
      settled: bid.exited,
      actions: [
        {
          actionType: "cca_exit_bid",
          label: "Exit bid",
          requiresWallet: true,
          availability: ended && !bid.exited ? "available" : "not_yet",
          ...(ended ? (bid.exited ? { reason: "Already exited." } : {}) : { reason: "Available after the end block." }),
          params: { auction: a.auction, bidId: bid.bidId },
        },
      ],
    }),
    baseEvent({
      ...common,
      id: `ethereum:cca:auction_claim:${idBase}`,
      kind: "auction_claim",
      title: `${sym} tokens claimable`,
      at: estimateBlockTime(Number(a.claimBlock), head),
      settled: bid.claimed,
      actions: [
        {
          actionType: "cca_claim",
          label: "Claim tokens",
          requiresWallet: true,
          availability: claimOpen && a.graduated === true && bid.exited && !bid.claimed ? "available" : "not_yet",
          ...(claimOpen && a.graduated === true && bid.exited ? {} : { reason: "Available after the claim block, once the auction graduated and the bid is exited." }),
          params: { auction: a.auction, bidId: bid.bidId },
        },
      ],
    }),
  ];
}

async function head(client: PublicClient) {
  const b = await client.getBlock();
  return { block: Number(b.number), timestampSec: Number(b.timestamp) };
}

async function relevantAuctions(client: PublicClient) {
  ensureIndexing();
  const h = await head(client);
  const list = load().auctions.filter((a) => BigInt(a.endBlock) + RECENT_BLOCKS >= BigInt(h.block));
  await enrich(client, list, BigInt(h.block));
  return { h, list };
}

export async function fetchCcaPublicEvents(observedAt: string): Promise<TimelineEvent[]> {
  const client = getEthClient();
  if (!client) throw new Error("Ethereum RPC is not configured.");
  const { h, list } = await relevantAuctions(client);
  const pub = list
    .filter((a) => BigInt(a.endBlock) - BigInt(a.startBlock) >= PUBLIC_MIN_DURATION)
    .filter((a) => BigInt(a.endBlock) + PUBLIC_RECENT_BLOCKS >= BigInt(h.block))
    // 近いものから (終了直後 → 開催中 → 近日終了)。何年も先に終わる auction は後回し
    .sort((x, y) => Number(BigInt(x.endBlock) - BigInt(y.endBlock)))
    .slice(0, PUBLIC_MAX);
  return pub.flatMap((a) => deriveAuctionPublicEvents(a, h, observedAt));
}

const userCache = new Map<string, { at: number; events: TimelineEvent[] }>();

/**
 * address 別 bid: 全 relevant auction をまとめて 1 回の eth_getLogs (10k block 単位) で、
 * BidSubmitted / BidExited / TokensClaimed を owner topic (3 event とも topic2) で絞る。
 * auction ごとに呼ぶと数百回になり Infura の 429 に当たるため (実測)。
 */
const userScans = new Map<string, Promise<TimelineEvent[]>>();
const USER_SCAN_WAIT_MS = 6_000;

/**
 * bid scan は getLogs を数十回 (700ms 間隔) 使うため、他 source の応答を待たせないよう
 * 6 秒で打ち切り、scan は background で続けて完了後に cache する (次回の取得で出る)。
 */
export async function fetchCcaUserEvents(owner: string, observedAt: string): Promise<TimelineEvent[]> {
  const key = owner.toLowerCase();
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.events;
  let scan = userScans.get(key);
  if (!scan) {
    scan = scanUserBids(owner, observedAt).finally(() => userScans.delete(key));
    userScans.set(key, scan);
    scan.catch(() => undefined);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Scanning auction bids in the background; they will appear on the next refresh.")), USER_SCAN_WAIT_MS);
  });
  try {
    return await Promise.race([scan, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function scanUserBids(owner: string, observedAt: string): Promise<TimelineEvent[]> {
  const client = getEthClient();
  if (!client) throw new Error("Ethereum RPC is not configured.");
  const { h, list } = await relevantAuctions(client);
  if (list.length === 0) return [];
  const byAddr = new Map(list.map((a) => [a.auction.toLowerCase(), a]));
  const topic0 = ccaAuctionAbi.slice(0, 3).map((ev) => toEventSelector(ev as AbiEvent));
  const ownerTopic = pad(owner.toLowerCase() as `0x${string}`, { size: 32 });
  const from = list.reduce((m, a) => (BigInt(a.startBlock) < m ? BigInt(a.startBlock) : m), BigInt(h.block));
  const latest = BigInt(h.block);
  const bids = new Map<string, CcaBid>();
  for (let s0 = from; s0 <= latest; s0 += MAX_CHUNK) {
    const e0 = s0 + MAX_CHUNK - 1n > latest ? latest : s0 + MAX_CHUNK - 1n;
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [{ address: [...byAddr.keys()] as `0x${string}`[], topics: [topic0, null, ownerTopic], fromBlock: toHex(s0), toBlock: toHex(e0) }],
    })) as Array<{ address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` }>;
    for (const l of logs) {
      let dec;
      try {
        dec = decodeEventLog({ abi: ccaAuctionAbi, topics: l.topics, data: l.data });
      } catch {
        continue;
      }
      const args = dec.args as Record<string, unknown>;
      if (dec.eventName === "BidSubmitted") {
        const key = `${l.address.toLowerCase()}:${String(args.id)}`;
        bids.set(key, { auction: l.address, bidId: String(args.id), priceQ96: String(args.priceQ96), amount: String(args.amount), exited: false, claimed: false });
      } else {
        const key = `${l.address.toLowerCase()}:${String(args.bidId)}`;
        const b = bids.get(key);
        if (b && dec.eventName === "BidExited") b.exited = true;
        if (b && dec.eventName === "TokensClaimed") b.claimed = true;
      }
    }
    await sleep(THROTTLE_MS);
  }
  const events = [...bids.values()].flatMap((b) => {
    const a = byAddr.get(b.auction.toLowerCase());
    return a ? deriveBidEvents(owner, a, b, h, observedAt) : [];
  });
  userCache.set(owner.toLowerCase(), { at: Date.now(), events });
  return events;
}

registerPublicSource({ name: "cca:auctions", needsRpc: true, run: fetchCcaPublicEvents });
registerUserSource((owner) => ({ name: "cca:bids", needsRpc: true, run: (t) => fetchCcaUserEvents(owner, t) }));

export function _resetCcaForTest() {
  state = { low: "1", high: "0", auctions: [] };
}
export function _setCcaAuctionsForTest(a: CcaAuction[]) {
  state = { low: String(CCA_DEPLOY_MIN_BLOCK), high: "99999999", auctions: a };
}
