/**
 * solana-action — Seeker ActionModal の dispatch cascade と同じ route に解決すること (§29.1 / §32.2)。
 * registry は実データ (lib/config) をそのまま使う。
 */
import type { EarnPosition } from "../types";
import { SWAP_EARN_MARKETS } from "../config/swap-earn-markets";
import { KAMINO_MARKETS, KAMINO_VAULTS } from "../config/kamino-markets";
import { SAVE_MARKETS } from "../config/save-markets";
import { EXPONENT_MARKETS } from "../config/exponent-markets";
import { METEORA_MARKETS } from "../config/meteora-markets";
import { ORCA_MARKETS } from "../config/orca-markets";
import {
  canWithdrawEarnPosition,
  depositAction,
  resolveSolanaRoute,
  withdrawActionFromParams,
  withdrawActionFromPosition,
} from "./solana-action";

const jlUsdc = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC")!;
const kReserve = KAMINO_MARKETS[0]!;
const kVault = KAMINO_VAULTS[0]!;
const save = SAVE_MARKETS[0]!;
const pt = EXPONENT_MARKETS[0]!;
const met = METEORA_MARKETS[0]!;
const orca = ORCA_MARKETS[0]!;

function withdraw(protocol: string, shareMint: string) {
  return { action_type: "withdraw", protocol, asset: "X", amount: "1", metadata: { share_mint: shareMint } };
}

describe("resolveSolanaRoute — deposit", () => {
  it("Menu の protocol_id 'jupiter' は jupiter_lend の swap-earn に正規化する", () => {
    expect(resolveSolanaRoute(depositAction("jupiter", "USDC", "jupiter_usdc"))).toEqual({ kind: "swap_earn_deposit", shareMint: jlUsdc.share_mint });
  });
  it("Kamino: pool_id の reserve、無ければ asset", () => {
    expect(resolveSolanaRoute(depositAction("kamino", kReserve.underlying_symbol, kReserve.pool_id))).toEqual({ kind: "kamino_deposit", reserve: kReserve.reserve });
    expect(resolveSolanaRoute(depositAction("kamino", kReserve.underlying_symbol, undefined))?.kind).toBe("kamino_deposit");
  });
  it("Kamino: kVault は pool_id でのみ解決し、reserve より優先する", () => {
    expect(resolveSolanaRoute(depositAction("kamino", kVault.underlying_symbol, kVault.pool_id))).toEqual({ kind: "kamino_vault_deposit", vault: kVault.vault });
  });
  it("Save / Meteora / Orca は pool_id から", () => {
    expect(resolveSolanaRoute(depositAction("savefi", save.underlying_symbol, save.pool_id))).toEqual({ kind: "save_deposit", reserve: save.reserve });
    expect(resolveSolanaRoute(depositAction("meteora", met.deposit_symbol, met.pool_id))).toEqual({ kind: "meteora_deposit", poolKey: met.pool_id });
    expect(resolveSolanaRoute(depositAction("orca", orca.deposit_symbol, orca.pool_id))).toEqual({ kind: "orca_deposit", poolKey: orca.pool_id });
  });
  it("Meteora / Orca は pool_id 無しなら解決しない (LP は pool 特定が必須)", () => {
    expect(resolveSolanaRoute(depositAction("meteora", met.deposit_symbol, undefined))).toBeNull();
    expect(resolveSolanaRoute(depositAction("orca", orca.deposit_symbol, undefined))).toBeNull();
  });
  it("Exponent PT の deposit (売買) は経路が無く null = fail-closed", () => {
    expect(resolveSolanaRoute(depositAction("exponent", pt.underlying_symbol, "exponent_pt_x"))).toBeNull();
  });
});

