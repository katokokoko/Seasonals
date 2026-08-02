/**
 * vault-rows — drill-down カード行の組み立て (Phase 8.54)。
 *
 * MenuDrawer は 2300 行あり render テストが重いので、**行に何が出るかの判断**を
 * ここで固定する。特に position ↔ pool の紐付けは protocol ごとに share_mint の
 * 意味が違う (§8.15) ため、registry が変わったら落ちるようにしておく。
 */
import { KAMINO_MARKETS, KAMINO_VAULTS } from "@workspace/lib/config/kamino-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import {
  PositionCategory,
  type EarnPosition,
  type ProtocolMenuEntry,
  type ProtocolPool,
} from "@workspace/lib/types";

import {
  applyVaultFilter,
  buildPoolVaultRows,
  computeVaultSummary,
  partitionPositions,
  poolIdForPosition,
  visibleFilters,
  type VaultRow,
} from "./vault-rows";

const KAMINO_USDC = KAMINO_MARKETS.find((m) => m.pool_id === "kamino_usdc_main")!;
const KAMINO_VAULT = KAMINO_VAULTS[0]!;
const SAVE_USDC = SAVE_MARKETS.find((m) => m.pool_id === "savefi_usdc_main")!;

function pool(over: Partial<ProtocolPool> & { pool_id: string }): ProtocolPool {
  return {
    name: over.pool_id,
    category: PositionCategory.Lending,
    asset: "USDC",
    apy: 0.05,
    tvl_usd: 1_000_000,
    ...over,
  };
}

function position(over: Partial<EarnPosition> & { share_mint: string }): EarnPosition {
  return {
    protocol_id: "kamino",
    protocol_name: "Kamino",
    market_symbol: "USDC",
    shares: "1000000",
    share_decimals: 6,
    asset_symbol: "USDC",
    underlying_amount: "100000000", // 100 USDC
    underlying_decimals: 6,
    underlying_usd: "100",
    supply_rate_bps: 500,
    accrued_yield_amount: "1000000", // 1 USDC
    accrued_yield_sign: "gain",
    ...over,
  } as EarnPosition;
}

function entryOf(pools: ProtocolPool[]): ProtocolMenuEntry {
  return {
    protocol_id: "kamino",
    display_name: "Kamino",
    primary_category: PositionCategory.Lending,
    supported_assets: ["USDC"],
    icon_id: "kamino",
    icon_bg: "#000",
    pools,
  };
}

describe("poolIdForPosition — share_mint の意味は protocol ごとに違う (§8.15)", () => {
  it("Kamino: share_mint = reserve address", () => {
    expect(poolIdForPosition(position({ share_mint: KAMINO_USDC.reserve }))).toBe(
      "kamino_usdc_main"
    );
  });

  it("Kamino kVault: share_mint = vault address", () => {
    expect(poolIdForPosition(position({ share_mint: KAMINO_VAULT.vault }))).toBe(
      KAMINO_VAULT.pool_id
    );
  });

  it("Save: share_mint = cToken mint", () => {
    expect(poolIdForPosition(position({ share_mint: SAVE_USDC.ctoken_mint }))).toBe(
      "savefi_usdc_main"
    );
  });

  it("registry に無い mint (Meteora/Orca の position pubkey 等) は undefined", () => {
    expect(poolIdForPosition(position({ share_mint: "NotARegisteredMint" }))).toBeUndefined();
  });
});

