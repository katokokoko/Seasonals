/**
 * Adapter SDK — 仕様書 §13 / §26
 *
 * 各 protocol (Kamino / Jito / Streamflow / Marinade / etc.) が共通 interface を
 * 実装することで、Mobile / BFF / MCP Server から **protocol 非依存** で扱える。
 *
 * 設計原則:
 * - Adapter 単位で `protocol_id` (lib/types の trusted registry と一致) と `category`
 *   (lib/types/enums の PositionCategory) を declare
 * - 全 method が **non-blocking async** で network I/O を抽象化 (BFF 側で Solana RPC
 *   を持ち、Mobile は HTTP 経由で adapter を消費)
 * - 数値は smallest unit string で受け渡し (CLAUDE.md §3、`numeric.ts` 経由)
 *
 * 現状 (Phase C):
 *   mock 実装が default。`process.env.SEASONALS_USE_REAL_ADAPTER === "true"` で
 *   将来 mainnet SDK に差し替える hook あり。
 *
 * @see CLAUDE.md §13 (Adapter Pattern)
 * @see CLAUDE.md §26 (8 categories of time)
 */

import type {
  ActionType,
  PositionCategory,
  TrustLevel,
} from "../types/enums";
import type { Position } from "../types/position";
import type {
  ActionSpec,
  SimulationResult,
} from "../types/agent-plan";

// ─────────────────────────────────────────────────────────────────────────────
// Adapter base
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterMeta {
  protocol_id: string;
  display_name: string;
  category: PositionCategory;
  trust_level: TrustLevel;
  /** mainnet program ID (Devnet では同じ ID で deployed されない場合あり) */
  program_id_mainnet: string;
  /** Devnet program ID (なければ null = mock-only) */
  program_id_devnet: string | null;
}

/** simulate_action / build_transaction で使う共通 input */
export interface AdapterContext {
  /** wallet address (base58) */
  wallet_address: string;
  /** "solana:devnet" / "solana:mainnet" */
  chain: "solana:devnet" | "solana:mainnet";
}

/** simulate_action のレスポンス内訳 (BFF が組み立てた SimulationResult のうち
 *  adapter 固有部分。oracle / bundle_hash は adapter 外で merge する) */
export interface AdapterSimulation {
  estimated_out: string;
  estimated_fee: string;
  /** rotate / swap action の slippage */
  slippage_bps?: number;
  /** route info (Jupiter 等の swap aggregator が複数 hop を経る場合に表示) */
  route?: AdapterRouteHop[];
  metadata?: Record<string, unknown>;
}

export interface AdapterRouteHop {
  /** input token mint (base58) */
  input_mint: string;
  /** output token mint (base58) */
  output_mint: string;
  /** dex / aggregator label (例: "Jupiter:Orca") */
  amm_key: string;
  /** percentage of total (0..100、複数 route 並列時) */
  percent: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LendingAdapter — Kamino / Solend / etc.
// ─────────────────────────────────────────────────────────────────────────────

export interface LendingAdapter {
  meta: AdapterMeta;

  /**
   * 指定 wallet の lending position 一覧。Reserve ごとに principal / current /
   * accrued yield を smallest unit string で返す。空配列なら deposit / borrow なし。
   */
  fetchPositions(ctx: AdapterContext): Promise<Position[]>;

  /**
   * 利用可能な reserve (asset 種別 / lend APY / borrow APY / utilization 等)。
   * UI の "explore lending" でユーザーに提示する候補。
   */
  fetchReserves(ctx: AdapterContext): Promise<LendingReserveInfo[]>;

  /**
   * deposit / withdraw 等の action を simulate。on-chain instruction 構築前の
   * pre-check + 推定値計算。
   */
  simulate(
    ctx: AdapterContext,
    spec: ActionSpec
  ): Promise<AdapterSimulation>;

  /**
   * 実 instruction を base64 serialized transaction で返す。
   * mock impl では memo tx (CLAUDE.md sub-3 で実装済) を返す stub。
   * 将来 mainnet SDK に差し替えれば実 Kamino instruction 構築。
   */
  buildTransaction(
    ctx: AdapterContext,
    spec: ActionSpec
  ): Promise<{ tx_base64: string }>;

  /** action_type 一覧 (UI 候補ボタンの自動生成用) */
  supportedActions(): ActionType[];
}

export interface LendingReserveInfo {
  /** reserve 一意 ID (protocol 内、e.g., "kamino:USDC-main") */
  reserve_id: string;
  /** display name ("USDC Main Market") */
  name: string;
  asset_symbol: string;
  /** lend APY (0..1) */
  lend_apy: number;
  /** borrow APY (0..1) */
  borrow_apy: number;
  /** utilization (0..1) */
  utilization: number;
  /** TVL in USD (8 decimals string) */
  tvl_usd: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SwapAdapter — Jupiter / Raydium / etc.
// ─────────────────────────────────────────────────────────────────────────────

export interface SwapAdapter {
  meta: AdapterMeta;

  /**
   * 指定 input → output で best route を取得。complete swap の simulate 相当。
   */
  quote(input: SwapQuoteInput): Promise<SwapQuoteResult>;

  /**
   * 上記 quote を実 instruction (base64) に。MWA で signing して broadcast 可能。
   */
  buildTransaction(
    ctx: AdapterContext,
    quote: SwapQuoteResult
  ): Promise<{ tx_base64: string }>;
}

export interface SwapQuoteInput {
  input_mint: string;
  output_mint: string;
  /** smallest unit of input */
  amount: string;
  /** allowed slippage (bps、e.g., 50 = 0.5%) */
  slippage_bps: number;
}

export interface SwapQuoteResult {
  input_mint: string;
  output_mint: string;
  in_amount: string;
  /** estimated out (smallest unit) */
  out_amount: string;
  /** ExpectedOut の最小値 (slippage 適用後) */
  min_out_amount: string;
  slippage_bps: number;
  route: AdapterRouteHop[];
  /** quote 取得時刻 (validity check 用) */
  quoted_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry — adapter 解決 (protocol_id → adapter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 簡易 registry。BFF / Mobile から `getLendingAdapter("kamino")` のように呼ぶ。
 * 実際の adapter instance は実装側で register する (循環 import 回避のため
 * ここでは型のみ定義、実装は lib/adapters/registry.ts)。
 */
export interface AdapterRegistry {
  registerLending(adapter: LendingAdapter): void;
  registerSwap(adapter: SwapAdapter): void;
  getLending(protocol_id: string): LendingAdapter | undefined;
  getSwap(protocol_id: string): SwapAdapter | undefined;
  listLending(): LendingAdapter[];
  listSwap(): SwapAdapter[];
}

// SimulationResult 型を re-export (caller 側で adapter result を merge 用)
export type { SimulationResult };
