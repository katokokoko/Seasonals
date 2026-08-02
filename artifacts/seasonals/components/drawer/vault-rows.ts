/**
 * vault-rows — drill-down のカード行モデル (Phase 8.54)
 *
 * 8.11-8.13 で Jupiter の drill-down だけが「保有を行に統合したカード」に再設計され、
 * 他 11 protocol は素の list 行のまま残っていた。本モジュールはその **行データの
 * 組み立てと出し分け判断** を protocol 非依存の純関数に切り出したもの。
 * `MenuDrawer.tsx` は 2300 行あり render テストが重いので、8.51 の `deposit-cap.ts`
 * と同じく判断ロジックだけを単体テスト可能な形にしてある。
 *
 * §4.5: `underlying_amount` / `accrued_yield_amount` は smallest unit string。
 * ここでの Number 変換は **表示専用** (Phase 8.4.1 の UI carve-out、Jupiter row と
 * 同じ precedent) で、金額計算や tx には一切使われない。
 */
import type {
  EarnPosition,
  ProtocolMenuEntry,
  ProtocolPool,
} from "@workspace/lib/types";
import { findKaminoMarketByReserve, findKaminoVaultByAddress } from "@workspace/lib/config/kamino-markets";
import { findSaveMarketByCToken } from "@workspace/lib/config/save-markets";
import { findExponentMarketByPtMint } from "@workspace/lib/config/exponent-markets";

import { depositCapView, type DepositCapView } from "./deposit-cap";

/** カード行 1 つ分の表示モデル (Jupiter / 他 protocol 共通) */
export interface VaultRow {
  /** React key。pool 由来なら pool_id、Jupiter は jlMint */
  key: string;
  assetSymbol: string;
  /** 行の 2 行目に出す説明 (pool 名など。asset だけでは区別できない protocol 用) */
  subtitle: string;
  apyBps: number;
  tvlUsd: number;
  isDeposited: boolean;
  /** display only — Phase 8.4.1 carve-out (UI direct presentation) */
  userUnderlyingHuman: number;
  userUnderlyingUsd: number;
  /** signed USD earned (loss は負)。display only */
  userEarnedUsd: number;
  /** earned が実 cost-basis 由来か (false なら "—" 表示) */
  userEarnedKnown: boolean;
  earnPosition?: EarnPosition;
  /** deposit dispatch 用の元 pool (§8.15d: Kamino は pool_id で reserve/kVault を判別) */
  pool?: ProtocolPool;
  /** 8.33: read-only listing (Exponent PT 等) — deposit 経路なし */
  displayOnly: boolean;
  /** 8.51/8.52: 預入枠。closed なら CTA を落とす */
  capView: DepositCapView | null;
  /** 8.26: lending market の稼働率 */
  utilization?: number;
  borrowedUsd?: number;
}

/**
 * position → menu の pool_id を registry で解決する。
 *
 * share_mint の意味は protocol ごとに違う (§8.15):
 *   Kamino  … reserve address / kVault address
 *   Save    … cToken mint
 *   Exponent… PT mint
 *   swap-earn (jito/marinade/sanctum/perena/hylo/solstice) … share token mint
 *
 * **swap-earn registry は pool_id を持たない** (`SwapEarnMarket` は protocol_id +
 * underlying_symbol で引く設計) ので、そこは呼び手が asset 一致で fallback する。
 */
export function poolIdForPosition(position: EarnPosition): string | undefined {
  const mint = position.share_mint;
  return (
    findKaminoMarketByReserve(mint)?.pool_id ??
    findKaminoVaultByAddress(mint)?.pool_id ??
    findSaveMarketByCToken(mint)?.pool_id ??
    findExponentMarketByPtMint(mint)?.market_id
  );
}

export interface PositionPartition {
  /** pool_id → position (行に統合できたもの) */
  byPool: Map<string, EarnPosition>;
  /**
   * どの pool にも紐付かなかった position (Meteora / Orca の LP position、
   * Kamino best-effort 等)。**捨てずに** 従来の "Your Positions" に出す。
   */
  unlinked: EarnPosition[];
}