describe("resolveSolanaRoute — withdraw", () => {
  it("share_mint を swap-earn → Kamino reserve → kVault → Save → Exponent の順で引く", () => {
    expect(resolveSolanaRoute(withdraw("jupiter_lend", jlUsdc.share_mint))).toEqual({ kind: "swap_earn_withdraw", shareMint: jlUsdc.share_mint });
    expect(resolveSolanaRoute(withdraw("kamino", kReserve.reserve))).toEqual({ kind: "kamino_withdraw", reserve: kReserve.reserve });
    expect(resolveSolanaRoute(withdraw("kamino", kVault.vault))).toEqual({ kind: "kamino_vault_withdraw", vault: kVault.vault });
    expect(resolveSolanaRoute(withdraw("savefi", save.ctoken_mint))).toEqual({ kind: "save_withdraw", ctokenMint: save.ctoken_mint });
    expect(resolveSolanaRoute(withdraw("exponent", pt.pt_mint))).toEqual({ kind: "exponent_redeem", ptMint: pt.pt_mint });
  });
  it("Meteora / Orca は position pubkey (registry 外) を protocol で判定する", () => {
    expect(resolveSolanaRoute(withdraw("meteora", "PosA1111111111111111111111111111111111111111"))).toEqual({
      kind: "meteora_withdraw",
      position: "PosA1111111111111111111111111111111111111111",
    });
    expect(resolveSolanaRoute(withdraw("orca", "PosB1111111111111111111111111111111111111111"))?.kind).toBe("orca_withdraw");
  });
  it("どれにも当たらない share_mint / action_type は null", () => {
    expect(resolveSolanaRoute(withdraw("kamino", "Unknown11111111111111111111111111111111111"))).toBeNull();
    expect(resolveSolanaRoute({ action_type: "rotate", protocol: "kamino", metadata: {} })).toBeNull();
    expect(resolveSolanaRoute(null)).toBeNull();
  });
});

function position(over: Partial<EarnPosition>): EarnPosition {
  return {
    protocol_id: "jupiter_lend",
    protocol_name: "Jupiter Lend",
    market_symbol: "USDC",
    share_mint: jlUsdc.share_mint,
    shares: "1000000",
    share_decimals: 6,
    asset_symbol: "USDC",
    underlying_amount: "1010000",
    underlying_decimals: 6,
    underlying_usd: "1.01000000",
    supply_rate_bps: 500,
    accrued_yield_amount: "10000",
    accrued_yield_sign: "gain",
    cost_basis_amount: "1000000",
    ...over,
  };
}

describe("canWithdrawEarnPosition (Seeker MenuDrawer canWithdrawPosition)", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  it("route のある position だけ", () => {
    expect(canWithdrawEarnPosition(position({}), now)).toBe(true);
    expect(canWithdrawEarnPosition(position({ protocol_id: "kamino", share_mint: "Unknown11111111111111111111111111111111111" }), now)).toBe(false);
    expect(canWithdrawEarnPosition(position({ protocol_id: "orca", share_mint: "PosB1111111111111111111111111111111111111111" }), now)).toBe(true);
  });
  it("Exponent PT は満期後だけ", () => {
    const p = position({ protocol_id: "exponent", share_mint: pt.pt_mint });
    expect(canWithdrawEarnPosition({ ...p, maturity_at: "2026-12-01T00:00:00Z" }, now)).toBe(false);
    expect(canWithdrawEarnPosition({ ...p, maturity_at: "2026-09-01T00:00:00Z" }, now)).toBe(true);
    expect(canWithdrawEarnPosition({ ...p, maturity_at: null }, now)).toBe(false);
  });
});

describe("action builders", () => {
  it("withdrawActionFromPosition は全量 shares と decimals を metadata に載せる", () => {
    expect(withdrawActionFromPosition(position({}))).toEqual({
      action_type: "withdraw",
      protocol: "jupiter_lend",
      asset: "USDC",
      amount: "1000000",
      metadata: { share_mint: jlUsdc.share_mint, share_decimals: 6, underlying_decimals: 6, underlying_amount: "1010000" },
    });
  });
  it("withdrawActionFromParams は Seeker syntheticPlanFromEventAction と同じ項目が揃った時だけ組む", () => {
    const params = {
      protocol_id: "orca",
      asset_symbol: "USDC",
      shares: "1",
      share_mint: "PosB1111111111111111111111111111111111111111",
      share_decimals: "0",
      underlying_decimals: "6",
      underlying_amount: "2500000",
    };
    expect(withdrawActionFromParams(params)).toEqual({
      action_type: "withdraw",
      protocol: "orca",
      asset: "USDC",
      amount: "1",
      metadata: { share_mint: params.share_mint, share_decimals: 0, underlying_decimals: 6, underlying_amount: "2500000" },
    });
    const { share_mint: _omit, ...missing } = params;
    expect(withdrawActionFromParams(missing)).toBeNull();
    expect(withdrawActionFromParams({ ...params, shares: "1.5" })).toBeNull();
    expect(withdrawActionFromParams({ ...params, share_decimals: "x" })).toBeNull();
  });
  it("depositAction は pool_id を metadata に入れる (無ければ metadata 無し)", () => {
    expect(depositAction("kamino", "USDC", "kamino_usdc")).toEqual({ action_type: "deposit", protocol: "kamino", asset: "USDC", amount: "", metadata: { pool_id: "kamino_usdc" } });
    expect(depositAction("kamino", "USDC", undefined).metadata).toBeUndefined();
  });
});
