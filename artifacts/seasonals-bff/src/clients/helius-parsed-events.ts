/**
 * helius-parsed-events — Helius Parsed Events (transaction-history) client (Phase C)
 *
 *   POST https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key=<key>
 *   body { address, limit (1-100), beforeSignature?, afterSignature?, paginationToken?,
 *          time?: { gte }, includeRawTransaction? }   ← 未知の field は 400 で拒否される
 *
 * Enhanced Transactions (100 credit / req) の後継で **10 credit / req**。BFF の derivation
 * (`computeLpCostBasisByPositionKey` / `computeCostBasisByShareMint` / `mapTxsToWalletTimeEvents` /
 * `loadSolanaHistoryInputs`) は Enhanced の `accountData[]` だけを読むので、`toWalletTx` で
 * その shape (`HeliusEnhancedTx`) を合成する。
 *
 * ## accountData の合成
 * - **source A** (`includeRawTransaction: true` の `rawTransaction.meta` がある時。2026-10-12 の録画で
 *   14/14 件にあり): 口座一覧 = `message.accountKeys` ++ `meta.loadedAddresses.writable` ++ `.readonly`
 *   (= `pre/postBalances` の index 順)。口座ごとに `nativeBalanceChange = post − pre` (fee / rent 込み)、
 *   token account ごとに `pre/postTokenBalances` の差分を `userAccount = owner` で入れる。
 *   Enhanced と同じく **全口座** を entry にし (変化 0 も)、**差分 0 の token account は入れない**
 *   (Enhanced もそう返す — parity test 参照)。
 * - **source B** (raw が無い時の近似): `tokenTransfers` を from / to の token account に ±rawTokenAmount、
 *   native は wallet の分だけ `nativeTransfers` ± と fee。`instructions[].rawAccounts` の各口座を
 *   balance 無しの entry として入れ、「tx が position account を触ったか」の判定だけ残す。
 *   position account の `nativeBalanceChange` は出さないので LP の open 判定 (rent 入金 > 0) は成立せず
 *   **cost 不明に倒れる** (誤った数値は出さない)。WSOL の token transfer は native wrap と区別できず
 *   二重計上になるため B では入れない (SOL の動きは native 側で数える)。
 *
 * ## 数値 (§4.5)
 * `rawTokenAmount` / `nativeTransfers[].amount` / `pre・postBalances` は JSON number で来るので、
 * `JSON.parse` の **前** に文字列化する (`quoteLargeNumbers`、2^53 超で精度が落ちないように)。
 * 差分は bigint で取る。`nativeBalanceChange` は既存型 (`number`、>0 比較と BigInt() 入力にだけ使う) に
 * 合わせ、safe integer に収まる時だけ Number にする (収まらなければ省略 = 不明)。
 *
 * ## 捨てる item
 * `parserStatus: "ERROR"` と `blockTime` null は捨てて数える (`parsedEventsDropStats`、初回だけ warn)。
 *
 * 秘密: api-key は URL の query にだけ載せ、error message は fetchJsonWithRetry が redact する。
 */
import { SIGNED_TOKEN_AMOUNT_REGEX, signedToBigInt } from "@workspace/lib/utils/numeric";

import { fetchJsonWithRetry, heliusDataFetch } from "./helius-limiter";
import type {
  HeliusAccountData,
  HeliusEnhancedTx,
  HeliusTokenBalanceChange,
} from "./helius-tx";

const PARSED_EVENTS_URL =
  "https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history";

/** native SOL は WSOL mint (B では WSOL token transfer を native と二重に数えないため除外) */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// ── 応答の型 (quote 後: 金融値は string) ───────────────────────────────────

export interface ParsedNativeTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  /** lamports (quote 済み string) */
  amount: string | number;
}

export interface ParsedTokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount: string | null;
  toTokenAccount: string | null;
  /** smallest unit (quote 済み string) */
  rawTokenAmount: string | number;
  decimals: number;
  tokenStandard?: string;
  mint: string;
}

