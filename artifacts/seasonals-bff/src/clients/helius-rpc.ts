/**
 * helius-rpc — Helius Mainnet JSON-RPC client (Phase 8.8)
 *
 * sendTransaction を Helius mainnet RPC 経由で投げる薄い wrapper。
 * Phantom の signAndSendTransactions が v0 versioned tx + address lookup tables を
 * 含む Jupiter swap で empty result を返す問題を回避するため、Mobile は MWA で
 * 署名のみ行い、broadcast は BFF → Helius RPC に委ねる。
 *
 * HELIUS_API_KEY env (Phase 8.1 で設定済) を使う。mainnet エンドポイント:
 *   https://mainnet.helius-rpc.com/?api-key=<key>
 */

import type { TxStatusResponse } from "@workspace/lib/types";
import { fetchWithTimeout } from "./http"; // Phase 8.38 (B9): 共通 timeout
import { VersionedTransaction } from "@solana/web3.js";
import { fetchJsonWithRetry, HeliusRpcError, heliusRpcFetch, limiterSleep, redactKey } from "./helius-limiter";
import { recordUpstreamCall } from "../usage";
const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";

/**
 * Helius mainnet の RPC URL。8.52: kamino-tx.ts も同じ口を使うので export し、
 * key/URL の組み立てを 1 箇所に集約する (二重管理で片方だけ直る事故を防ぐ)。
 */
export function buildUrl(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY is not set");
  }
  return `${HELIUS_MAINNET_URL}/?api-key=${apiKey}`;
}

// ── read-only RPC の retry (Helius 429 対策) ────────────────────────────────
//
// retry 本体 (429 / 5xx / network を backoff 再試行、Retry-After 尊重、error に URL を
// 出さない) は helius-limiter.ts の fetchJsonWithRetry に抽出した。ここは JSON-RPC の
// 薄い wrapper で、request は heliusRpcFetch の列に並ぶ (同時実行数 / 間隔の制限 + 計数)。
// - JSON-RPC `error` は即 throw (再試行しても結果は同じ)
// - **sendTransactionViaHelius には使わない** — broadcast の自動再送は二重送信の
//   余地を作る (再送は RPC node 側の rebroadcast に任せる)。列にも並べない (計数のみ)

export { HeliusRpcError, _setSleepForTest, fetchJsonWithRetry } from "./helius-limiter";

interface RpcReadOptions {
  /** JSON-RPC id (ログ・テストでの識別用) */
  id?: string;
  /** error message 上の名前 (既定: method) */
  label?: string;
  /** network / timeout を再試行するか (既定 true)。false なら 429 / 5xx のみ */
  retryNetworkErrors?: boolean;
}

/**
 * read-only JSON-RPC を 1 本投げ、`result` を返す (無ければ undefined)。
 * 429 / 5xx / network は backoff 再試行、それ以外は即 throw (HeliusRpcError)。
 */
async function rpcReadWithRetry<T>(
  method: string,
  params: unknown[],
  opts: RpcReadOptions = {}
): Promise<T | undefined> {
  const label = opts.label ?? method;
  const body = JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? `seasonals-${method}`, method, params });
  const json = await fetchJsonWithRetry<{ result?: T; error?: { code?: number; message?: string } } | null>(
    buildUrl(),
    { method: "POST", headers: { "content-type": "application/json" }, body },
    { label, fetchImpl: heliusRpcFetch.timed(), retryNetworkErrors: opts.retryNetworkErrors ?? true }
  );
  if (json?.error) {
    throw new HeliusRpcError(
      `Helius ${label} RPC error ${json.error.code ?? "?"}: ${redactKey(String(json.error.message ?? ""))}`,
      "rpc"
    );
  }
  return json?.result;
}

/**
 * base64-encoded signed transaction を Helius mainnet RPC で submit。
 * 成功すると base58 signature を返す。
 *
 * maxRetries は **呼び手が明示した時だけ** params に載せる。省略時の Solana RPC は
 * blockhash が失効するか finalized になるまで leader へ rebroadcast し続ける。
 * 以前は既定 3 で上限を掛けており、RPC 受理後に leader へ届かず drop する事故
 * (Seeker の USDC → jlUSDC deposit、2026-10-13) の余地を広げていた。
 * 着地の判定は呼び手が /tx/status の blockHeight と lastValidBlockHeight を比べて行う。
 */
