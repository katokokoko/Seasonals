/**
 * lst-rates — LST 1 枚あたりの SOL (lamports) を **protocol 自身の実データ**から取る
 * (Phase 8.73)
 *
 * これまでは Sanctum の `extra-api/v1/sol-value/current` を使っていたが、実測で
 * **系統的に低い**ことが分かった (2026-08-03):
 *
 *   jitoSOL  市場 1.292520615  Sanctum 1.275866054  → −1.29%
 *   mSOL     市場 1.394616137  Sanctum 1.376648063  → −1.29%
 *   INF      市場 1.437545846  Sanctum 1.407837461  → −2.07%
 *
 * この偏りが 2 箇所に効いていた:
 *   1. LST 保有の評価 (underlying = shares × rate) が 1.3〜2.1% 低く出ていた
 *   2. 8.72 のフェアバリューガードが毎回この幅の「幻の乖離」を測っていた
 *
 * 8.70 (jlToken を DAS 価格ではなく convertToAssets で評価) と同じ原則 —
 * **protocol 自身の値 > 第三者の集計値** — に揃える。
 *
 * §4.5: lamports は bigint。比率を float 化しない。
 */

import { fetchWithTimeout } from "./http";
import { buildUrl, getEpochInfo } from "./helius-rpc";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

/** SPL Stake Pool program (jitoSOL の pool の owner) */
const SPL_STAKE_POOL_PROGRAM = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";
/** Sanctum S controller program (INF の pool state の owner) */
const SANCTUM_S_CONTROLLER = "5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx";

const JITO_STAKE_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";
const INF_POOL_STATE = "AYhux5gJzCoeoc1PoJ1VxwPDe22RwcvpHviLDD1oCGvW";
const INF_MINT = "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm";

const MARINADE_MSOL_PRICE_URL = "https://api.marinade.finance/msol/price_sol";

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * 妥当な NAV の範囲 (lamports per whole token)。
 * LST は SOL に対して増える一方なので **1 SOL 未満にはならない**し、現実的に
 * 数 SOL を超えることもない。layout 読み違いを検出する保険 (fail-closed)。
 */
const MIN_SANE_RATE = LAMPORTS_PER_SOL;
const MAX_SANE_RATE = 5n * LAMPORTS_PER_SOL;

function isSane(rate: bigint): boolean {
  return rate >= MIN_SANE_RATE && rate <= MAX_SANE_RATE;
}

// ─────────────────────────────────────────────────────────────────────────────
// 純関数 (parse) — テストしやすいよう I/O から分離
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SPL stake pool account → lamports per 1 pool token。
 *
 * offset は実測で検証済 (borsh、Pubkey 32B が 7 個 + u8 が 2 個):
 *   totalLamports @258 / poolTokenSupply @266 / lastUpdateEpoch @274 (いずれも u64 LE)
 *
 * **採用しない条件** (1 つでも該当したら null):
 *   - owner が SPL stake pool program でない
 *   - accountType (先頭 1 byte) が 1 (StakePool) でない
 *   - poolTokenSupply が 0
 *   - `lastUpdateEpoch` が現在 epoch と一致しない (= 未更新。古い比率を使わない)
 *   - 比率が妥当な範囲外 (layout 読み違いの保険)
 */
export function parseStakePoolRate(
  owner: string,
  data: Buffer,
  currentEpoch: number
): bigint | null {
  if (owner !== SPL_STAKE_POOL_PROGRAM) return null;
  if (data.length < 282) return null;
  if (data.readUInt8(0) !== 1) return null;
  const totalLamports = data.readBigUInt64LE(258);
  const poolTokenSupply = data.readBigUInt64LE(266);
  const lastUpdateEpoch = data.readBigUInt64LE(274);
  if (poolTokenSupply === 0n) return null;
  if (lastUpdateEpoch !== BigInt(currentEpoch)) return null;
  const rate = (totalLamports * LAMPORTS_PER_SOL) / poolTokenSupply;
  return isSane(rate) ? rate : null;
}

/**
 * Sanctum Infinity の pool state → lamports per 1 INF。
 *
 * `total_sol_value` は **offset 0 の u64 LE** (実測。公開 layout doc が見つからず
 * 経験的に特定した)。読み違いに気づけるよう、owner check に加えて
 * **妥当範囲チェックを必ず通す** — offset 0 は discriminator が置かれることも
 * 多い位置なので、ここは特に保険を効かせる。
 */
export function parseInfPoolRate(
  owner: string,
  data: Buffer,
  infSupply: bigint
): bigint | null {
  if (owner !== SANCTUM_S_CONTROLLER) return null;
  if (data.length < 8 || infSupply === 0n) return null;
  const totalSolValue = data.readBigUInt64LE(0);
  const rate = (totalSolValue * LAMPORTS_PER_SOL) / infSupply;
  return isSane(rate) ? rate : null;
}

/** Marinade API の "1.3977423886" → lamports per mSOL (bigint、float 演算なし) */
export function parseMarinadePriceSol(body: string): bigint | null {
  const m = /^\s*([0-9]+)(?:\.([0-9]+))?\s*$/.exec(body);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, 9).padEnd(9, "0");
  try {
    const rate = BigInt(m[1]!) * LAMPORTS_PER_SOL + BigInt(frac);
    return isSane(rate) ? rate : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

let cache: { at: number; values: Map<string, bigint> } | null = null;

export function _clearLstRatesCacheForTest(): void {
  cache = null;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetchWithTimeout(
    buildUrl(),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "seasonals-lst", method, params }),
    },
    FETCH_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? method);
  if (json.result === undefined) throw new Error(`${method} empty result`);
  return json.result;
}

interface AccountValue {
  owner: string;
  data: [string, string];
}

/**
 * symbol → lamports per 1 whole LST。
 *
 * **取れなかった LST は Map に入れない** — 呼び手 (評価 / ガード) が
 * 「rate 不明」として degrade / fail-closed するのが正しく、誤った値で
 * 埋めると静かに間違った金額を出すことになる。
 */
export async function fetchLstSolValues(): Promise<Map<string, bigint>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  const out = new Map<string, bigint>();

  const [accounts, epoch, infSupply, msol] = await Promise.all([
    rpc<{ value: (AccountValue | null)[] }>("getMultipleAccounts", [
      [JITO_STAKE_POOL, INF_POOL_STATE],
      { encoding: "base64" },
    ]).catch(() => null),
    getEpochInfo().catch(() => null),
    rpc<{ value: { amount: string } }>("getTokenSupply", [INF_MINT]).catch(
      () => null
    ),
    fetchWithTimeout(MARINADE_MSOL_PRICE_URL, { method: "GET" }, FETCH_TIMEOUT_MS)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null),
  ]);

  const jito = accounts?.value?.[0];
  if (jito && epoch) {
    const rate = parseStakePoolRate(
      jito.owner,
      Buffer.from(jito.data[0], "base64"),
      epoch.epoch
    );
    if (rate !== null) out.set("jitoSOL", rate);
  }

  const inf = accounts?.value?.[1];
  if (inf && infSupply?.value?.amount && /^[0-9]+$/.test(infSupply.value.amount)) {
    const rate = parseInfPoolRate(
      inf.owner,
      Buffer.from(inf.data[0], "base64"),
      BigInt(infSupply.value.amount)
    );
    if (rate !== null) out.set("INF", rate);
  }

  if (msol !== null) {
    const rate = parseMarinadePriceSol(msol);
    if (rate !== null) out.set("mSOL", rate);
  }

  cache = { at: Date.now(), values: out };
  return out;
}
