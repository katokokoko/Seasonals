/**
 * agent plan の simulate 結果 (SimulationResult) を承認 UI に出す文言 (Seeker の承認画面と web の inbox で共有)。
 *
 * 2026-10-08: simulate は mock registry をやめ、route ごとの実見積り (Jupiter quote / 交換レート) を返す。
 * 新形式は受け取り token の単位 (`estimated_out_symbol` / `estimated_out_decimals`) を持つので、
 * 入力 asset の単位で表示しない (例: jupiter_lend の deposit で受け取るのは jlUSDC)。
 * `estimate_kind` が無い旧形式 (永続済み plan / fixture) だけは従来どおり入力 asset の単位で出す。
 *
 * 金額は smallest unit string のまま受け、表示直前に toHumanReadable (CLAUDE.md §4.5)。
 */
import type {
  SimulationFailureReason,
  SimulationResult,
  SimulationWarning,
} from "../types";
import { toHumanReadable } from "../utils/numeric";
import { UNSUPPORTED_MARKET_MESSAGE } from "./solana-action";

/** 旧形式の結果を出す時の単位 (呼び手の入力 asset) */
export interface LegacySimulationUnit {
  decimals: number;
  unitSymbol: string;
}

/** SOL の decimals (新形式の estimated_fee は lamports) */
const SOL_DECIMALS = 9;

/** smallest unit → human。不正な値は元の文字列を返す (表示で落とさない) */
function human(value: string, decimals: number): string {
  try {
    return toHumanReadable(value, decimals);
  } catch {
    return value;
  }
}

const FAILURE_TEXT: Record<SimulationFailureReason, string> = {
  unsupported_market: UNSUPPORTED_MARKET_MESSAGE,
  asset_mismatch: "Pool does not match asset",
  amount_required: "Amount required",
  quote_unavailable: "Quote unavailable",
  rate_unavailable: "Exchange rate unavailable",
};

const WARNING_TEXT: Record<SimulationWarning, string> = {
  fair_value_deviation: "The swap price is far from the redemption value",
  fair_value_unavailable: "Couldn't verify the redemption value",
  deposit_unavailable: "Deposits are paused for this market",
};

/** 見積り不能の理由を文に。未知の値はそのまま出す */
export function describeSimulationFailure(reason: SimulationFailureReason | string): string {
  return (FAILURE_TEXT as Record<string, string>)[reason] ?? reason;
}

/** oracle 以外の注意を文に。未知の値はそのまま出す */
export function describeSimulationWarning(warning: SimulationWarning | string): string {
  return (WARNING_TEXT as Record<string, string>)[warning] ?? warning;
}

/**
 * 推定受け取り量の表示文。出すものが無ければ null。
 * - 旧形式: `${human} ${legacy.unitSymbol}`
 * - quote / exchange_rate: `≈ ${human} ${symbol}`
 * - same_as_input: `${human} ${symbol}`
 * - lp_position / pt_redeem: 説明文 (単一の受け取り量が無い)
 * - none (または failure_reason がある時): 理由の文
 */
export function describeSimulationOut(
  sim: SimulationResult,
  legacy: LegacySimulationUnit
): string | null {
  if (sim.estimate_kind === undefined) {
    if (sim.estimated_out === undefined) return null;
    return `${human(sim.estimated_out, legacy.decimals)} ${legacy.unitSymbol}`;
  }
  if (sim.failure_reason !== undefined || sim.estimate_kind === "none") {
    return sim.failure_reason !== undefined
      ? describeSimulationFailure(sim.failure_reason)
      : "No estimate";
  }
  switch (sim.estimate_kind) {
    case "lp_position":
      return "LP position (no single output)";
    case "pt_redeem":
      return "PT redeems for underlying at maturity";
    case "quote":
    case "exchange_rate":
    case "same_as_input": {
      if (sim.estimated_out === undefined) return null;
      const decimals = sim.estimated_out_decimals ?? legacy.decimals;
      const symbol = sim.estimated_out_symbol ?? legacy.unitSymbol;
      const prefix = sim.estimate_kind === "same_as_input" ? "" : "≈ ";
      return `${prefix}${human(sim.estimated_out, decimals)} ${symbol}`;
    }
  }
}

/**
 * 推定手数料の表示文。出すものが無ければ null。
 * 旧形式は入力 asset の単位、新形式は SOL (lamports)。新形式の BFF は fee を出さないので通常 null
 */
export function describeSimulationFee(
  sim: SimulationResult,
  legacy: LegacySimulationUnit
): string | null {
  if (sim.estimated_fee === undefined) return null;
  if (sim.estimate_kind === undefined) {
    return `${human(sim.estimated_fee, legacy.decimals)} ${legacy.unitSymbol}`;
  }
  return `${human(sim.estimated_fee, SOL_DECIMALS)} SOL`;
}
