/**
 * Phase 8.16: wallet 由来カレンダーイベントのテスト (pure functions、network 不要)。
 *   - mapTxsToWalletTimeEvents: 全 protocol 化 (jl 回帰 + LST/Save) + bigint 金額
 *   - buildEpochBoundaryEvent: LST 保有時のみ / 境界時刻の概算
 *   - mapObligationsToHealthEvents: 借入のみ / LTV 閾値 3 段
 */
import { TimeEventCategory, Urgency } from "@workspace/lib/types";
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";

import {
  buildEpochBoundaryEvent,
  mapLpPositionsToClaimEvents,
  mapObligationsToHealthEvents,
  mapStakeAccountsToLockupEvents,
  mapTxsToWalletTimeEvents,
} from "./server";
import type { HeliusEnhancedTx } from "./clients/helius-tx";
import type { OrcaRawPosition } from "./clients/orca-tx";
import type { MeteoraRawPosition } from "./clients/meteora-tx";

const WALLET = "WaLLet1111111111111111111111111111111111111";
const JL_USDC = SWAP_EARN_MARKETS.find(
  (m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC"
)!;
const JITO = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jito")!;
const SAVE_USDC = SAVE_MARKETS.find((m) => m.underlying_symbol === "USDC")!;

function bal(mint: string, owner: string, raw: string, decimals = 6) {
  return { mint, userAccount: owner, rawTokenAmount: { tokenAmount: raw, decimals } };
}
function tx(sig: string, changes: ReturnType<typeof bal>[]): HeliusEnhancedTx {
  return {
    signature: sig,
    timestamp: 1_700_000_000,
    type: "SWAP",
    fee: 5000,
    accountData: [{ account: "ACC", tokenBalanceChanges: changes }],
  };
}

describe("mapTxsToWalletTimeEvents — Phase 8.16 全 protocol 化", () => {
  it("jl 回帰: jlUSDC 入金 → jupiter_lend deposit イベント (headline 付き)", () => {
    const events = mapTxsToWalletTimeEvents(
      [tx("s1", [bal(JL_USDC.share_mint, WALLET, "1500000")])],
      WALLET
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("tx_s1_0");
    expect(e.protocol).toBe("jupiter_lend");
    expect(e.category).toBe(TimeEventCategory.Epoch);
    expect(e.metadata.direction).toBe("deposit");
    expect(e.metadata.headline).toBe("Deposited 1.5 jlUSDC on Jupiter Lend");
    expect(e.metadata.source).toBe("helius_tx");
  });

  it("jitoSOL 出金 → jito withdraw イベント (bigint 合算、9 dec)", () => {
    const events = mapTxsToWalletTimeEvents(
      [
        tx("s2", [
          bal(JITO.share_mint, WALLET, "-30000000", 9),
          bal(JITO.share_mint, WALLET, "-20000000", 9), // 同 tx 内は合算
        ]),
      ],
      WALLET
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.protocol).toBe("jito");
    expect(events[0]!.metadata.direction).toBe("withdraw");
    expect(events[0]!.metadata.headline).toBe("Withdrew 0.05 jitoSOL on Jito");
  });

  it("cUSDC 入金 → savefi イベント", () => {
    const events = mapTxsToWalletTimeEvents(
      [tx("s3", [bal(SAVE_USDC.ctoken_mint, WALLET, "769000")])],
      WALLET
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.protocol).toBe("savefi");
    expect(events[0]!.metadata.headline).toBe("Deposited 0.769 cUSDC on Save");
  });

  it("他人の change / 未登録 mint / delta 0 は無視", () => {
    const events = mapTxsToWalletTimeEvents(
      [
        tx("s4", [
          bal(JL_USDC.share_mint, "SomeoneElse111111111111111111111111", "1"),
          bal("UnknownMint11111111111111111111111111111", WALLET, "5"),
          bal(JITO.share_mint, WALLET, "10", 9),
          bal(JITO.share_mint, WALLET, "-10", 9),
        ]),
      ],
      WALLET
    );
    expect(events).toHaveLength(0);
  });
});

describe("buildEpochBoundaryEvent", () => {
  const info = { epoch: 800, slotIndex: 100_000, slotsInEpoch: 432_000 };
  const now = new Date("2026-07-10T00:00:00Z");

  it("LST 保有時のみ生成、triggerAt = now + remaining×400ms", () => {
    const e = buildEpochBoundaryEvent(info, true, WALLET, now);
    expect(e).not.toBeNull();
    expect(e!.category).toBe(TimeEventCategory.Epoch);
    expect(e!.metadata.source).toBe("epoch_info");
    const expectedMs = now.getTime() + (432_000 - 100_000) * 400;
    expect(new Date(e!.triggerAt).getTime()).toBe(expectedMs);
    expect(e!.metadata.headline).toContain("Epoch 800");
  });

  it("LST 非保有は null", () => {
    expect(buildEpochBoundaryEvent(info, false, WALLET, now)).toBeNull();
  });
});

describe("mapObligationsToHealthEvents", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  const EMPTY = "11111111111111111111111111111111";
  const oblig = (ltv: number, liq: number, borrow = true, addr = "OB1") => ({
    obligationAddress: addr,
    borrows: borrow
      ? [{ borrowReserve: "SomeBorrowReserve1111111111111111111111" }]
      : [{ borrowReserve: EMPTY }],
    refreshedStats: { loanToValue: String(ltv), liquidationLtv: String(liq) },
  });

  it("LTV/liqLTV ≥ 0.9 → Critical", () => {
    const events = mapObligationsToHealthEvents([oblig(0.58, 0.6)], WALLET, now);
    expect(events).toHaveLength(1);
    expect(events[0]!.category).toBe(TimeEventCategory.Health);
    expect(events[0]!.urgency).toBe(Urgency.Critical);
    expect(events[0]!.positionRef).toBe("OB1");
    expect(events[0]!.metadata.headline).toContain("Kamino LTV 58.0%");
    expect(events[0]!.actions).toHaveLength(0); // fail-closed: repay 経路未実装
  });

  it("≥ 0.7 → Watch、< 0.7 → イベント無し", () => {
    expect(
      mapObligationsToHealthEvents([oblig(0.45, 0.6)], WALLET, now)[0]!.urgency
    ).toBe(Urgency.Watch);
    expect(mapObligationsToHealthEvents([oblig(0.3, 0.6)], WALLET, now)).toHaveLength(0);
  });

  it("借入なし obligation は対象外", () => {
    expect(
      mapObligationsToHealthEvents([oblig(0.59, 0.6, false)], WALLET, now)
    ).toHaveLength(0);
  });

  it("state 配下形 (top-level が空 {} の実 API shape) でも検出する", () => {
    // live 検証で確認: AfcZ… の obligation は top-level deposits/borrows が {} で
    // 実データは state.deposits / state.borrows に入る
    const stateForm = {
      obligationAddress: "OB_STATE",
      deposits: {},
      borrows: {},
      state: {
        borrows: [
          { borrowReserve: "SomeBorrowReserve1111111111111111111111" },
        ],
      },
      refreshedStats: { loanToValue: "0.587", liquidationLtv: "0.6" },
    };
    const events = mapObligationsToHealthEvents([stateForm], WALLET, now);
    expect(events).toHaveLength(1);
    expect(events[0]!.urgency).toBe(Urgency.Critical);
    expect(events[0]!.positionRef).toBe("OB_STATE");
  });
});

// ── Phase 8.20: LP claim + native stake lockup_end ───────────────────────────

describe("mapLpPositionsToClaimEvents — Phase 8.20", () => {
  const now = new Date("2026-07-10T00:00:00.000Z");
  // Orca USDC-USDT (deposit=A、sqrt 2^64 → price 1.0): fee = feeA + feeB
  const orcaPos: OrcaRawPosition = {
    pool_id: "orca_usdc_usdt_whirlpool",
    position_address: "PdA111",
    position_mint: "Mint111",
    liquidity: "1",
    token_a: "1000000",
    token_b: "1000000",
    fee_owed_a: "100000",
    fee_owed_b: "57160",
    sqrt_price: "18446744073709551616",
    tick_lower: -443636,
    tick_upper: 443636,
  };
  // Meteora SOL-USDC (deposit=Y): fee_y のみ
  const meteoraPos: MeteoraRawPosition = {
    pool_id: "meteora_sol_usdc_dlmm",
    position_address: "MetPos111",
    total_x: "0",
    total_y: "100000000",
    fee_x: "0",
    fee_y: "50000",
    price_raw: "0.18210923719745299511",
    lower_bin_id: -1724,
    upper_bin_id: -1704,
  };

  it("fee > 0 の LP position → claim イベント (action + synthetic plan metadata)", () => {
    const events = mapLpPositionsToClaimEvents([orcaPos], [meteoraPos], WALLET, now);
    expect(events).toHaveLength(2);

    const orca = events.find((e) => e.id === "claim_orca_Mint111")!;
    expect(orca.category).toBe(TimeEventCategory.Claim);
    expect(orca.protocol).toBe("orca");
    expect(orca.urgency).toBe(Urgency.Info);
    expect(orca.triggerAt).toBe(now.toISOString());
    expect(orca.metadata.headline).toBe("0.15716 USDC fees claimable on Orca");
    expect(orca.actions).toEqual([
      {
        actionType: "withdraw",
        label: "Withdraw & claim",
        requiresApproval: true,
        riskLevel: "medium",
      },
    ]);
    // mobile handleActionPress が読む synthetic plan 用フィールド
    expect(orca.metadata.protocol_id).toBe("orca");
    expect(orca.metadata.share_mint).toBe("Mint111");
    expect(orca.metadata.shares).toBe("2000000"); // total = a + b (price 1.0)
    expect(orca.metadata.asset_symbol).toBe("USDC");
    expect(orca.metadata.pool_id).toBe("orca_usdc_usdt_whirlpool");

    const met = events.find((e) => e.id === "claim_meteora_MetPos111")!;
    expect(met.protocol).toBe("meteora");
    expect(met.metadata.share_mint).toBe("MetPos111");
    expect(met.metadata.headline).toBe("0.05 USDC fees claimable on Meteora");
  });

  it("fee = 0 / 未知 pool は出さない", () => {
    const noFee = { ...orcaPos, fee_owed_a: "0", fee_owed_b: "0" };
    const unknown = { ...orcaPos, pool_id: "orca_unknown" };
    expect(
      mapLpPositionsToClaimEvents([noFee, unknown], [], WALLET, now)
    ).toHaveLength(0);
  });

  it("fee >= 1 USDC は watch に昇格 (8.21 閾値)", () => {
    const bigFee = { ...orcaPos, fee_owed_a: "900000", fee_owed_b: "200000" }; // 1.1 USDC
    const events = mapLpPositionsToClaimEvents([bigFee], [], WALLET, now);
    expect(events[0]!.urgency).toBe(Urgency.Watch);
  });
});

describe("mapStakeAccountsToLockupEvents — Phase 8.20", () => {
  const now = new Date("2026-07-10T00:00:00.000Z");
  const epochInfo = { epoch: 800, slotIndex: 100_000, slotsInEpoch: 432_000 };

  it("cooldown 中 (deactivationEpoch = 現 epoch) → epoch 境界の lockup_end", () => {
    const events = mapStakeAccountsToLockupEvents(
      [{ address: "Stake111", stake_lamports: "5000000000", deactivation_epoch: "800" }],
      epochInfo,
      WALLET,
      now
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("lockup_end_solana_Stake111");
    expect(e.category).toBe(TimeEventCategory.LockupEnd);
    // 境界 = now + (432000-100000)×400ms → 未来日 (critical: ≤1d... 332000*400ms ≈ 1.54d → watch)
    expect(e.urgency).toBe(Urgency.Watch);
    expect(e.metadata.unlocked).toBe(false);
    expect(e.metadata.headline).toBe(
      "5 SOL unstaking — withdrawable after epoch 800"
    );
  });

  it("解除済 (deactivationEpoch < 現 epoch) → withdrawable now (watch)", () => {
    const events = mapStakeAccountsToLockupEvents(
      [{ address: "Stake222", stake_lamports: "1000000000", deactivation_epoch: "799" }],
      epochInfo,
      WALLET,
      now
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.urgency).toBe(Urgency.Watch);
    expect(events[0]!.metadata.unlocked).toBe(true);
    expect(events[0]!.metadata.headline).toBe("1 SOL unstaked — withdrawable now");
  });

  it("active (u64::MAX) / 不正 epoch string は出さない", () => {
    const events = mapStakeAccountsToLockupEvents(
      [
        { address: "S1", stake_lamports: "1", deactivation_epoch: "18446744073709551615" },
        { address: "S2", stake_lamports: "1", deactivation_epoch: "abc" },
      ],
      epochInfo,
      WALLET,
      now
    );
    expect(events).toHaveLength(0);
  });
});
