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
// Helius は混雑時に `429 Too Many Requests` (本文は plain text) を返す。読み取り
// 専用の RPC は冪等なので、429 / 5xx / network・timeout を指数 backoff で
// 再試行する (最大 3 attempt。attempt 間の待ちは 500ms → 1000ms、表の 2000ms は
// attempt を増やした時の次段。`Retry-After` (秒、上限 10s) が backoff より長ければ
// そちらを使う)。
// - 429 以外の 4xx と JSON-RPC `error` は即 throw (再試行しても結果は同じ)
// - **sendTransactionViaHelius には使わない** — broadcast の自動再送は二重送信の
//   余地を作る (再送は Helius 側の maxRetries に任せる)
// - error message に URL / api-key を含めない

const RPC_MAX_ATTEMPTS = 3;
const RPC_BACKOFF_MS = [500, 1000, 2000] as const;
/** Retry-After が異常に長い時に handler を長く塞がない上限 */
const RPC_RETRY_AFTER_CAP_MS = 10_000;

type SleepFn = (ms: number) => Promise<void>;
/** backoff の待ち。RPC 失敗を流す test は _setSleepForTest で差し替える (fake timer と組み合わせると解決しないため) */
const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let sleep: SleepFn = defaultSleep;

/** test 専用: backoff の待ちを差し替える (null で既定に戻す) */
export function _setSleepForTest(fn: SleepFn | null): void {
  sleep = fn ?? defaultSleep;
}

type RpcErrorKind = "http" | "rpc" | "network" | "parse";

/** rpcReadWithRetry の失敗。message に URL / api-key を含めない */
export class HeliusRpcError extends Error {
  constructor(
    message: string,
    readonly kind: RpcErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "HeliusRpcError";
  }
}

const redactKey = (s: string): string => s.replace(/api-key=[^&\s"']+/g, "api-key=***");

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const sec = Number(raw.trim()); // 秒数 (小整数、§4.5 適用外)
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.min(sec * 1000, RPC_RETRY_AFTER_CAP_MS);
}

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
  const retryNetwork = opts.retryNetworkErrors ?? true;
  const url = buildUrl();
  const body = JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? `seasonals-${method}`, method, params });
  let lastErr: HeliusRpcError | null = null;

  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    let waitFloorMs: number | null = null;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (e) {
      const msg = redactKey(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      lastErr = new HeliusRpcError(`Helius ${label} network error: ${msg}`, "network");
      if (!retryNetwork) throw lastErr;
      if (attempt + 1 < RPC_MAX_ATTEMPTS) await sleep(RPC_BACKOFF_MS[attempt]!);
      continue;
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      const hint = res.status === 429 ? " (rate limited)" : "";
      lastErr = new HeliusRpcError(`Helius ${label} HTTP ${res.status}${hint}`, "http", res.status);
      if (!retryable) throw lastErr;
      waitFloorMs = parseRetryAfterMs(res);
      // body は読まずに捨てる (接続を解放)
      await res.body?.cancel().catch(() => undefined);
      if (attempt + 1 < RPC_MAX_ATTEMPTS) {
        await sleep(Math.max(RPC_BACKOFF_MS[attempt]!, waitFloorMs ?? 0));
      }
      continue;
    }

    let json: { result?: T; error?: { code?: number; message?: string } };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new HeliusRpcError(`Helius ${label}: response is not JSON`, "parse", res.status);
    }
    if (json.error) {
      throw new HeliusRpcError(
        `Helius ${label} RPC error ${json.error.code ?? "?"}: ${redactKey(String(json.error.message ?? ""))}`,
        "rpc"
      );
    }
    return json.result;
  }
  throw lastErr ?? new HeliusRpcError(`Helius ${label}: retries exhausted`, "network");
}

/**
 * base64-encoded signed transaction を Helius mainnet RPC で submit。
 * 成功すると base58 signature を返す。
 */
export async function sendTransactionViaHelius(
  signedTxBase64: string,
  opts: {
    skipPreflight?: boolean;
    maxRetries?: number;
  } = {}
): Promise<string> {
  const url = buildUrl();
  const res = await fetchWithTimeout(url, {
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
          maxRetries: opts.maxRetries ?? 3,
          preflightCommitment: "confirmed",
        },
      ],
    }),
  });
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
 * null (未着地 / 期限切れ) は pending — 呼び手が時間で打ち切る
 */
export async function getSignatureStatus(signature: string): Promise<TxStatusResponse> {
  const result = await rpcReadWithRetry<{
    value?: Array<{ slot?: number; err?: unknown; confirmationStatus?: string | null } | null>;
  }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }], { id: "seasonals-status" });
  const v = result?.value?.[0] ?? null;
  if (!v) return { signature, status: "pending", slot: null, err: null };
  const slot = typeof v.slot === "number" ? v.slot : null;
  if (v.err != null) return { signature, status: "failed", slot, err: JSON.stringify(v.err) };
  const c = v.confirmationStatus;
  const status = c === "finalized" || c === "confirmed" || c === "processed" ? c : "processed";
  return { signature, status, slot, err: null };
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
      const res = await fetchWithTimeout(buildUrl(), {
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
    const res = await fetchWithTimeout(buildUrl(), {
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