/**
 * 2026-10-13: Seeker の Seed Vault で Jupiter USDC deposit を送ると preflight が
 * `-32002 Transaction simulation failed: Blockhash not found` で落ちた (build から送信まで 32 秒、
 * blockhash の失効 ~60-90 秒より前)。wallet が署名時に blockhash を新しいもの (processed) に
 * 差し替えると、`preflightCommitment: "confirmed"` の Helius node からはまだ見えないことがある。
 *
 * preflight で落ちた tx は broadcast されていない。同じ署名済 tx を再送しても signature は同一なので
 * 二重実行にはならない。そこで:
 *   1. tx の recentBlockhash を `isBlockhashValid` (processed) で確かめる
 *   2. 有効 = RPC がまだ追いついていないだけ → 待って再送 (最大 SUBMIT_BLOCKHASH_RETRIES 回)
 *   3. 無効 = 本当に失効 → BlockhashExpiredError (何も動いていない、組み直して署名し直す)
 */
export const SUBMIT_BLOCKHASH_RETRIES = 3;
const SUBMIT_BLOCKHASH_WAIT_MS = 1_500;

export class BlockhashExpiredError extends Error {
  readonly code = "blockhash_expired";
  constructor() {
    super("The transaction expired before it reached the network. Nothing moved — build and sign it again.");
    this.name = "BlockhashExpiredError";
  }
}

const BLOCKHASH_NOT_FOUND_RE = /blockhash not found/i;

function recentBlockhashOf(signedTxBase64: string): string | null {
  try {
    return VersionedTransaction.deserialize(Buffer.from(signedTxBase64, "base64")).message.recentBlockhash;
  } catch {
    return null;
  }
}

/** blockhash が processed の bank でまだ有効か。読めなければ null (判断材料にしない) */
async function isBlockhashValid(blockhash: string): Promise<boolean | null> {
  try {
    const r = await rpcReadWithRetry<{ value?: boolean }>(
      "isBlockhashValid",
      [blockhash, { commitment: "processed" }],
      { id: "seasonals-submit-blockhash" }
    );
    return typeof r?.value === "boolean" ? r.value : null;
  } catch {
    return null;
  }
}

export async function sendTransactionViaHelius(
  signedTxBase64: string,
  opts: {
    skipPreflight?: boolean;
    maxRetries?: number;
  } = {}
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendTransactionOnce(signedTxBase64, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.skipPreflight || !BLOCKHASH_NOT_FOUND_RE.test(msg)) throw e;
      const blockhash = recentBlockhashOf(signedTxBase64);
      const valid = blockhash ? await isBlockhashValid(blockhash) : null;
      if (valid === false) throw new BlockhashExpiredError();
      if (attempt >= SUBMIT_BLOCKHASH_RETRIES) throw e;
      await limiterSleep(SUBMIT_BLOCKHASH_WAIT_MS);
    }
  }
}

