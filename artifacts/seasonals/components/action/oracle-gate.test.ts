/**
 * Phase 8.14: oracle-gate 純粋ヘルパーの検証 (RN render 不要)。
 */
import type { AgentPlan } from "@workspace/lib/types";
import { findKaminoMarketByAsset } from "@workspace/lib/config/kamino-markets";
import { findSaveMarketByAsset } from "@workspace/lib/config/save-markets";
import {
  JUPITER_UNDERLYING_MINTS,
  oracleBlockLabel,
  resolveOracleMint,
} from "./oracle-gate";

const KAMINO_USDC_MINT = findKaminoMarketByAsset("USDC")!.underlying_mint;
const KAMINO_USDC_RESERVE = findKaminoMarketByAsset("USDC")!.reserve;
const KAMINO_SOL_MINT = findKaminoMarketByAsset("SOL")!.underlying_mint;

type Action = AgentPlan["selected_action"];

function action(partial: Partial<NonNullable<Action>>): Action {
  return {
    action_type: "deposit",
    protocol: "jupiter_lend",
    asset: "SOL",
    amount: "1000000000",
    ...partial,
  } as NonNullable<Action>;
}

describe("resolveOracleMint", () => {
  it("Jupiter Lend deposit (SOL) → SOL mint", () => {
    expect(resolveOracleMint(action({ asset: "SOL" }))).toBe(
      JUPITER_UNDERLYING_MINTS.SOL
    );
  });

  it("Jupiter Lend withdraw (USDC) → USDC mint", () => {
    expect(
      resolveOracleMint(action({ action_type: "withdraw", asset: "USDC" }))
    ).toBe(JUPITER_UNDERLYING_MINTS.USDC);
  });

  it("protocol 'jupiter' alias も解決する", () => {
    expect(resolveOracleMint(action({ protocol: "jupiter", asset: "USDT" }))).toBe(
      JUPITER_UNDERLYING_MINTS.USDT
    );
  });

  it("未対応 protocol は null (oracle gate 対象外)", () => {
    expect(
      resolveOracleMint(action({ protocol: "unknown_protocol", asset: "SOL" }))
    ).toBeNull();
  });

  it("Hylo (8.27、swap-earn 汎用 branch): SOL/USDC の underlying mint に解決", () => {
    expect(resolveOracleMint(action({ protocol: "hylo", asset: "SOL" }))).toBe(
      JUPITER_UNDERLYING_MINTS.SOL
    );
    expect(resolveOracleMint(action({ protocol: "hylo", asset: "USDC" }))).toBe(
      JUPITER_UNDERLYING_MINTS.USDC
    );
  });

  it("未知 asset は null", () => {
    expect(resolveOracleMint(action({ asset: "WIF" }))).toBeNull();
  });

  it("action undefined は null", () => {
    expect(resolveOracleMint(undefined)).toBeNull();
  });

  // ── Phase 8.15b: Kamino ──
  it("Kamino deposit (asset USDC) → USDC underlying mint", () => {
    expect(
      resolveOracleMint(action({ protocol: "kamino", asset: "USDC" }))
    ).toBe(KAMINO_USDC_MINT);
  });

  it("Kamino deposit を pool_id metadata で解決", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "kamino",
          asset: "WHATEVER",
          metadata: { pool_id: "kamino_sol_main" },
        } as never)
      )
    ).toBe(KAMINO_SOL_MINT);
  });

  it("Kamino withdraw (share_mint = reserve) → underlying mint", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "kamino",
          action_type: "withdraw",
          metadata: { share_mint: KAMINO_USDC_RESERVE },
        } as never)
      )
    ).toBe(KAMINO_USDC_MINT);
  });

  it("Kamino JLP (8.27 で reserve 登録) は JLP mint 解決 / 未知 asset は null", () => {
    expect(
      resolveOracleMint(action({ protocol: "kamino", asset: "JLP" }))
    ).toBe("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4");
    expect(
      resolveOracleMint(action({ protocol: "kamino", asset: "WIF" }))
    ).toBeNull();
  });

  // ── Phase 8.15d: Kamino kVault ──
  it("kVault deposit (pool_id) → vault underlying mint (reserve より優先)", () => {
    // kamino_steakhouse_usdc は vault registry のみに存在 → USDC mint
    expect(
      resolveOracleMint(
        action({
          protocol: "kamino",
          asset: "USDC",
          metadata: { pool_id: "kamino_steakhouse_usdc" },
        } as never)
      )
    ).toBe(KAMINO_USDC_MINT);
  });

  it("kVault withdraw (share_mint = vault address) → underlying mint", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "kamino",
          action_type: "withdraw",
          metadata: { share_mint: "A1so1bPD3W1TfeFwboDh8yfAAVaVtcdAYBYCjhg2mJQ" },
        } as never)
      )
    ).toBe(KAMINO_SOL_MINT);
  });

  // ── Phase 8.15c: Save ──
  it("Save deposit (asset USDC) → USDC underlying mint", () => {
    const save = findSaveMarketByAsset("USDC")!;
    expect(
      resolveOracleMint(action({ protocol: "savefi", asset: "USDC" }))
    ).toBe(save.underlying_mint);
  });

  it("Save withdraw (share_mint = cToken mint) → underlying mint", () => {
    const save = findSaveMarketByAsset("SOL")!;
    expect(
      resolveOracleMint(
        action({
          protocol: "savefi",
          action_type: "withdraw",
          metadata: { share_mint: save.ctoken_mint },
        } as never)
      )
    ).toBe(save.underlying_mint);
  });

  it("Save 未対応 pool (turbo_sol の未知 asset) は null", () => {
    expect(
      resolveOracleMint(action({ protocol: "savefi", asset: "TURBO" }))
    ).toBeNull();
  });

  // ── Phase 8.17: Meteora ──
  it("Meteora deposit (pool_id) → deposit token mint (USDC)", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "meteora",
          asset: "USDC",
          metadata: { pool_id: "meteora_sol_usdc_dlmm" },
        } as never)
      )
    ).toBe(KAMINO_USDC_MINT); // USDC mint は共通
  });

  it("Meteora withdraw (share_mint = position pubkey) は asset で解決", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "meteora",
          action_type: "withdraw",
          asset: "USDC",
          metadata: { share_mint: "SomePositionPubkey11111111111111111111111" },
        } as never)
      )
    ).toBe(KAMINO_USDC_MINT);
  });

  // ── Phase 8.18: Orca ──
  it("Orca deposit (pool_id) → deposit token mint (USDC)", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "orca",
          asset: "USDC",
          metadata: { pool_id: "orca_sol_usdc_whirlpool" },
        } as never)
      )
    ).toBe(KAMINO_USDC_MINT); // USDC mint は共通
  });

  it("Orca withdraw (share_mint = position mint) は asset で解決", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "orca",
          action_type: "withdraw",
          asset: "USDC",
          metadata: { share_mint: "SomePositionMint111111111111111111111111111" },
        } as never)
      )
    ).toBe(KAMINO_USDC_MINT);
  });

  it("Orca jitoSOL-SOL (8.21 で registry 入り) は SOL mint 解決", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "orca",
          asset: "SOL",
          metadata: { pool_id: "orca_jitosol_sol_whirlpool" },
        } as never)
      )
    ).toBe(KAMINO_SOL_MINT); // SOL mint は共通
  });

  it("Orca 未対応 pool (registry 外) + 未知 asset は null", () => {
    expect(
      resolveOracleMint(
        action({
          protocol: "orca",
          asset: "JLP",
          metadata: { pool_id: "orca_unknown_pool" },
        } as never)
      )
    ).toBeNull();
  });
});

describe("oracleBlockLabel", () => {
  it("各 block reason に専用ラベル", () => {
    expect(oracleBlockLabel("oracle_both_stale")).toMatch(/stale/i);
    expect(oracleBlockLabel("oracle_divergence_too_large")).toMatch(/>5%/);
    expect(oracleBlockLabel("oracle_unavailable")).toMatch(/取得できません/);
  });

  it("null / 未知は generic ラベル", () => {
    expect(oracleBlockLabel(null)).toBe("oracle check failed");
  });
});