describe("partitionPositions", () => {
  it("registry で引けた position は行に統合される", () => {
    const pools = [pool({ pool_id: "kamino_usdc_main" }), pool({ pool_id: "kamino_sol_main" })];
    const { byPool, unlinked } = partitionPositions(pools, [
      position({ share_mint: KAMINO_USDC.reserve }),
    ]);
    expect(byPool.get("kamino_usdc_main")).toBeDefined();
    expect(unlinked).toHaveLength(0);
  });

  it("registry に pool_id が無い protocol は asset 一致で紐付ける (swap-earn)", () => {
    // jito 等: SwapEarnMarket は protocol_id + underlying_symbol で引く設計
    const pools = [pool({ pool_id: "jito_sol", asset: "SOL" })];
    const { byPool, unlinked } = partitionPositions(pools, [
      position({
        share_mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
        protocol_id: "jito",
        asset_symbol: "SOL",
      }),
    ]);
    expect(byPool.get("jito_sol")).toBeDefined();
    expect(unlinked).toHaveLength(0);
  });

  it("どの pool にも紐付かない position は捨てずに残す (Meteora/Orca の LP)", () => {
    const pools = [pool({ pool_id: "meteora_usdc_usdt_dlmm", asset: "USDC-USDT" })];
    const { byPool, unlinked } = partitionPositions(pools, [
      position({
        share_mint: "PositionPubkey1111",
        protocol_id: "meteora",
        asset_symbol: "USDC",
      }),
    ]);
    expect(byPool.size).toBe(0);
    expect(unlinked).toHaveLength(1);
  });

  it("同じ pool に 2 件は紐付けない (先勝ち、残りは leftover)", () => {
    const pools = [pool({ pool_id: "kamino_usdc_main" })];
    const { byPool, unlinked } = partitionPositions(pools, [
      position({ share_mint: KAMINO_USDC.reserve, underlying_amount: "1" }),
      position({ share_mint: KAMINO_USDC.reserve, underlying_amount: "2" }),
    ]);
    expect(byPool.size).toBe(1);
    expect(byPool.get("kamino_usdc_main")!.underlying_amount).toBe("1");
    expect(unlinked).toHaveLength(1);
  });
});

describe("buildPoolVaultRows", () => {
  const decimals = () => 6;

  it("menu の順序を保つ (保有状況で並べ替えない)", () => {
    const entry = entryOf([
      pool({ pool_id: "a" }),
      pool({ pool_id: "b" }),
      pool({ pool_id: "kamino_usdc_main" }),
    ]);
    const { rows } = buildPoolVaultRows(
      entry,
      [position({ share_mint: KAMINO_USDC.reserve })],
      decimals
    );
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "kamino_usdc_main"]);
    expect(rows[2]!.isDeposited).toBe(true);
    expect(rows[0]!.isDeposited).toBe(false);
  });

  it("保有行に amount / earned を載せる (表示用 Number 変換)", () => {
    const entry = entryOf([pool({ pool_id: "kamino_usdc_main" })]);
    const { rows } = buildPoolVaultRows(
      entry,
      [position({ share_mint: KAMINO_USDC.reserve })],
      decimals
    );
    expect(rows[0]!.userUnderlyingHuman).toBe(100);
    expect(rows[0]!.userUnderlyingUsd).toBe(100);
    expect(rows[0]!.userEarnedKnown).toBe(true);
    expect(rows[0]!.userEarnedUsd).toBeCloseTo(1, 6); // 1 USDC ≒ $1
  });

  it("cost-basis 不明 (sign=unknown) は earned を出さない (概算を捏造しない)", () => {
    const entry = entryOf([pool({ pool_id: "kamino_usdc_main" })]);
    const { rows } = buildPoolVaultRows(
      entry,
      [position({ share_mint: KAMINO_USDC.reserve, accrued_yield_sign: "unknown" })],
      decimals
    );
    expect(rows[0]!.userEarnedKnown).toBe(false);
    expect(rows[0]!.userEarnedUsd).toBe(0);
  });

  it("8.33/8.51: display_only と預入枠を行に持ち込む", () => {
    const entry = entryOf([
      pool({ pool_id: "pt", display_only: true }),
      pool({
        pool_id: "capped",
        deposit_cap: "1000000",
        deposit_used: "1000000",
        deposit_open: false,
      }),
    ]);
    const { rows } = buildPoolVaultRows(entry, [], decimals);
    expect(rows[0]!.displayOnly).toBe(true);
    expect(rows[1]!.capView?.closed).toBe(true);
    expect(rows[1]!.capView?.reason).toBe("full");
  });

  it("deposit dispatch 用に元の pool をそのまま持つ (§8.15d pool_id で reserve/kVault 判別)", () => {
    const entry = entryOf([pool({ pool_id: "kamino_steakhouse_usdc" })]);
    const { rows } = buildPoolVaultRows(entry, [], decimals);
    expect(rows[0]!.pool?.pool_id).toBe("kamino_steakhouse_usdc");
  });
});

