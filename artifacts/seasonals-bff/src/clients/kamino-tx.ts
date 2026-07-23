/**
 * kamino-tx — Kamino Lend (K-Lend) REST client (Phase 8.15b)
 *
 * `api.kamino.finance` は **unsigned base64 transaction** を返す REST を提供する
 * (SDK / server key 不要)。8.15 の Jupiter swap proxy と同型で、BFF は外部の
 * unsigned-tx builder を叩いて base64 を mobile に渡し、mobile が MWA 署名 →
 * Helius broadcast する。
 *
 *   deposit  : POST /ktx/klend/deposit   { wallet, market, reserve, amount } → { transaction }
 *   withdraw : POST /ktx/klend/withdraw  同形
 *   reserves : GET  /kamino-market/{market}/reserves/metrics
 *   obligation: GET /kamino-market/{market}/users/{wallet}/obligations
 *
 * 規約 (CLAUDE.md §4.5):
 *   - Kamino API の amount は **human/decimal 単位** ("1" = 1 USDC)。呼び出し側 (server)
 *     が smallest-unit string → `toHumanReadable` で変換してから渡す。本 client は
 *     受け取った amount 文字列を passthrough する (parse しない)。
 */

import { fetchWithTimeout } from "./http"; // Phase 8.38 (B9): 共通 timeout
const KAMINO_BASE = "https://api.kamino.finance";

/** reserves/metrics の 1 reserve 分 (raw)。APY 系は fraction string。 */
export interface KaminoReserveMetric {
  reserve: string;
  liquidityToken: string;
  liquidityTokenMint: string;
  supplyApy: string;
  borrowApy: string;
  totalSupply: string;
  totalBorrow: string;
  totalSupplyUsd: string;
  totalBorrowUsd: string;
}

/** obligations 応答 (raw、shape 揺れに強く parse するため loose) */
export type KaminoRawObligation = Record<string, unknown>;

async function kaminoGet<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${KAMINO_BASE}${path}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Kamino GET ${path} HTTP ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  return (await res.json()) as T;
}

/** market の全 reserve metrics (58 件規模)。server 側で supported reserve を抽出。 */
export async function fetchKaminoReserveMetrics(
  market: string
): Promise<KaminoReserveMetric[]> {
  const raw = await kaminoGet<unknown>(
    `/kamino-market/${market}/reserves/metrics`
  );
  return (Array.isArray(raw) ? raw : []) as KaminoReserveMetric[];
}

/** market × wallet の obligation 群 (保有 position、空なら [])。 */
export async function fetchKaminoObligations(
  market: string,
  wallet: string
): Promise<KaminoRawObligation[]> {
  const raw = await kaminoGet<unknown>(
    `/kamino-market/${market}/users/${wallet}/obligations`
  );
  return (Array.isArray(raw) ? raw : []) as KaminoRawObligation[];
}

async function kaminoTx(
  action: "deposit" | "withdraw",
  body: { wallet: string; market: string; reserve: string; amount: string }
): Promise<{ transaction: string }> {
  const res = await fetchWithTimeout(`${KAMINO_BASE}/ktx/klend/${action}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Kamino ${action} tx HTTP ${res.status}: ${await res
        .text()
        .catch(() => "")}`
    );
  }
  const json = (await res.json()) as { transaction?: string };
  if (!json.transaction) {
    throw new Error(`Kamino ${action} tx: empty transaction in response`);
  }
  return { transaction: json.transaction };
}

/** deposit unsigned tx (underlying → reserve、amount は human/decimal string) */
export function fetchKaminoDepositTx(body: {
  wallet: string;
  market: string;
  reserve: string;
  amount: string;
}): Promise<{ transaction: string }> {
  return kaminoTx("deposit", body);
}

/** withdraw unsigned tx (reserve → underlying、amount は human/decimal string) */
export function fetchKaminoWithdrawTx(body: {
  wallet: string;
  market: string;
  reserve: string;
  amount: string;
}): Promise<{ transaction: string }> {
  return kaminoTx("withdraw", body);
}

// ── Kamino Earn vault (kVault) — Phase 8.15d ─────────────────────────────────

