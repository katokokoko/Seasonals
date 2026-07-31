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
// 8.51: 署名前の tx 検証 / 8.52: mainnet RPC の URL 組み立ては helius-rpc に集約
import { buildUrl as heliusMainnetUrl, simulateUnsignedTx } from "./helius-rpc";
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
  // 8.51: 上流が「組めるが必ず失敗する tx」を返すことがあるので、署名前に検証する。
  // 8.52: **deposit のみ**。withdraw を対象外にする理由は下の doc を参照
  if (action === "deposit") {
    await assertKlendTxWillSucceed(json.transaction, action, body.reserve);
  }
  return { transaction: json.transaction };
}

/**
 * 8.52: 「組めるが確実に失敗すると分かった tx」。上流が壊れた (HTTP エラー / 空
 * 応答) 場合と区別するために型を分ける — 呼び手はこれを **409** に、それ以外を
 * 502 にマップする (前者はユーザーに提示可能な理由がある)。
 */
export class KaminoDoomedTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KaminoDoomedTxError";
  }
}

/**
 * 8.51: 返ってきた tx を **署名前に mainnet simulate** して、必ず失敗する tx を
 * ユーザーに渡さないようにする。
 *
 * 背景 (実測 2026-08-01): Kamino の `/ktx/klend/*` は body の `reserve` を必須に
 * しておきながら**値を尊重しない**ことがある。main market には USDC リザーブが
 * 4 本あり、`D6q6…` (供給 113M / 上限 1.00B) を要求しても返る tx は常に
 * `5xXxt9uV…` (status Hidden / 供給 0.1 / **deposit limit 0**) を対象にしていた。
 * 結果 program が `DepositLimitExceeded` を投げ、**ユーザーは署名まで進んでから
 * 失敗する**。リザーブが 1 本の mint (SOL / JLP) では正しくルーティングされる。
 *
 * tx から静的に判定する案は破棄した: 対象 reserve は ALT 側にあり、その ALT は
 * 254 件の**共有テーブル**で正しい reserve も誤った reserve も両方含むため、
 * 「含まれるか」では使用の証明にならない (実測で確認)。simulate なら実際の結果を
 * 見るので、誤ルーティングも上限超過も停止中リザーブも一様に捕まえられる。
 *
 * RPC 障害時は fail-open (通す) — ここで止めると外部要因で機能全体が死ぬため。
 *
 * **deposit 限定である理由 (8.52)**: withdraw = ユーザーの出口を、外部 RPC の
 * 判定に依存させない。simulate は fee payer に SOL が無いだけでも落ちるので、
 * 「手数料が足りない」が「would fail on-chain」に化けて **引き出しを塞ぐ** 誤検知に
 * なる。守っている誤ルーティングも deposit limit 由来の現象で、withdraw では
 * 再現しない (実測: 同じ reserve で withdraw は正常にルーティングされる)。
 */
async function assertKlendTxWillSucceed(
  base64Tx: string,
  action: string,
  reserve: string
): Promise<void> {
  const sim = await simulateUnsignedTx(base64Tx).catch(() => ({ ok: true }));
  if (sim.ok) return;
  const detail = "reason" in sim && sim.reason ? `: ${sim.reason}` : "";
  throw new KaminoDoomedTxError(
    `Kamino ${action} tx would fail on-chain (reserve ${reserve})${detail}`
  );
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

// ── Phase 8.51: 預入上限 (deposit cap) ───────────────────────────────────────

/** reserve 1 本分の預入枠。`limit === 0n` は「預入停止中」を意味する。 */
export interface KaminoDepositCap {
  reserve: string;
  /** deposit limit (smallest unit)。0 は停止中 */
  limit: bigint;
}

/**
 * 8.51: reserve 口座から **deposit limit** を読む。
 *
 * Kamino の REST に reserve config を返す口は無い (`/reserves/metrics` は上限を
 * 含まず、`/metrics/history` は含むが 1 リザーブ **22〜32MB** で実用外) ため、
 * on-chain を直接読む。オフセットは Exponent (8.34) と同じ実測 + 交差検証方式:
 *
 *   deposit_limit = offset 5016 (u64 LE, smallest unit)
 *   borrow_limit  = offset 5024 (連続、参考)
 *
 * USDC / SOL / JLP の 3 リザーブすべてで Kamino API の `reserveDepositLimit` と
 * 一致することを実測で確認済 (2026-08-01: 1.0B / 10M / 0)。
 *
 * **レイアウト drift への備え (8.52)**: 凍結した fixture では上流の構造体変更を
 * 検知できないので、二段構えにする:
 *   1. ここでは **口座サイズ完全一致** (8624B) を要求し、違えばその reserve を
 *      skip する = ゴミ値を読むより「上限不明」に倒す
 *   2. 実測での検知は `scripts/verify-tx-routes.mjs` の drift check が担う
 *      (mainnet の 3 reserve を実際に読んでサイズと値を確認する)
 * 単体テスト (`kamino-tx.test.ts`) が固定するのは **デコーダの挙動** であって
 * 上流のレイアウトではない。
 *
 * `getMultipleAccounts` 1 回で全リザーブ分を取得する。取得失敗時は空配列
 * (呼び手は「上限不明」として扱い、既存挙動を壊さない)。上限はまず動かない値
 * なので 60 秒 memoize し、menu と deposit 経路で往復を共有する。
 */
const DEPOSIT_LIMIT_OFFSET = 5016;
/** K-Lend の Reserve 口座サイズ。これ以外はレイアウトが変わったとみなす */
const KLEND_RESERVE_SIZE = 8624;
const CAP_TTL_MS = 60_000;

const capCache = new Map<string, { at: number; cap: KaminoDepositCap }>();

export async function fetchKaminoDepositCaps(
  reserves: string[]
): Promise<KaminoDepositCap[]> {
  if (reserves.length === 0) return [];
  const now = Date.now();
  const cached: KaminoDepositCap[] = [];
  const missing: string[] = [];
  for (const reserve of reserves) {
    const hit = capCache.get(reserve);
    if (hit && now - hit.at < CAP_TTL_MS) cached.push(hit.cap);
    else missing.push(reserve);
  }
  if (missing.length === 0) return cached;
  const fresh = await fetchDepositCapsUncached(missing);
  for (const cap of fresh) capCache.set(cap.reserve, { at: now, cap });
  return [...cached, ...fresh];
}

async function fetchDepositCapsUncached(
  reserves: string[]
): Promise<KaminoDepositCap[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];
  const res = await fetchWithTimeout(heliusMainnetUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-kamino-caps",
      method: "getMultipleAccounts",
      params: [reserves, { encoding: "base64" }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const json = (await res.json().catch(() => null)) as {
    result?: { value?: ({ data?: [string, string] } | null)[] };
  } | null;
  const values = json?.result?.value;
  if (!Array.isArray(values)) return [];
  const out: KaminoDepositCap[] = [];
  values.forEach((v, i) => {
    const reserve = reserves[i];
    if (!reserve || !v?.data?.[0]) return;
    const buf = Buffer.from(v.data[0], "base64");
    // サイズが違う = レイアウトが変わった。ゴミ値を読むより「上限不明」に倒す
    if (buf.length !== KLEND_RESERVE_SIZE) return;
    out.push({ reserve, limit: buf.readBigUInt64LE(DEPOSIT_LIMIT_OFFSET) });
  });
  return out;
}
