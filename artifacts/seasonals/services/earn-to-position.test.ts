/**
 * Phase 8.13: earn-to-position が BFF の実 accrued yield を Position に伝搬するか検証。
 *   - accrued_yield_amount は magnitude string をそのまま持つ
 *   - principal_amount は cost_basis 既知なら実元本、不明なら underlying_amount
 *   - 符号 / 既知性は raw_state (accrued_yield_sign / cost_basis_amount) に載る
 */

import type { EarnPosition } from "@workspace/lib/types";
import { earnPositionToPosition } from "./earn-to-position";

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
