import { KAMINO_MARKETS } from "../config/kamino-markets";
import { PositionCategory, type EarnPosition, type EarnPositionsResponse, type ProtocolMenuEntry, type ProtocolPool } from "../types";
import { earnPositionsForProtocol, heldPoolKeys, partitionPositions } from "./earn-positions";

const KAMINO_USDC = KAMINO_MARKETS.find((m) => m.pool_id === "kamino_usdc_main")!;

const pool = (over: Partial<ProtocolPool> & { pool_id: string }): ProtocolPool => ({
  name: over.pool_id,
  category: PositionCategory.Lending,
  asset: "USDC",
  apy: 0.05,
  tvl_usd: 1_000_000,
  ...over,
});

const position = (over: Partial<EarnPosition> & { share_mint: string }): EarnPosition =>
  ({
    protocol_id: "kamino",
    protocol_name: "Kamino",
    market_symbol: "USDC",
    shares: "1000000",
    share_decimals: 6,
    asset_symbol: "USDC",
    underlying_amount: "100000000",
    underlying_decimals: 6,
    underlying_usd: "100",
    supply_rate_bps: 500,
    accrued_yield_amount: "0",
    accrued_yield_sign: "unknown",
    cost_basis_amount: null,
    ...over,
  }) as EarnPosition;

const entry = (protocol_id: string, pools: ProtocolPool[]): ProtocolMenuEntry =>
  ({ protocol_id, display_name: protocol_id, primary_category: PositionCategory.Lending, supported_assets: [], icon_id: protocol_id, icon_bg: "", pools }) as ProtocolMenuEntry;

test("registry match wins; unknown positions stay unlinked (moved from mobile, same behavior)", () => {
  const p = position({ share_mint: KAMINO_USDC.reserve });
  const lp = position({ share_mint: "LPmint", asset_symbol: "XYZ" });
  const { byPool, unlinked } = partitionPositions([pool({ pool_id: KAMINO_USDC.pool_id })], [p, lp]);
  expect(byPool.get(KAMINO_USDC.pool_id)).toBe(p);
  expect(unlinked).toEqual([lp]);
});

test("swap-earn positions are filtered by protocol and matched by asset", () => {
  const earn: EarnPositionsResponse = {
    jupiterLend: [],
    kaminoBestEffort: [],
    swapEarn: [position({ protocol_id: "jito", share_mint: "J1", asset_symbol: "SOL" }), position({ protocol_id: "marinade", share_mint: "M1", asset_symbol: "SOL" })],
  };
  expect(earnPositionsForProtocol("jito", earn).map((p) => p.share_mint)).toEqual(["J1"]);
  const held = heldPoolKeys([entry("jito", [pool({ pool_id: "jitosol", asset: "SOL" })])], [earn]);
  expect([...held.keys()]).toEqual(["jito:jitosol"]);
});

test("holdings from several wallets are collected per pool", () => {
  const e1: EarnPositionsResponse = { jupiterLend: [], kaminoBestEffort: [position({ share_mint: KAMINO_USDC.reserve })] };
  const e2: EarnPositionsResponse = { jupiterLend: [], kaminoBestEffort: [position({ share_mint: KAMINO_USDC.reserve, shares: "5" })] };
  const held = heldPoolKeys([entry("kamino", [pool({ pool_id: KAMINO_USDC.pool_id })])], [e1, e2]);
  expect(held.get(`kamino:${KAMINO_USDC.pool_id}`)).toHaveLength(2);
});
