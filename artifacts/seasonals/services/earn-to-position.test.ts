/**
 * Phase 8.13: earn-to-position が BFF の実 accrued yield を Position に伝搬するか検証。
 *   - accrued_yield_amount は magnitude string をそのまま持つ
 *   - principal_amount は cost_basis 既知なら実元本、不明なら underlying_amount
 *   - 符号 / 既知性は raw_state (accrued_yield_sign / cost_basis_amount) に載る
 */

import type { EarnPosition, Position } from "@workspace/lib/types";
import { earnPositionToPosition, mergeEarnPositions } from "./earn-to-position";

function makeEarn(overrides: Partial<EarnPosition> = {}): EarnPosition {
  return {
    protocol_id: "jupiter_lend",
    protocol_name: "Jupiter Lend",
    market_symbol: "USDC",
    share_mint: "JL_USDC_MINT",
    shares: "1000000",
    share_decimals: 6,
    asset_symbol: "USDC",
    underlying_amount: "100420000",
    underlying_decimals: 6,
    underlying_usd: "100.42",
    supply_rate_bps: 303,
    accrued_yield_amount: "0",
    accrued_yield_sign: "unknown",
    cost_basis_amount: null,
    ...overrides,
  };
}

describe("earnPositionToPosition — Phase 8.13 accrued yield", () => {
  it("gain: accrued_yield_amount をコピーし principal を cost_basis にする", () => {
    const pos = earnPositionToPosition(
      makeEarn({
        accrued_yield_amount: "420000",
        accrued_yield_sign: "gain",
        cost_basis_amount: "100000000",
      })
    );
    expect(pos.accrued_yield_amount).toBe("420000");
    expect(pos.principal_amount).toBe("100000000");
    expect(pos.current_amount).toBe("100420000");
    expect(pos.raw_state).toMatchObject({
      accrued_yield_sign: "gain",
      cost_basis_amount: "100000000",
    });
  });

  it("loss: magnitude string をそのまま持ち sign=loss を raw_state に載せる", () => {
    const pos = earnPositionToPosition(
      makeEarn({
        underlying_amount: "99500000",
        accrued_yield_amount: "500000",
        accrued_yield_sign: "loss",
        cost_basis_amount: "100000000",
      })
    );
    expect(pos.accrued_yield_amount).toBe("500000");
    expect(pos.accrued_yield_amount).toMatch(/^[0-9]+$/); // 負数 string にしない
    expect(pos.principal_amount).toBe("100000000");
    expect((pos.raw_state as Record<string, unknown>).accrued_yield_sign).toBe(
      "loss"
    );
  });

  it("unknown: cost_basis 不明なら principal は underlying_amount に fallback", () => {
    const pos = earnPositionToPosition(
      makeEarn({
        accrued_yield_amount: "0",
        accrued_yield_sign: "unknown",
        cost_basis_amount: null,
      })
    );
    expect(pos.accrued_yield_amount).toBe("0");
    expect(pos.principal_amount).toBe("100420000"); // = underlying_amount
    expect(pos.raw_state).toMatchObject({
      accrued_yield_sign: "unknown",
      cost_basis_amount: null,
    });
  });
});

// ── Phase 8.15.x: mergeEarnPositions (swapEarn/save 合成 + 二重計上ガード) ──

function rawPos(mint: string, protocolId = "jito"): Position {
  return {
    position_id: `raw_${mint}`,
    wallet_id: "w1",
    protocol_id: protocolId,
    asset_symbol: "X",
    principal_amount: "1",
    current_amount: "1",
    accrued_yield_amount: "0",
    unit_price_usd: "0",
    unit_price_sol: "0",
    deposited_at: "2026-01-01T00:00:00Z",
    maturity_at: null,
    unlock_at: null,
    health_factor: null,
    auto_roll_rule: null,
    risk_score: 0,
    raw_state: { mint },
  };
}

describe("mergeEarnPositions — Phase 8.15.x", () => {
  const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

  it("swapEarn / save 配列も合成される", () => {
    const merged = mergeEarnPositions([], {
      jupiterLend: [],
      kaminoBestEffort: [],
      swapEarn: [makeEarn({ protocol_id: "jito", share_mint: JITOSOL })],
      save: [makeEarn({ protocol_id: "savefi", share_mint: "CUSDC_MINT" })],
    });
    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.protocol_id)).toEqual(["jito", "savefi"]);
  });

  it("二重計上ガード: earn 行と同じ mint の raw 保有行は置換される", () => {
    const base = [rawPos(JITOSOL, "jito"), rawPos("OtherMint", "wallet_holding")];
    const merged = mergeEarnPositions(base, {
      jupiterLend: [],
      kaminoBestEffort: [],
      swapEarn: [makeEarn({ protocol_id: "jito", share_mint: JITOSOL })],
    });
    // raw jitoSOL 行は drop、OtherMint 行 + earn 行の 2 件
    expect(merged).toHaveLength(2);
    expect(
      merged.filter((p) => (p.raw_state as { mint?: string }).mint === JITOSOL)
    ).toHaveLength(0);
  });

  it("swapEarn/save undefined (旧 BFF) は従来挙動のまま", () => {
    const base = [rawPos(JITOSOL, "jito")];
    const merged = mergeEarnPositions(base, {
      jupiterLend: [makeEarn()],
      kaminoBestEffort: [],
    });
    expect(merged).toHaveLength(2); // raw + jl earn (jl share_mint は raw に無い)
  });
});