describe("computeVaultSummary", () => {
  const row = (over: Partial<VaultRow>): VaultRow => ({
    key: "k",
    assetSymbol: "USDC",
    subtitle: "s",
    apyBps: 500,
    tvlUsd: 0,
    isDeposited: false,
    userUnderlyingHuman: 0,
    userUnderlyingUsd: 0,
    userEarnedUsd: 0,
    userEarnedKnown: false,
    displayOnly: false,
    capView: null,
    ...over,
  });

  it("保有 USD で加重平均 APY を出す", () => {
    const summary = computeVaultSummary([
      row({ key: "a", isDeposited: true, userUnderlyingUsd: 300, apyBps: 1000 }),
      row({ key: "b", isDeposited: true, userUnderlyingUsd: 100, apyBps: 200 }),
      row({ key: "c", apyBps: 9999 }), // 未保有は無視
    ]);
    expect(summary.depositedUsd).toBe(400);
    expect(summary.avgApyBps).toBe(800); // (300×10% + 100×2%) / 400 = 8%
  });

  it("earned が全件不明なら hasKnownEarnings=false (UI は — 表示)", () => {
    const summary = computeVaultSummary([
      row({ isDeposited: true, userUnderlyingUsd: 100, userEarnedKnown: false }),
    ]);
    expect(summary.hasKnownEarnings).toBe(false);
    expect(summary.earningsUsd).toBe(0);
  });

  it("保有ゼロなら avgApy は null", () => {
    expect(computeVaultSummary([row({})]).avgApyBps).toBeNull();
  });
});

describe("visibleFilters — 内容がある時だけチップを出す", () => {
  const r = (assetSymbol: string, isDeposited = false): VaultRow => ({
    key: assetSymbol,
    assetSymbol,
    subtitle: "",
    apyBps: 0,
    tvlUsd: 0,
    isDeposited,
    userUnderlyingHuman: 0,
    userUnderlyingUsd: 0,
    userEarnedUsd: 0,
    userEarnedKnown: false,
    displayOnly: false,
    capView: null,
  });

  it("単一 asset の protocol は all のみ (呼び手はチップ行を出さない)", () => {
    expect(visibleFilters([r("SOL")])).toEqual(["all"]);
  });

  it("全部 stable でも stable チップは出さない (選ぶ意味がない)", () => {
    expect(visibleFilters([r("USDC"), r("USDT")])).toEqual(["all"]);
  });

  it("stable と SOL が混在すれば両方出す", () => {
    expect(visibleFilters([r("USDC"), r("SOL")])).toEqual(["all", "stable", "sol"]);
  });

  it("保有があれば deposited を足す", () => {
    expect(visibleFilters([r("SOL", true)])).toEqual(["all", "deposited"]);
  });
});

describe("applyVaultFilter", () => {
  const rows: VaultRow[] = [
    { assetSymbol: "USDC", isDeposited: true },
    { assetSymbol: "SOL", isDeposited: false },
    { assetSymbol: "JLP", isDeposited: false },
  ].map((o, i) => ({
    key: `k${i}`,
    subtitle: "",
    apyBps: 0,
    tvlUsd: 0,
    userUnderlyingHuman: 0,
    userUnderlyingUsd: 0,
    userEarnedUsd: 0,
    userEarnedKnown: false,
    displayOnly: false,
    capView: null,
    ...o,
  }));

  it("stable / sol / deposited で絞る", () => {
    expect(applyVaultFilter(rows, "all")).toHaveLength(3);
    expect(applyVaultFilter(rows, "stable").map((r) => r.assetSymbol)).toEqual(["USDC"]);
    expect(applyVaultFilter(rows, "sol").map((r) => r.assetSymbol)).toEqual(["SOL"]);
    expect(applyVaultFilter(rows, "deposited").map((r) => r.assetSymbol)).toEqual(["USDC"]);
  });
});
