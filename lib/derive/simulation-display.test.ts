/**
 * simulate 結果の表示文言 (Seeker の承認画面と web の inbox が共有)。
 */
import type { SimulationResult } from "../types";
import {
  describeSimulationFailure,
  describeSimulationFee,
  describeSimulationOut,
  describeSimulationWarning,
} from "./simulation-display";
import { UNSUPPORTED_MARKET_MESSAGE } from "./solana-action";

const USDC = { decimals: 6, unitSymbol: "USDC" };
const base: SimulationResult = { simulation_id: "sim_1", bundle_hash: "0xabc" };

describe("describeSimulationOut", () => {
  it("旧形式 (estimate_kind 無し) は入力 asset の単位で従来どおり", () => {
    expect(describeSimulationOut({ ...base, estimated_out: "1672450000", estimated_fee: "120000" }, USDC)).toBe("1672.45 USDC");
    expect(describeSimulationOut(base, USDC)).toBeNull();
  });

  it("quote は受け取り token の単位で ≈ を付ける (入力 asset ではない)", () => {
    const sim: SimulationResult = {
      ...base,
      estimate_kind: "quote",
      estimated_out: "940000",
      estimated_out_symbol: "jlUSDC",
      estimated_out_decimals: 6,
      min_out: "935300",
    };
    expect(describeSimulationOut(sim, USDC)).toBe("≈ 0.94 jlUSDC");
  });

  it("exchange_rate は ≈、same_as_input は ≈ を付けない", () => {
    expect(
      describeSimulationOut(
        { ...base, estimate_kind: "exchange_rate", estimated_out: "95000000", estimated_out_symbol: "cSOL", estimated_out_decimals: 9 },
        USDC
      )
    ).toBe("≈ 0.095 cSOL");
    expect(
      describeSimulationOut(
        { ...base, estimate_kind: "same_as_input", estimated_out: "1000000", estimated_out_symbol: "USDC", estimated_out_decimals: 6 },
        USDC
      )
    ).toBe("1 USDC");
  });

  it("単一の受け取り量が無い kind は説明文", () => {
    expect(describeSimulationOut({ ...base, estimate_kind: "lp_position" }, USDC)).toBe("LP position (no single output)");
    expect(describeSimulationOut({ ...base, estimate_kind: "pt_redeem" }, USDC)).toBe("PT redeems for underlying at maturity");
  });

  it("見積り不能は理由の文 (0 を出さない)", () => {
    expect(describeSimulationOut({ ...base, estimate_kind: "none", failure_reason: "unsupported_market" }, USDC)).toBe(
      UNSUPPORTED_MARKET_MESSAGE
    );
    expect(describeSimulationOut({ ...base, estimate_kind: "quote", failure_reason: "quote_unavailable" }, USDC)).toBe(
      "Quote unavailable"
    );
    expect(describeSimulationOut({ ...base, estimate_kind: "none" }, USDC)).toBe("No estimate");
  });

  it("不正な金額でも落ちずに元の文字列を出す", () => {
    expect(describeSimulationOut({ ...base, estimated_out: "1.5" }, USDC)).toBe("1.5 USDC");
  });
});

describe("describeSimulationFee", () => {
  it("旧形式は入力 asset の単位、新形式は SOL、無ければ null", () => {
    expect(describeSimulationFee({ ...base, estimated_out: "1", estimated_fee: "120000" }, USDC)).toBe("0.12 USDC");
    expect(describeSimulationFee({ ...base, estimate_kind: "quote", estimated_fee: "5000" }, USDC)).toBe("0.000005 SOL");
    expect(describeSimulationFee({ ...base, estimate_kind: "quote", estimated_out: "1" }, USDC)).toBeNull();
  });
});

describe("理由と注意の文", () => {
  it("既知の値は文に、未知の値はそのまま", () => {
    expect(describeSimulationFailure("asset_mismatch")).toBe("Pool does not match asset");
    expect(describeSimulationFailure("something_new")).toBe("something_new");
    expect(describeSimulationWarning("fair_value_unavailable")).toBe("Couldn't verify the redemption value");
    expect(describeSimulationWarning("deposit_unavailable")).toBe("Deposits are paused for this market");
    expect(describeSimulationWarning("x")).toBe("x");
  });
});