/**
 * protocol の pools と保有 positions を突き合わせる。
 * registry で pool_id が引ければそれを使い、引けない protocol は
 * **同 protocol 内の asset 一致**で紐付ける (1 asset 1 pool の swap-earn 系)。
 */
export function partitionPositions(
  pools: ProtocolPool[],
  positions: EarnPosition[]
): PositionPartition {
  const byPool = new Map<string, EarnPosition>();
  const unlinked: EarnPosition[] = [];
  const poolIds = new Set(pools.map((p) => p.pool_id));
  for (const position of positions) {
    const viaRegistry = poolIdForPosition(position);
    if (viaRegistry && poolIds.has(viaRegistry) && !byPool.has(viaRegistry)) {
      byPool.set(viaRegistry, position);
      continue;
    }
    // fallback: asset 一致 (registry に pool_id が無い swap-earn 系)。
    // 既に埋まっている pool は上書きしない (先勝ち = 表示順の安定)
    const byAsset = pools.find(
      (p) =>
        (p.deposit_asset ?? p.asset) === position.asset_symbol &&
        !byPool.has(p.pool_id)
    );
    if (byAsset && !viaRegistry) {
      byPool.set(byAsset.pool_id, position);
      continue;
    }
    unlinked.push(position);
  }
  return { byPool, unlinked };
}

/** underlying decimals を pool から解決できない場合の既定 (表示のみ) */
function humanAmount(amount: string, decimals: number): number {
  const n = Number(amount) / Math.pow(10, decimals);
  return Number.isFinite(n) ? n : 0;
}

/** position 1 件を行の「保有」部分に落とす (Jupiter row と同じ計算) */
function depositFields(
  position: EarnPosition | undefined
): Pick<
  VaultRow,
  | "isDeposited"
  | "userUnderlyingHuman"
  | "userUnderlyingUsd"
  | "userEarnedUsd"
  | "userEarnedKnown"
> {
  if (!position) {
    return {
      isDeposited: false,
      userUnderlyingHuman: 0,
      userUnderlyingUsd: 0,
      userEarnedUsd: 0,
      userEarnedKnown: false,
    };
  }
  const human = humanAmount(
    position.underlying_amount,
    position.underlying_decimals
  );
  const usd = Number(position.underlying_usd);
  const usdSafe = Number.isFinite(usd) ? usd : 0;
  // Phase 8.13: cost-basis 既知なら実 accrued yield を USD 換算 (損失は負)。
  // 不明ならフェイクの APR 概算を出さず "—" にする
  const earnedKnown = position.accrued_yield_sign !== "unknown";
  let earnedUsd = 0;
  if (earnedKnown) {
    const perUnitUsd = human > 0 ? usdSafe / human : 0;
    const earnedHuman = humanAmount(
      position.accrued_yield_amount,
      position.underlying_decimals
    );
    const magnitude = earnedHuman * perUnitUsd;
    earnedUsd = position.accrued_yield_sign === "loss" ? -magnitude : magnitude;
  }
  return {
    isDeposited: true,
    userUnderlyingHuman: human,
    userUnderlyingUsd: usdSafe,
    userEarnedUsd: earnedUsd,
    userEarnedKnown: earnedKnown,
  };
}

/**
 * protocol entry の pools を **menu 順のまま** カード行に変換する。
 * 並べ替えない — registry の curated 順が保有状況で日替わりしないようにするため。
 */
