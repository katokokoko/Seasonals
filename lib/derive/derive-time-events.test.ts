/**
 * deriveTimeEvents golden test (§29.1 / Phase 8.20)
 *
 * 固定 snapshot + 固定 now に対して deterministic な UnifiedTimeEvent[] を返す
 * こと、および **8 TimeEventCategory 全網羅** を検証する。
 */
import { TIME_EVENT_CATEGORIES, TimeEventCategory, Urgency } from "../types/enums";
import {
  deriveAllTimeEvents,
  deriveTimeEvents,
  type DeriveContext,
  type PositionSnapshot,
} from "./derive-time-events";

const NOW = new Date("2026-07-10T00:00:00.000Z");
const WALLET = "WaLLet111111111111111111111111111111111111";
const ctx: DeriveContext = {
  now: NOW,
  wallet: WALLET,
  epoch: { epoch: 800, endsAtIso: "2026-07-11T12:00:00.000Z", holdsLst: true },
};

/** 8 カテゴリを網羅する固定 fixture (golden) */
const SNAPSHOTS: PositionSnapshot[] = [
  {
    protocol: "kamino",
    position_ref: "Oblig111",
    health: { ltv: 0.58, liquidation_ltv: 0.8 },
    metadata: { source: "kamino_obligation" },
  },
  {
    protocol: "orca",
    position_ref: "Mint111",
    claimable: {
      amount: "157160",
      symbol: "USDC",
      decimals: 6,
      withdraw: {
        share_mint: "Mint111",
        share_decimals: 6,
        underlying_decimals: 6,
        underlying_amount: "350831",
        shares: "350831",
        asset_symbol: "USDC",
      },
    },
  },
  {
    protocol: "loopscale",
    position_ref: "Loan111",
    maturity_at: "2026-07-20T00:00:00.000Z", // +10d → info
  },
  // Phase 8.33: Exponent PT (maturity の実データ源 — BFF mapPtHoldingsToMaturityEvents 相当)
  {
    protocol: "exponent",
    position_ref: "PtMint111",
    maturity_at: "2026-09-16T00:00:00.000Z", // +68d → info
    metadata: {
      source: "exponent_pt",
      side: "PT",
      headline: "PT USX matures — redeemable 1:1 for USX",
    },
  },
  // Phase 8.34: 満期済 PT + maturity_redeem → Redeem action (claim 分岐と同型)
  {
    protocol: "exponent",
    position_ref: "PtMature111",
    maturity_at: "2026-07-01T00:00:00.000Z", // 過去 → critical
    maturity_redeem: {
      share_mint: "PtMature111",
      share_decimals: 6,
      underlying_decimals: 6,
      underlying_amount: "5000000",
      shares: "5000000",
      asset_symbol: "PT-USX",
    },
  },
  {
    protocol: "solana",
    position_ref: "Stake111",
    unlock_at: "2026-07-12T00:00:00.000Z", // +2d → watch
  },
  {
    protocol: "streamflow",
    position_ref: "Stream111",
    vesting_cliff_at: "2026-07-10T12:00:00.000Z", // +12h → critical
  },
  {
    protocol: "realms",
    position_ref: "Prop111",
    vote_deadline_at: "2026-07-13T00:00:00.000Z", // +3d → watch
  },
  {
    protocol: "kamino",
    position_ref: "Oblig111",
    forecast: {
      at: "2026-08-01T00:00:00.000Z",
      headline: "Accrued interest reaches 1 USDC",
    },
  },
];