async function kaminoVaultTx(
  action: "deposit" | "withdraw",
  body: { wallet: string; kvault: string; amount: string }
): Promise<{ transaction: string }> {
  const res = await fetchWithTimeout(`${KAMINO_BASE}/ktx/kvault/${action}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Kamino kvault ${action} tx HTTP ${res.status}: ${await res
        .text()
        .catch(() => "")}`
    );
  }
  const json = (await res.json()) as { transaction?: string };
  if (!json.transaction) {
    throw new Error(`Kamino kvault ${action} tx: empty transaction in response`);
  }
  return { transaction: json.transaction };
}

/** kVault deposit unsigned tx (amount = underlying の human/decimal string) */
export function fetchKaminoVaultDepositTx(body: {
  wallet: string;
  kvault: string;
  amount: string;
}): Promise<{ transaction: string }> {
  return kaminoVaultTx("deposit", body);
}

/**
 * kVault withdraw unsigned tx。**amount = share 建ての human/decimal string**
 * (klend-sdk kvault tutorial で確認済。over-balance は cap される)。
 */
export function fetchKaminoVaultWithdrawTx(body: {
  wallet: string;
  kvault: string;
  amount: string;
}): Promise<{ transaction: string }> {
  return kaminoVaultTx("withdraw", body);
}

/** kVault metrics (APY / share→token レート / token USD 価格)。値は decimal string。 */
export interface KaminoVaultMetrics {
  apy: string;
  tokensPerShare: string;
  tokenPrice: string;
}

export async function fetchKaminoVaultMetrics(
  vault: string
): Promise<KaminoVaultMetrics> {
  const raw = await kaminoGet<{
    apy?: string;
    tokensPerShare?: string;
    tokenPrice?: string;
  }>(`/kvaults/${vault}/metrics`);
  return {
    apy: raw.apy ?? "0",
    tokensPerShare: raw.tokensPerShare ?? "0",
    tokenPrice: raw.tokenPrice ?? "0",
  };
}

/**
 * wallet の kVault 保有 positions。shares は **human 単位の decimal string**
 * (farm 付き vault は stakedShares に入り wallet に SPL が残らない)。
 */
export interface KaminoVaultUserPosition {
  vaultAddress: string;
  stakedShares: string;
  unstakedShares: string;
  totalShares: string;
}

export async function fetchKaminoVaultUserPositions(
  wallet: string
): Promise<KaminoVaultUserPosition[]> {
  const raw = await kaminoGet<unknown>(`/kvaults/users/${wallet}/positions`);
  return (Array.isArray(raw) ? raw : []) as KaminoVaultUserPosition[];
}

/**
 * Phase 8.15.x: user × vault の実 PnL (Kamino 算出)。token 建て earned を直接返す。
 * 値は decimal string (負値・指数表記あり得る — 呼び出し側で正規化)。
 */
export interface KaminoVaultPnl {
  pnlToken: string;
  pnlUsd: string;
  costBasisToken: string;
}

export async function fetchKaminoVaultPnl(
  wallet: string,
  vault: string
): Promise<KaminoVaultPnl> {
  const raw = await kaminoGet<{
    totalPnl?: { token?: string; usd?: string };
    totalCostBasis?: { token?: string };
  }>(`/kvaults/users/${wallet}/vaults/${vault}/pnl`);
  return {
    pnlToken: raw.totalPnl?.token ?? "0",
    pnlUsd: raw.totalPnl?.usd ?? "0",
    costBasisToken: raw.totalCostBasis?.token ?? "0",
  };
}

/**
 * Phase 8.15.x: obligation 全体の実 PnL。sol / usd の 2 建て (decimal string、負値あり)。
 * 供給専用 obligation では ≈ 累積利息。underlying=SOL なら sol、USDC なら usd を使う。
 */
export interface KaminoObligationPnl {
  sol: string;
  usd: string;
}

export async function fetchKaminoObligationPnl(
  market: string,
  obligation: string
): Promise<KaminoObligationPnl> {
  const raw = await kaminoGet<{ sol?: string; usd?: string }>(
    `/v2/kamino-market/${market}/obligations/${obligation}/pnl`
  );
  return { sol: raw.sol ?? "0", usd: raw.usd ?? "0" };
}