export interface ParsedInstruction {
  programId: string;
  programName?: string | null;
  instructionName?: string | null;
  rawAccounts?: string[];
}

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface ParsedRawTransaction {
  blockTime?: number | null;
  slot?: number;
  meta?: {
    err?: unknown;
    fee?: number;
    /** lamports (quote 済み string) */
    preBalances?: Array<string | number>;
    postBalances?: Array<string | number>;
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction?: {
    message?: { accountKeys?: Array<string | { pubkey: string }> };
  };
}

export interface ParsedTxItem {
  signature: string;
  parserStatus: "OK" | "ERROR" | string;
  parsed?: {
    slot?: number;
    blockTime?: number | null;
    fee?: number;
    feePayer?: string;
    transactionStatus?: string;
    nativeTransfers?: ParsedNativeTransfer[];
    tokenTransfers?: ParsedTokenTransfer[];
    summary?: { type?: string | null; description?: string | null } | null;
    instructions?: ParsedInstruction[];
  } | null;
  parserError?: unknown;
  rawTransaction?: ParsedRawTransaction | null;
}

export interface ParsedTxHistoryPage {
  items: ParsedTxItem[];
  /** 次 page の token。**最終 page でも返る** ことがある (空 page + token 無しが終端、2026-10-12 実測) */
  paginationToken?: string;
}

export interface ParsedTxHistoryQuery {
  /** 1-100 (既定 100) */
  limit?: number;
  beforeSignature?: string;
  /** これより **新しい** tx だけ (排他、実測) */
  afterSignature?: string;
  paginationToken?: string;
  /** unix 秒。これ以降の tx だけ (server 側で走査を打ち切る) */
  timeGte?: number;
  /** 既定 true (source A の材料) */
  includeRaw?: boolean;
}

// ── quote-before-parse ───────────────────────────────────────────────────────

/** 数値 literal の直後 (小数点 / 指数が続く値は対象外にして JSON を壊さない) */
const NUM_END = String.raw`(?=\s*[,}\]])`;
const RAW_TOKEN_AMOUNT_RE = new RegExp(
  String.raw`("rawTokenAmount"\s*:\s*)(-?\d+)` + NUM_END,
  "g"
);
const AMOUNT_RE = new RegExp(String.raw`("amount"\s*:\s*)(-?\d+)` + NUM_END, "g");
/**
 * tokenTransfers / nativeTransfers の要素は flat な object なので `]` までが配列本体。
 * 3 つとも section に閉じて置換する (`rawTransaction.meta.logMessages` などの文字列中の数字は触らない)
 */
const TOKEN_TRANSFERS_RE = /("tokenTransfers"\s*:\s*\[)([^\]]*)(\])/g;
const NATIVE_TRANSFERS_RE = /("nativeTransfers"\s*:\s*\[)([^\]]*)(\])/g;
const LAMPORT_ARRAYS_RE = /("(?:preBalances|postBalances)"\s*:\s*\[)([^\]]*)(\])/g;

/**
 * 金融値の JSON number を `JSON.parse` 前に string にする (§4.5)。
 * 対象: `tokenTransfers[].rawTokenAmount`、`nativeTransfers[].amount`、`pre/postBalances[]`。
 * 小数 / 指数の値は触らない (精度の問題が無い = smallest unit ではない値)。
 */
export function quoteLargeNumbers(text: string): string {
  return text
    .replace(
      TOKEN_TRANSFERS_RE,
      (_m, open: string, body: string, close: string) =>
        open + body.replace(RAW_TOKEN_AMOUNT_RE, '$1"$2"') + close
    )
    .replace(
      NATIVE_TRANSFERS_RE,
      (_m, open: string, body: string, close: string) =>
        open + body.replace(AMOUNT_RE, '$1"$2"') + close
    )
    .replace(
      LAMPORT_ARRAYS_RE,
      (_m, open: string, body: string, close: string) =>
        open + body.replace(/-?\d+/g, '"$&"') + close
    );
}

// ── fetch ────────────────────────────────────────────────────────────────────

function apiUrl(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY is not set. Required for Parsed Events API (Phase C)");
  }
  return `${PARSED_EVENTS_URL}?api-key=${apiKey}`;
}

/** heliusDataFetch の列に並べ、成功応答の本文だけ quote してから fetchJsonWithRetry に返す */
function quotingFetch(): (url: string, init: RequestInit) => Promise<Response> {
  const timed = heliusDataFetch.timed();
  return async (url, init) => {
    const res = await timed(url, init);
    if (!res.ok) return res;
    const text = await res.text();
    return new Response(quoteLargeNumbers(text), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** body は定義済みの field だけ (未知の field は 400 になる) */
export function buildParsedEventsBody(
  address: string,
  q: ParsedTxHistoryQuery
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    address,
    limit: Math.min(100, Math.max(1, q.limit ?? 100)),
    includeRawTransaction: q.includeRaw ?? true,
  };
  if (q.beforeSignature) body.beforeSignature = q.beforeSignature;
  if (q.afterSignature) body.afterSignature = q.afterSignature;
  if (q.paginationToken) body.paginationToken = q.paginationToken;
  if (q.timeGte !== undefined) body.time = { gte: q.timeGte };
  return body;
}

export async function fetchParsedTxHistoryPage(
  address: string,
  q: ParsedTxHistoryQuery = {}
): Promise<ParsedTxHistoryPage> {
  const json = await fetchJsonWithRetry<{ data?: unknown; paginationToken?: unknown }>(
    apiUrl(),
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildParsedEventsBody(address, q)),
    },
    { label: "parsed-events", fetchImpl: quotingFetch() }
  );
  if (!json || !Array.isArray(json.data)) {
    throw new Error("Helius parsed-events unexpected shape (data is not an array)");
  }
  const token =
    typeof json.paginationToken === "string" && json.paginationToken.length > 0
      ? json.paginationToken
      : undefined;
  return { items: json.data as ParsedTxItem[], ...(token ? { paginationToken: token } : {}) };
}