describe("deriveAllTimeEvents — golden (§29.1)", () => {
  it("8 カテゴリ全網羅 + deterministic (2 回呼んで完全一致)", () => {
    const a = deriveAllTimeEvents(SNAPSHOTS, ctx);
    const b = deriveAllTimeEvents(SNAPSHOTS, ctx);
    expect(a).toEqual(b); // 決定性 (時刻依存は ctx.now に閉じる)

    const categories = new Set(a.map((e) => e.category));
    for (const c of TIME_EVENT_CATEGORIES) {
      expect(categories.has(c)).toBe(true); // 8 種すべて
    }
    expect(a).toHaveLength(10); // 8 カテゴリ + exponent PT maturity ×2 (8.33/8.34)
  });

  it("golden: 各イベントの id / urgency / triggerAt / headline", () => {
    const events = deriveAllTimeEvents(SNAPSHOTS, ctx);
    const byId = new Map(events.map((e) => [e.id, e]));

    const health = byId.get("health_kamino_Oblig111")!;
    expect(health.urgency).toBe(Urgency.Watch); // 0.58/0.8 = 0.725
    expect(health.metadata.source).toBe("kamino_obligation"); // snapshot が上書き
    expect(health.metadata.headline).toBe(
      "Kamino LTV 58.0% (liquidation at 80.0%)"
    );
    expect(health.actions).toHaveLength(0); // fail-closed

    const claim = byId.get("claim_orca_Mint111")!;
    expect(claim.urgency).toBe(Urgency.Info);
    expect(claim.triggerAt).toEqual(NOW);
    expect(claim.metadata.headline).toBe("0.15716 USDC fees claimable on Orca");
    expect(claim.actions).toEqual([
      {
        actionType: "withdraw",
        label: "Withdraw & claim",
        requiresApproval: true,
        riskLevel: "medium",
      },
    ]);
    // synthetic plan 用 metadata
    expect(claim.metadata.protocol_id).toBe("orca");
    expect(claim.metadata.share_mint).toBe("Mint111");
    expect(claim.metadata.shares).toBe("350831");

    expect(byId.get("maturity_loopscale_Loan111")!.urgency).toBe(Urgency.Info); // +10d

    // Phase 8.33: Exponent PT maturity (metadata spread が headline を上書きする)
    const ptMaturity = byId.get("maturity_exponent_PtMint111")!;
    expect(ptMaturity.category).toBe(TimeEventCategory.Maturity);
    expect(ptMaturity.urgency).toBe(Urgency.Info); // +68d
    expect(ptMaturity.metadata.source).toBe("exponent_pt");
    expect(ptMaturity.metadata.headline).toBe(
      "PT USX matures — redeemable 1:1 for USX"
    );
    expect(ptMaturity.actions).toHaveLength(0); // 満期前は action なし (8.34 でも不変)

    // Phase 8.34: 満期済 + maturity_redeem → Redeem action + synthetic plan metadata
    const ptMatured = byId.get("maturity_exponent_PtMature111")!;
    expect(ptMatured.urgency).toBe(Urgency.Critical); // 過去日
    expect(ptMatured.actions).toEqual([
      {
        actionType: "withdraw",
        label: "Redeem",
        requiresApproval: true,
        riskLevel: "medium",
      },
    ]);
    expect(ptMatured.metadata.protocol_id).toBe("exponent");
    expect(ptMatured.metadata.share_mint).toBe("PtMature111");
    expect(ptMatured.metadata.shares).toBe("5000000");
    expect(ptMatured.metadata.asset_symbol).toBe("PT-USX");

    expect(byId.get("lockup_end_solana_Stake111")!.urgency).toBe(Urgency.Watch); // +2d
    expect(byId.get("vesting_cliff_streamflow_Stream111")!.urgency).toBe(Urgency.Critical); // +12h
    expect(byId.get("vote_deadline_realms_Prop111")!.urgency).toBe(Urgency.Watch); // +3d
    expect(byId.get("forecast_kamino_Oblig111")!.metadata.headline).toBe(
      "Accrued interest reaches 1 USDC"
    );

    const epoch = byId.get("epoch_800")!;
    expect(epoch.category).toBe(TimeEventCategory.Epoch);
    expect(epoch.walletAddress).toBe(WALLET);
    expect(epoch.triggerAt.toISOString()).toBe("2026-07-11T12:00:00.000Z");
  });
});

describe("deriveTimeEvents — 閾値境界", () => {
  it("health: ratio <0.7 は出さない / ≥0.9 critical", () => {
    const low = deriveTimeEvents(
      { protocol: "kamino", position_ref: "o", health: { ltv: 0.5, liquidation_ltv: 0.8 } },
      ctx
    );
    expect(low).toHaveLength(0);
    const crit = deriveTimeEvents(
      { protocol: "kamino", position_ref: "o", health: { ltv: 0.75, liquidation_ltv: 0.8 } },
      ctx
    );
    expect(crit[0]!.urgency).toBe(Urgency.Critical);
  });

  it("claim: watch_amount 以上の fee は watch (8.21)、未満/未指定は info", () => {
    const base = {
      protocol: "orca",
      position_ref: "m",
      claimable: { amount: "1500000", symbol: "USDC", decimals: 6 },
    };
    expect(deriveTimeEvents(base, ctx)[0]!.urgency).toBe(Urgency.Info); // 未指定
    expect(
      deriveTimeEvents(
        { ...base, claimable: { ...base.claimable, watch_amount: "1000000" } },
        ctx
      )[0]!.urgency
    ).toBe(Urgency.Watch); // 1.5 >= 1.0
    expect(
      deriveTimeEvents(
        { ...base, claimable: { ...base.claimable, amount: "999999", watch_amount: "1000000" } },
        ctx
      )[0]!.urgency
    ).toBe(Urgency.Info); // 未満
  });

  it("claim: amount 0 / 不正 string は出さない、withdraw 無しは actions 空", () => {
    expect(
      deriveTimeEvents(
        { protocol: "orca", position_ref: "m", claimable: { amount: "0", symbol: "USDC", decimals: 6 } },
        ctx
      )
    ).toHaveLength(0);
    expect(
      deriveTimeEvents(
        { protocol: "orca", position_ref: "m", claimable: { amount: "1.5", symbol: "USDC", decimals: 6 } },
        ctx
      )
    ).toHaveLength(0);
    const noWd = deriveTimeEvents(
      { protocol: "jito", position_ref: "m", claimable: { amount: "500", symbol: "SOL", decimals: 9 } },
      ctx
    );
    expect(noWd[0]!.actions).toHaveLength(0);
  });

  it("lockup_end: 過去日 = 解除済 → watch + withdrawable headline", () => {
    const e = deriveTimeEvents(
      { protocol: "solana", position_ref: "s", unlock_at: "2026-07-01T00:00:00.000Z" },
      ctx
    )[0]!;
    expect(e.urgency).toBe(Urgency.Watch);
    expect(e.metadata.unlocked).toBe(true);
    expect(e.metadata.headline).toBe("Solana stake withdrawable now");
  });

  it("epoch: holdsLst=false なら出さない / snapshot 0 件でも LST 保持なら出る", () => {
    expect(
      deriveAllTimeEvents([], { ...ctx, epoch: { ...ctx.epoch!, holdsLst: false } })
    ).toHaveLength(0);
    const only = deriveAllTimeEvents([], ctx);
    expect(only).toHaveLength(1);
    expect(only[0]!.id).toBe("epoch_800");
  });
});
