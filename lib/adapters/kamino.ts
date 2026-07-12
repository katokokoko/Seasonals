/**
 * Kamino LendingAdapter — mock 実装 (CLAUDE.md §28 Tier S)
 *
 * 現状 (Phase C): fixture ベースの mock。reserve list / position fetch / simulate /
 * buildTransaction のすべてを realistic な shape で返す。
 *
 * 将来 mainnet SDK に差し替える際の置換ポイント:
 *   - `fetchPositions` → klend-sdk の `KaminoMarket.getUserObligation()`
 *   - `fetchReserves` → `KaminoMarket.getAllReserves()`
 *   - `simulate` → reserve cToken exchange rate + APY を実 reserve から計算
 *   - `buildTransaction` → klend-sdk の `KaminoAction.depositTransaction(...)` 等
 *
 * @see https://github.com/Kamino-Finance/klend-sdk
 * @see CLAUDE.md §13 / §26
 */

import {
  fixturePositionKaminoLending,
  fixturePositionKaminoBorrow,
} from "../__fixtures__/positions";
import {
  ActionType,
  PositionCategory,
  TrustLevel,
} from "../types/enums";
import type { ActionSpec } from "../types/agent-plan";
import type { Position } from "../types/position";

import type {
  AdapterContext,
  AdapterMeta,
  AdapterSimulation,
  LendingAdapter,
  LendingReserveInfo,
} from "./types";

const META: AdapterMeta = {
  protocol_id: "kamino",
  display_name: "Kamino",
  category: PositionCategory.Lending,
  trust_level: TrustLevel.S,
  program_id_mainnet: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  program_id_devnet: null,
};

/** mock reserves — 将来 klend-sdk の KaminoMarket.getAllReserves() 出力に置換 */
const MOCK_RESERVES: LendingReserveInfo[] = [
  {
    reserve_id: "kamino:USDC-main",
    name: "USDC Main Market",
    asset_symbol: "USDC",
    lend_apy: 0.0842,
    borrow_apy: 0.1245,
    utilization: 0.72,
    tvl_usd: "287500000.00000000",
  },
  {
    reserve_id: "kamino:SOL-main",
    name: "SOL Main Market",
    asset_symbol: "SOL",
    lend_apy: 0.0421,
    borrow_apy: 0.0825,
    utilization: 0.68,
    tvl_usd: "164300000.00000000",
  },
  {
    reserve_id: "kamino:JLP-main",
    name: "JLP Lending",
    asset_symbol: "JLP",
    lend_apy: 0.0915,
    borrow_apy: 0.1542,
    utilization: 0.81,
    tvl_usd: "92800000.00000000",
  },
  {
    reserve_id: "kamino:jitoSOL-main",
    name: "jitoSOL Lending",
    asset_symbol: "jitoSOL",
    lend_apy: 0.0568,
    borrow_apy: 0.0921,
    utilization: 0.75,
    tvl_usd: "78400000.00000000",
  },
];

/** USDC mint (mainnet) — Devnet では別 mint だが mock では mainnet を流用 */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Memo Program — buildTransaction で stub 用 */
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export const kaminoAdapter: LendingAdapter = {
  meta: META,

  async fetchPositions(_ctx: AdapterContext): Promise<Position[]> {
    // mock: 任意 wallet に対し fixture の Kamino positions を返す
    // 将来: KaminoMarket.getUserObligation(wallet) で実 obligation account を read
    // shallow copy で十分 (呼び出し側は read-only 消費、fetchReserves と同 precedent)。
    // structuredClone は tsconfig lib 非依存にするため使わない (baseline TS2304 回避)。
    return [
      { ...fixturePositionKaminoLending },
      { ...fixturePositionKaminoBorrow },
    ];
  },

  async fetchReserves(_ctx: AdapterContext): Promise<LendingReserveInfo[]> {
    return MOCK_RESERVES.map((r) => ({ ...r }));
  },

  async simulate(
    _ctx: AdapterContext,
    spec: ActionSpec
  ): Promise<AdapterSimulation> {
    const reserve = MOCK_RESERVES.find(
      (r) => r.asset_symbol === (spec.asset ?? "USDC")
    );
    const apy = reserve?.lend_apy ?? 0.05;
    const amount = spec.amount ?? "0";

    // 30 日後の estimated_out を APY ベースで概算
    const days = 30;
    const principalNum = Number(amount); // smallest unit、unit は asset 依存
    const yieldNum = Math.floor(principalNum * apy * (days / 365));
    const estimatedOut = String(principalNum + yieldNum);

    return {
      estimated_out: estimatedOut,
      // Solana の standard fee + Kamino 内部 fee の概算 (5000 lamports + 0.05% of principal)
      estimated_fee: String(Math.max(5000, Math.floor(principalNum * 0.0005))),
      slippage_bps: 0, // lending は slippage なし
      metadata: {
        reserve_id: reserve?.reserve_id,
        apy,
        days,
      },
    };
  },

  async buildTransaction(
    _ctx: AdapterContext,
    _spec: ActionSpec
  ): Promise<{ tx_base64: string }> {
    // mock: BFF 側の buildMemoTransaction で memo tx を構築するため、本層は
    // metadata だけ返す。実 BFF 統合では BFF が adapter の simulate 結果から
    // memo or 実 instruction を選択して serialize する。
    // (本 method は将来 klend-sdk の depositTransaction(...) 等を呼ぶ予定。)
    return { tx_base64: "" };
  },

  supportedActions(): ActionType[] {
    return [
      ActionType.Deposit,
      ActionType.Withdraw,
      ActionType.ReDeposit,
      ActionType.ReDepositIncludeYield,
      ActionType.ReDepositExcludeYield,
      ActionType.Repay,
      ActionType.AddCollateral,
    ];
  },
};

export const KAMINO_USDC_MINT = USDC_MINT;
export const KAMINO_MEMO_PROGRAM = MEMO_PROGRAM;