async function sendTransactionOnce(
  signedTxBase64: string,
  opts: {
    skipPreflight?: boolean;
    maxRetries?: number;
  }
): Promise<string> {
  const url = buildUrl();
  // 列に並べず retry もしない (broadcast は即時・1 回)。usage には数える
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "seasonals-submit",
        method: "sendTransaction",
        params: [
          signedTxBase64,
          {
            encoding: "base64",
            skipPreflight: opts.skipPreflight ?? false,
            // 省略 = RPC node が blockhash 失効まで rebroadcast (上の doc comment 参照)
            ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
            preflightCommitment: "confirmed",
          },
        ],
      }),
    });
  } catch (e) {
    recordUpstreamCall({ api: "rpc", method: "sendTransaction", status: null });
    throw e;
  }
  recordUpstreamCall({ api: "rpc", method: "sendTransaction", status: res.status });
  if (!res.ok) {
    throw new Error(
      `Helius sendTransaction HTTP ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  const json = (await res.json()) as {
    result?: string;
    error?: { code: number; message: string; data?: unknown };
  };
  if (json.error) {
    throw new Error(
      `Helius sendTransaction RPC error ${json.error.code}: ${json.error.message}`
    );
  }
  if (!json.result || typeof json.result !== "string") {
    throw new Error("Helius sendTransaction: missing signature in result");
  }
  return json.result;
}

// ── oracle: Solana 上の price feed account を 1 回の RPC でまとめて読む (clients/oracle.ts) ──

export interface RawAccount {
  /** owner program (base58) */
  owner: string;
  data: Buffer;
}

/**
 * getMultipleAccounts (base64)。存在しない account は null。順序は入力どおり。
 * 失敗は throw (呼び手が last-good / fail-closed を判断する)。error に key を含めない
 */
export async function getMultipleAccountsBase64(pubkeys: string[]): Promise<Array<RawAccount | null>> {
  if (pubkeys.length === 0) return [];
  const result = await rpcReadWithRetry<{ value?: Array<{ owner?: string; data?: [string, string] } | null> }>(
    "getMultipleAccounts",
    [pubkeys, { encoding: "base64", commitment: "confirmed" }],
    { id: "seasonals-oracle" }
  );
  const value = result?.value;
  if (!Array.isArray(value) || value.length !== pubkeys.length) {
    throw new Error("Helius getMultipleAccounts: unexpected result shape");
  }
  return value.map((v) =>
    v && typeof v.owner === "string" && Array.isArray(v.data) ? { owner: v.owner, data: Buffer.from(v.data[0], "base64") } : null
  );
}

// ── Web: 署名済 tx の着地確認 (sign-only の browser wallet は送信後の状態を出さないため) ──

/**
 * getSignatureStatuses を 1 件だけ引いて要約する。
 * null (未着地 / 期限切れ) は pending — 呼び手が時間で打ち切る。
 *
 * status が pending の時だけ、続けて現在の block height (confirmed) を引いて
 * `blockHeight` に載せる (confirmed / processed / failed は着地済みなので height は
 * 不要で null、余計な RPC を打たない)。呼び手は builder の lastValidBlockHeight と比べ、
 * 超えていれば「期限切れ (着地しない)」と確定できる。node 間の height のずれで 1 回の
 * 読みが先走ることはあり得るが、client (lib `confirmSignatures`) は **2 回連続** で
 * height > lastValidBlockHeight を見た時だけ expired と宣言するので、ここでは単発の
 * 読みをそのまま返してよい。height は最適化に過ぎないので、取れなければ null で
 * status は返す (status 読み取りの失敗理由にしない)。両 call とも rpcReadWithRetry
 * 経由で heliusRpcFetch の列に並び、usage にも method 別に計数される
 */
export async function getSignatureStatus(signature: string): Promise<TxStatusResponse> {
  const result = await rpcReadWithRetry<{
    value?: Array<{ slot?: number; err?: unknown; confirmationStatus?: string | null } | null>;
  }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }], { id: "seasonals-status" });
  const v = result?.value?.[0] ?? null;
  if (!v) {
    const blockHeight = await rpcReadWithRetry<number>("getBlockHeight", [{ commitment: "confirmed" }], {
      id: "seasonals-status-height",
    }).then(
      (h) => (typeof h === "number" && Number.isFinite(h) ? h : null),
      () => null
    );
    return { signature, status: "pending", slot: null, err: null, blockHeight };
  }
  const slot = typeof v.slot === "number" ? v.slot : null;
  if (v.err != null) return { signature, status: "failed", slot, err: JSON.stringify(v.err), blockHeight: null };
  const c = v.confirmationStatus;
  const status = c === "finalized" || c === "confirmed" || c === "processed" ? c : "processed";
  return { signature, status, slot, err: null, blockHeight: null };
}

// ── Phase 8.16: epoch info (LST 保有者向けの実 epoch 境界イベント用) ──────────

export interface EpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
}

let epochCache: { at: number; info: EpochInfo } | null = null;
const EPOCH_CACHE_TTL_MS = 60_000;

/** Solana getEpochInfo (60s cache)。epoch 境界の推定に使う。 */
export async function getEpochInfo(): Promise<EpochInfo> {
  if (epochCache && Date.now() - epochCache.at < EPOCH_CACHE_TTL_MS) {
    return epochCache.info;
  }
  const result = await rpcReadWithRetry<EpochInfo>("getEpochInfo", [], { id: "seasonals-epoch" });
  if (!result) {
    throw new Error("Helius getEpochInfo RPC error: no result");
  }
  epochCache = { at: Date.now(), info: result };
  return result;
}

// ── Phase 8.80: wallet の input 残高 (署名前 gate 用) ─────────────────────────

const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * owner の mint 残高 (smallest unit)。**取得できなければ null** — 呼び手の gate は
 * null を素通しする。これは「確実に失敗する tx を署名前に止める」UX ガードであって
 * 安全ガードではない (存在しない資金は動かせない) ので、RPC 瞬断で deposit を
 * 誤ブロックしない側に倒す (8.78 の教訓)。
 *
 * - WSOL mint → native lamports (`getBalance`)。swap-earn の SOL deposit は
 *   Jupiter が native SOL を wrap するため
 * - それ以外 → `getTokenAccountsByOwner` (mint 指定) の amount 合計。
 *   account 無し = 0n (未保有)
 *
 * §4.5: 残高は bigint。Number を経由しない。
 */
export async function getWalletBalanceSmallest(
  owner: string,
  mint: string
): Promise<bigint | null> {
  try {
    if (mint === WSOL_MINT) {
      const res = await heliusRpcFetch.timed()(buildUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "seasonals-balance",
          method: "getBalance",
          params: [owner],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: { value?: number } };
      const lamports = json.result?.value;
      if (typeof lamports !== "number" || !Number.isFinite(lamports)) {
        return null;
      }
      // lamports は u64 だが JSON-RPC は number で返す。2^53 未満で安全
      // (>9M SOL の wallet は対象外の規模)
      return BigInt(Math.floor(lamports));
    }
    const res = await heliusRpcFetch.timed()(buildUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "seasonals-balance",
        method: "getTokenAccountsByOwner",
        params: [owner, { mint }, { encoding: "jsonParsed" }],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: {
        value?: Array<{
          account?: {
            data?: {
              parsed?: { info?: { tokenAmount?: { amount?: string } } };
            };
          };
        }>;
      };
    };
    const accounts = json.result?.value;
    if (!Array.isArray(accounts)) return null;
    let total = 0n;
    for (const a of accounts) {
      const amount = a.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof amount === "string" && /^[0-9]+$/.test(amount)) {
        total += BigInt(amount);
      }
    }
    return total;
  } catch {
    return null;
  }
}

// ── Phase 8.26: token supply (Solstice TVL 等の表示用) ────────────────────────

const supplyCache = new Map<string, { at: number; ui: number }>();
const SUPPLY_TTL_MS = 10 * 60_000;

/**
 * mint の総供給 (uiAmount、表示専用 Number — §4.5 適用外の概算 TVL 用)。
 * 10min cache (供給はゆっくりしか動かない)。
 */
export async function getTokenSupplyUi(mint: string): Promise<number> {
  const hit = supplyCache.get(mint);
  if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) return hit.ui;
  const result = await rpcReadWithRetry<{ value?: { uiAmount?: number } }>("getTokenSupply", [mint], {
    id: "seasonals-supply",
  });
  const ui = result?.value?.uiAmount;
  if (typeof ui !== "number" || !Number.isFinite(ui)) {
    throw new Error("Helius getTokenSupply error: invalid uiAmount");
  }
  supplyCache.set(mint, { at: Date.now(), ui });
  return ui;
}

// ── Phase 8.20: native stake accounts (lockup_end イベント用) ─────────────────

export interface StakeAccountInfo {
  /** stake account pubkey */
  address: string;
  /** delegation.stake (lamports、integer string §4.5) */
  stake_lamports: string;
  /**
   * deactivation を要求した epoch。u64::MAX ("18446744073709551615") = active
   * (解除要求なし)。<= 現 epoch = cooldown 完了 or 進行中。
   */
  deactivation_epoch: string;
}

/**
 * wallet が withdrawer の native stake account を列挙する。
 * getProgramAccounts (Stake program、jsonParsed) — withdrawer は Meta.authorized
 * の 2 番目 pubkey (offset 44)。plan によっては GPA が拒否されるため呼び手は
 * 失敗を degrade すること (allSettled)。
 */
export async function fetchStakeAccounts(
  wallet: string
): Promise<StakeAccountInfo[]> {
  const result = await rpcReadWithRetry<
    {
      pubkey: string;
      account: {
        data: {
          parsed?: {
            info?: {
              stake?: {
                delegation?: { stake?: string; deactivationEpoch?: string };
              };
            };
          };
        };
      };
    }[]
  >(
    "getProgramAccounts",
    [
      "Stake11111111111111111111111111111111111111",
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        filters: [{ dataSize: 200 }, { memcmp: { offset: 44, bytes: wallet } }],
      },
    ],
    { id: "seasonals-stake", label: "getProgramAccounts(stake)" }
  );
  if (!Array.isArray(result)) {
    throw new Error("Helius getProgramAccounts(stake) RPC error: no result");
  }
  const out: StakeAccountInfo[] = [];
  for (const acc of result) {
    const delegation = acc.account?.data?.parsed?.info?.stake?.delegation;
    if (!delegation?.stake || !delegation.deactivationEpoch) continue;
    out.push({
      address: acc.pubkey,
      stake_lamports: delegation.stake,
      deactivation_epoch: delegation.deactivationEpoch,
    });
  }
  return out;
}

// ── Phase 8.51: 署名前の tx 検証 ────────────────────────────────────────────

export interface SimulationOutcome {
  /** program まで到達して成功したか */
  ok: boolean;
  /** 失敗時の program エラー (JSON 文字列) */
  err?: string;
  /** 失敗の理由が読める形で分かる場合の 1 行 (program log 由来) */
  reason?: string;
}

/**
 * unsigned tx を **mainnet で simulate** して、署名前に成否を知る。
 *
 * `sigVerify:false` + `replaceRecentBlockhash:true` なので **署名も資金移動も
 * 発生しない**。外部の tx builder が「組めるが必ず失敗する tx」を返すケース
 * (8.51 の Kamino reserve 誤ルーティング等) を、ユーザーが署名する前に捕まえる。
 *
 * 注意: BFF の `SOLANA_RPC_URL` は自律実行のハードガードで devnet 固定なので、
 * 検証は必ずこの mainnet 口を使う (devnet に投げると ALT 不在で必ず失敗する)。
 */
export async function simulateUnsignedTx(
  base64Tx: string
): Promise<SimulationOutcome> {
  // simulate は状態を変えない (read-only) ので 429 / 5xx のみ再試行する。
  // simulation 自体の失敗 (value.err) は 200 応答なので再試行対象にならない。
  // network / timeout は従来どおり呼び手へ throw (retryNetworkErrors: false)
  let result: { value?: { err?: unknown; logs?: string[] } } | undefined;
  try {
    result = await rpcReadWithRetry<{ value?: { err?: unknown; logs?: string[] } }>(
      "simulateTransaction",
      [
        base64Tx,
        {
          sigVerify: false,
          replaceRecentBlockhash: true,
          encoding: "base64",
          commitment: "confirmed",
        },
      ],
      { id: "seasonals-simulate", retryNetworkErrors: false }
    );
  } catch (e) {
    // 検証できない時は通す (fail-open)。ここで止めると RPC 障害で全機能が死ぬ
    if (e instanceof HeliusRpcError && (e.kind === "http" || e.kind === "rpc")) {
      return { ok: true };
    }
    throw e;
  }
  if (!result?.value) return { ok: true };
  const value = result.value;
  if (!value.err) return { ok: true };
  const logs = value.logs ?? [];
  // 人間が読める失敗理由 (program の説明ログ or Anchor のエラー行)。
  // 8.52: compute budget 系のログは "limit" を含むが失敗理由ではないので除外する
  const isNoise = (l: string) =>
    /compute unit|ComputeBudget|consumed \d+ of \d+/i.test(l);
  const reason =
    logs.find((l) => !isNoise(l) && /Cannot |limit|exceed|insufficient/i.test(l)) ??
    logs.find((l) => /Error Code:/.test(l));
  return {
    ok: false,
    err: JSON.stringify(value.err),
    ...(reason ? { reason: reason.replace(/^Program log: /, "") } : {}),
  };
}