// ── drop 計数 ────────────────────────────────────────────────────────────────

const dropStats = { parserError: 0, noBlockTime: 0 };
const warned = new Set<keyof typeof dropStats>();

function countDrop(kind: keyof typeof dropStats): void {
  dropStats[kind]++;
  if (!warned.has(kind)) {
    warned.add(kind);
    // eslint-disable-next-line no-console
    console.warn(`[parsed-events] dropping tx (${kind}); further drops are counted only`);
  }
}

export function parsedEventsDropStats(): { parserError: number; noBlockTime: number } {
  return { ...dropStats };
}

export function _resetParsedEventsDropStatsForTest(): void {
  dropStats.parserError = 0;
  dropStats.noBlockTime = 0;
  warned.clear();
}

// ── toWalletTx ───────────────────────────────────────────────────────────────

function toBig(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : "") : v;
  return SIGNED_TOKEN_AMOUNT_REGEX.test(s) ? signedToBigInt(s) : null;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** nativeBalanceChange 用: safe integer の時だけ number (収まらなければ undefined = 不明) */
function safeNumber(v: bigint): number | undefined {
  return v <= MAX_SAFE && v >= -MAX_SAFE ? Number(v) : undefined;
}

function accountKeysOf(raw: ParsedRawTransaction): string[] | null {
  const keys = raw.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return null;
  const statics = keys.map((k) => (typeof k === "string" ? k : k?.pubkey));
  if (statics.some((k) => typeof k !== "string")) return null;
  const loaded = raw.meta?.loadedAddresses;
  return [...(statics as string[]), ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/** source A: raw meta の pre/post balance から Enhanced と同じ口座別差分を作る。材料不足なら null */
export function accountDataFromRaw(raw: ParsedRawTransaction): HeliusAccountData[] | null {
  const meta = raw.meta;
  if (!meta) return null;
  const keys = accountKeysOf(raw);
  const pre = meta.preBalances;
  const post = meta.postBalances;
  if (
    !keys ||
    !Array.isArray(pre) ||
    !Array.isArray(post) ||
    pre.length !== keys.length ||
    post.length !== keys.length ||
    !Array.isArray(meta.preTokenBalances) ||
    !Array.isArray(meta.postTokenBalances)
  ) {
    return null;
  }

  const out: HeliusAccountData[] = keys.map((account, i) => {
    const a = toBig(pre[i]);
    const b = toBig(post[i]);
    const entry: HeliusAccountData = { account, tokenBalanceChanges: [] };
    if (a !== null && b !== null) {
      const n = safeNumber(b - a);
      if (n !== undefined) entry.nativeBalanceChange = n;
    }
    return entry;
  });

  const preByIdx = new Map(meta.preTokenBalances.map((t) => [t.accountIndex, t] as const));
  const postByIdx = new Map(meta.postTokenBalances.map((t) => [t.accountIndex, t] as const));
  const indices = [...new Set([...preByIdx.keys(), ...postByIdx.keys()])].sort((x, y) => x - y);
  for (const idx of indices) {
    const entry = out[idx];
    if (!entry) continue;
    const before = preByIdx.get(idx);
    const after = postByIdx.get(idx);
    const ref = after ?? before!;
    const a = before ? toBig(before.uiTokenAmount?.amount) : 0n;
    const b = after ? toBig(after.uiTokenAmount?.amount) : 0n;
    if (a === null || b === null) continue;
    const delta = b - a;
    // Enhanced は差分 0 の token account を tokenBalanceChanges に入れない
    if (delta === 0n) continue;
    const change: HeliusTokenBalanceChange = {
      mint: ref.mint,
      userAccount: after?.owner ?? before?.owner ?? "",
      tokenAccount: entry.account,
      rawTokenAmount: {
        tokenAmount: delta.toString(),
        decimals: ref.uiTokenAmount?.decimals ?? 0,
      },
    };
    entry.tokenBalanceChanges!.push(change);
  }
  return out;
}

/**
 * source B: tokenTransfers / nativeTransfers からの近似 (raw が無い時)。
 * `wallet` が分かれば native はその口座だけ ± する (position account の rent は出さない → LP open 判定は
 * 成立せず cost 不明)。WSOL の token transfer は native wrap と二重になるので入れない。
 */
export function accountDataFromTransfers(
  parsed: NonNullable<ParsedTxItem["parsed"]>,
  wallet?: string
): HeliusAccountData[] {
  const byAccount = new Map<string, HeliusAccountData>();
  const entryFor = (account: string): HeliusAccountData => {
    let e = byAccount.get(account);
    if (!e) {
      e = { account, tokenBalanceChanges: [] };
      byAccount.set(account, e);
    }
    return e;
  };

  // token: (token account, mint, owner) ごとに合算
  const tokenSums = new Map<string, { tokenAccount: string; mint: string; owner: string; decimals: number; sum: bigint }>();
  const addToken = (tokenAccount: string | null, owner: string | null, t: ParsedTokenTransfer, sign: 1n | -1n) => {
    if (!tokenAccount || !owner) return;
    const amt = toBig(t.rawTokenAmount);
    if (amt === null) return;
    const k = `${tokenAccount}|${t.mint}|${owner}`;
    const cur = tokenSums.get(k) ?? { tokenAccount, mint: t.mint, owner, decimals: t.decimals, sum: 0n };
    cur.sum += sign * amt;
    tokenSums.set(k, cur);
  };
  for (const t of parsed.tokenTransfers ?? []) {
    if (t.mint === WSOL_MINT) continue;
    addToken(t.fromTokenAccount, t.fromUserAccount, t, -1n);
    addToken(t.toTokenAccount, t.toUserAccount, t, 1n);
  }
  for (const s of tokenSums.values()) {
    if (s.sum === 0n) continue;
    entryFor(s.tokenAccount).tokenBalanceChanges!.push({
      mint: s.mint,
      userAccount: s.owner,
      tokenAccount: s.tokenAccount,
      rawTokenAmount: { tokenAmount: s.sum.toString(), decimals: s.decimals },
    });
  }

  // native: wallet だけ (不明なら fee payer)
  const nativeOf = wallet ?? parsed.feePayer;
  if (nativeOf) {
    let sum = 0n;
    for (const n of parsed.nativeTransfers ?? []) {
      const amt = toBig(n.amount);
      if (amt === null) continue;
      if (n.fromUserAccount === nativeOf) sum -= amt;
      if (n.toUserAccount === nativeOf) sum += amt;
    }
    if (parsed.feePayer === nativeOf) sum -= toBig(parsed.fee ?? 0) ?? 0n;
    const e = entryFor(nativeOf);
    const n = safeNumber(sum);
    if (n !== undefined) e.nativeBalanceChange = n;
  }

  // 「tx が触った口座」(balance 無し)
  for (const ins of parsed.instructions ?? []) {
    for (const acc of ins.rawAccounts ?? []) {
      if (typeof acc === "string" && acc.length > 0) entryFor(acc);
    }
  }
  return [...byAccount.values()];
}

/**
 * Parsed Events の 1 item → 既存 consumer が読む `HeliusEnhancedTx` shape。
 * ERROR / blockTime 不明は null (数える)。`wallet` は source B の native 帰属にだけ使う。
 */
export function toWalletTx(item: ParsedTxItem, wallet?: string): HeliusEnhancedTx | null {
  if (item.parserStatus === "ERROR" || !item.parsed) {
    countDrop("parserError");
    return null;
  }
  const p = item.parsed;
  const blockTime = p.blockTime ?? item.rawTransaction?.blockTime ?? null;
  if (typeof blockTime !== "number" || !Number.isFinite(blockTime)) {
    countDrop("noBlockTime");
    return null;
  }
  const fromRaw = item.rawTransaction ? accountDataFromRaw(item.rawTransaction) : null;
  const accountData = fromRaw ?? accountDataFromTransfers(p, wallet);
  const type = p.summary?.type;
  return {
    signature: item.signature,
    timestamp: blockTime,
    type: typeof type === "string" && type.length > 0 ? type.toUpperCase() : "UNKNOWN",
    ...(typeof p.summary?.description === "string" ? { description: p.summary.description } : {}),
    fee: typeof p.fee === "number" ? p.fee : 0,
    accountData,
  };
}
