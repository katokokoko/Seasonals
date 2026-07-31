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

import { fetchWithTimeout } from "./http"; // Phase 8.38 (B9): 共通 timeout
const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";

function buildUrl(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY is not set");
  }
  return `${HELIUS_MAINNET_URL}/?api-key=${apiKey}`;
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
  const res = await fetchWithTimeout(buildUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-epoch",
      method: "getEpochInfo",
      params: [],
    }),
  });
  if (!res.ok) {
    throw new Error(`Helius getEpochInfo HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: EpochInfo;
    error?: { code: number; message: string };
  };
  if (json.error || !json.result) {
    throw new Error(
      `Helius getEpochInfo RPC error: ${json.error?.message ?? "no result"}`
    );
  }
  epochCache = { at: Date.now(), info: json.result };
  return json.result;
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
  const res = await fetchWithTimeout(buildUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-supply",
      method: "getTokenSupply",
      params: [mint],
    }),
  });
  if (!res.ok) {
    throw new Error(`Helius getTokenSupply HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: { value?: { uiAmount?: number } };
    error?: { code: number; message: string };
  };
  const ui = json.result?.value?.uiAmount;
  if (json.error || typeof ui !== "number" || !Number.isFinite(ui)) {
    throw new Error(
      `Helius getTokenSupply error: ${json.error?.message ?? "invalid uiAmount"}`
    );
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
  const res = await fetchWithTimeout(buildUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-stake",
      method: "getProgramAccounts",
      params: [
        "Stake11111111111111111111111111111111111111",
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
          filters: [
            { dataSize: 200 },
            { memcmp: { offset: 44, bytes: wallet } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Helius getProgramAccounts(stake) HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: {
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
    }[];
    error?: { code: number; message: string };
  };
  if (json.error || !Array.isArray(json.result)) {
    throw new Error(
      `Helius getProgramAccounts(stake) RPC error: ${json.error?.message ?? "no result"}`
    );
  }
  const out: StakeAccountInfo[] = [];
  for (const acc of json.result) {
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
  const res = await fetchWithTimeout(buildUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-simulate",
      method: "simulateTransaction",
      params: [
        base64Tx,
        {
          sigVerify: false,
          replaceRecentBlockhash: true,
          encoding: "base64",
          commitment: "confirmed",
        },
      ],
    }),
  });
  if (!res.ok) {
    // 検証できない時は通す (fail-open)。ここで止めると RPC 障害で全機能が死ぬ
    return { ok: true };
  }
  const json = (await res.json()) as {
    result?: { value?: { err?: unknown; logs?: string[] } };
    error?: { message?: string };
  };
  if (json.error || !json.result?.value) return { ok: true };
  const value = json.result.value;
  if (!value.err) return { ok: true };
  const logs = value.logs ?? [];
  // 人間が読める失敗理由 (program の説明ログ or Anchor のエラー行)
  const reason =
    logs.find((l) => /Cannot |limit|exceed|insufficient/i.test(l)) ??
    logs.find((l) => /Error Code:/.test(l));
  return {
    ok: false,
    err: JSON.stringify(value.err),
    ...(reason ? { reason: reason.replace(/^Program log: /, "") } : {}),
  };
}