export function buildPoolVaultRows(
  entry: ProtocolMenuEntry,
  positions: EarnPosition[],
  decimalsOf: (pool: ProtocolPool) => number
): { rows: VaultRow[]; unlinked: EarnPosition[] } {
  const { byPool, unlinked } = partitionPositions(entry.pools, positions);
  const rows = entry.pools.map<VaultRow>((pool) => {
    const position = byPool.get(pool.pool_id);
    const asset = pool.deposit_asset ?? pool.asset;
    return {
      key: pool.pool_id,
      assetSymbol: asset,
      subtitle: pool.name,
      apyBps: Math.round(pool.apy * 10000),
      tvlUsd: pool.tvl_usd,
      earnPosition: position,
      pool,
      displayOnly: pool.display_only === true,
      capView: depositCapView(pool, decimalsOf(pool)),
      ...(pool.utilization != null ? { utilization: pool.utilization } : {}),
      ...(pool.borrowed_usd != null ? { borrowedUsd: pool.borrowed_usd } : {}),
      ...depositFields(position),
    };
  });
  return { rows, unlinked };
}

export interface VaultSummary {
  depositedUsd: number;
  earningsUsd: number;
  /** cost-basis 既知の earned が 1 件でもあるか (false なら earnings は "—") */
  hasKnownEarnings: boolean;
  avgApyBps: number | null;
}

/** 保有行から "Your Balance" を集計する (Phase 8.13 の Jupiter 版を一般化) */
export function computeVaultSummary(rows: VaultRow[]): VaultSummary {
  let depositedUsd = 0;
  let earningsUsd = 0;
  let weighted = 0;
  let hasKnownEarnings = false;
  for (const r of rows) {
    if (!r.isDeposited) continue;
    depositedUsd += r.userUnderlyingUsd;
    // cost-basis 既知の実 earned のみ合算 (符号付き)。不明は概算を混ぜない
    if (r.userEarnedKnown) {
      earningsUsd += r.userEarnedUsd;
      hasKnownEarnings = true;
    }
    weighted += r.userUnderlyingUsd * (r.apyBps / 10000);
  }
  const avgApyBps =
    depositedUsd > 0 ? Math.round((weighted / depositedUsd) * 10000) : null;
  return { depositedUsd, earningsUsd, hasKnownEarnings, avgApyBps };
}

export type VaultFilter = "all" | "stable" | "sol" | "deposited";

export const STABLE_ASSETS = new Set([
  "USDC",
  "USDT",
  "USDS",
  "USDG",
  "EURC",
  "USD*",
  "jupUSD",
  "JupUSD",
  "hyUSD",
  "sHYUSD",
]);

const SOL_ASSETS = new Set(["SOL", "WSOL", "jitoSOL", "mSOL", "INF", "hyloSOL"]);

export function applyVaultFilter(
  rows: VaultRow[],
  filter: VaultFilter
): VaultRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "stable":
      return rows.filter((r) => STABLE_ASSETS.has(r.assetSymbol));
    case "sol":
      return rows.filter((r) => SOL_ASSETS.has(r.assetSymbol));
    case "deposited":
      return rows.filter((r) => r.isDeposited);
  }
}

/**
 * 出すチップを決める。**内容がある時だけ**出す方針 (単一 asset の protocol で
 * 意味のないチップ行を並べない):
 *   - stable / sol … その分類の行があり、かつ **全部がそれではない** 時だけ
 *     (全部 stable の protocol で "All / Stable" を並べても選ぶ意味がない)
 *   - deposited    … 保有が 1 件でもある時だけ
 * 戻り値が `["all"]` だけなら、呼び手はチップ行ごと出さない。
 */
export function visibleFilters(rows: VaultRow[]): VaultFilter[] {
  const out: VaultFilter[] = ["all"];
  const stable = rows.filter((r) => STABLE_ASSETS.has(r.assetSymbol)).length;
  const sol = rows.filter((r) => SOL_ASSETS.has(r.assetSymbol)).length;
  if (stable > 0 && stable < rows.length) out.push("stable");
  if (sol > 0 && sol < rows.length) out.push("sol");
  if (rows.some((r) => r.isDeposited)) out.push("deposited");
  return out;
}

/** この行数を超えたら残りを "Others" に畳む (Jupiter の primary/others と同趣旨) */
export const VISIBLE_ROW_LIMIT = 6;
