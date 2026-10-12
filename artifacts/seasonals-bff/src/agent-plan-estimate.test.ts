/**
 * agent-plan-estimate — route ごとの simulate 見積り (2026-10-08、spec §11.7 / §24.9)。
 * 上流 (Jupiter / LST NAV / Kamino / Save) はすべて mock。throw せず failure_reason に落とすことも確かめる。
 */
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import { KAMINO_MARKETS, KAMINO_VAULTS } from "@workspace/lib/config/kamino-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import { EXPONENT_MARKETS } from "@workspace/lib/config/exponent-markets";
import { METEORA_MARKETS } from "@workspace/lib/config/meteora-markets";
import { ORCA_MARKETS } from "@workspace/lib/config/orca-markets";

import { estimatePlanAction } from "./agent-plan-estimate";
import { fetchSwapQuote } from "./clients/jupiter-swap";
import { fetchLstSolValues } from "./clients/lst-rates";
import { fetchKaminoVaultMetrics } from "./clients/kamino-tx";
import { fetchSaveReserveRates } from "./clients/save-tx";
import { fetchEarnMarkets } from "./clients/jupiter-lend";
import { getOracleResults } from "./clients/oracle";
import type { OracleResult } from "@workspace/lib/types";

jest.mock("./clients/jupiter-swap", () => ({ fetchSwapQuote: jest.fn() }));
jest.mock("./clients/lst-rates", () => ({ fetchLstSolValues: jest.fn() }));
jest.mock("./clients/kamino-tx", () => ({ fetchKaminoVaultMetrics: jest.fn() }));
jest.mock("./clients/save-tx", () => ({ fetchSaveReserveRates: jest.fn() }));
// 2026-10-13: funding deposit の cross-asset チェック (convertToAssets と oracle 価格)
jest.mock("./clients/jupiter-lend", () => ({ fetchEarnMarkets: jest.fn() }));
jest.mock("./clients/oracle", () => ({ getOracleResults: jest.fn() }));

const mockQuote = fetchSwapQuote as jest.MockedFunction<typeof fetchSwapQuote>;
const mockLst = fetchLstSolValues as jest.MockedFunction<typeof fetchLstSolValues>;
const mockVault = fetchKaminoVaultMetrics as jest.MockedFunction<typeof fetchKaminoVaultMetrics>;
const mockSave = fetchSaveReserveRates as jest.MockedFunction<typeof fetchSaveReserveRates>;

const jlUsdc = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlUSDC")!;
const jito = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jitoSOL")!;
const kSol = KAMINO_MARKETS.find((m) => m.underlying_symbol === "SOL")!;
const kUsdc = KAMINO_MARKETS.find((m) => m.deposit_blocked_reason !== undefined)!;
const steak = KAMINO_VAULTS.find((v) => v.underlying_symbol === "USDC")!;
const saveUsdc = SAVE_MARKETS.find((m) => m.underlying_symbol === "USDC")!;

/** 実測相当 (2026-08-03) の jitoSOL NAV */
const JITOSOL_LAMPORTS = 1_293_886_836n;

function quote(inAmount: string, outAmount: string, threshold = outAmount) {
  return {
    inputMint: "in",
    outputMint: "out",
    inAmount,
    outAmount,
    otherAmountThreshold: threshold,
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "0.0012",
    routePlan: [],
  };
}

let log: { warn: jest.Mock };
beforeEach(() => {
  jest.clearAllMocks();
  log = { warn: jest.fn() };
  mockLst.mockResolvedValue(new Map([["jitoSOL", JITOSOL_LAMPORTS]]));
});

const mockMarkets = fetchEarnMarkets as jest.MockedFunction<typeof fetchEarnMarkets>;
const mockOracles = getOracleResults as jest.MockedFunction<typeof getOracleResults>;
const jlJupUsd = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlJupUSD")!;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function usdOracle(symbol: string, price: string | null = "1.00000000"): OracleResult {
  return {
    asset_symbol: symbol,
    status: price ? "ok" : "blocked",
    primary: price ? "pyth" : null,
    price_usd: price,
    pyth: { available: !!price, price_usd: price, age_seconds: 1 },
    secondary: { source: "redstone", available: !!price, price_usd: price, age_seconds: 1 },
    tier: "A",
    divergence_pct: price ? 0 : null,
    warnings: [],
    block_reason: price ? null : "oracle_both_stale",
  };
}

describe("2026-10-13: funding deposit (USDC → jlJupUSD)", () => {
  const route = { kind: "swap_earn_deposit" as const, shareMint: jlJupUsd.share_mint, inputMint: USDC_MINT };
  const oracleByMint = (usdc: string | null = "1.00000000") =>
    Promise.resolve(
      new Map([
        [jlJupUsd.underlying_mint, usdOracle("JupUSD")],
        [USDC_MINT, usdOracle("USDC", usdc)],
      ])
    );
  beforeEach(() => {
    mockMarkets.mockResolvedValue([
      {
        jlMint: jlJupUsd.share_mint,
        jlSymbol: "jlJupUSD",
        jlDecimals: 6,
        underlyingMint: jlJupUsd.underlying_mint,
        underlyingSymbol: "jupUSD",
        underlyingDecimals: 6,
        underlyingPriceUsd: 1,
        convertToAssets: "1041200",
        supplyRateBps: 430,
        rewardsRateBps: 0,
        totalRateBps: 430,
        tvlUnderlying: "0",
      },
    ]);
  });

  it("quote は funding (USDC) から。out は share 建て (≈ N jlJupUSD)、cross-asset は ok", async () => {
    mockQuote.mockResolvedValue(quote("1000000", "960781", "955977"));
    const est = await estimatePlanAction(route, "1000000", log, { oracleByMint: oracleByMint() });
    expect(mockQuote).toHaveBeenCalledWith({
      inputMint: USDC_MINT,
      outputMint: jlJupUsd.share_mint,
      amount: "1000000",
      slippageBps: 50,
    });
    expect(est).toMatchObject({
      estimate_kind: "quote",
      estimated_out: "960781",
      estimated_out_mint: jlJupUsd.share_mint,
      estimated_out_symbol: "jlJupUSD",
      estimated_out_decimals: 6,
      min_out: "955977",
      metadata: {
        input_mint: USDC_MINT,
        input_symbol: "USDC",
        fair_value: { status: "ok", deviation_bps: -3 },
      },
    });
    expect(est.warnings).toBeUndefined();
    // simulate が渡した oracle 結果を使う (再取得しない)。LST の参照も読まない
    expect(mockOracles).not.toHaveBeenCalled();
    expect(mockLst).not.toHaveBeenCalled();
  });

  it("不利な quote は止めずに warning (fair_value_deviation)", async () => {
    mockQuote.mockResolvedValue(quote("1000000", "930000"));
    const est = await estimatePlanAction(route, "1000000", log, { oracleByMint: oracleByMint() });
    expect(est.estimate_kind).toBe("quote");
    expect(est.warnings).toEqual(["fair_value_deviation"]);
  });

  it("USDC の価格が無ければ fair_value_unavailable (warning)", async () => {
    mockQuote.mockResolvedValue(quote("1000000", "960781"));
    const est = await estimatePlanAction(route, "1000000", log, { oracleByMint: oracleByMint(null) });
    expect(est.warnings).toEqual(["fair_value_unavailable"]);
    expect(log.warn).toHaveBeenCalled();
  });

  it("oracle 結果を渡されなければ自前で [underlying, funding] を引く", async () => {
    mockQuote.mockResolvedValue(quote("1000000", "960781"));
    mockOracles.mockImplementation(() => oracleByMint());
    const est = await estimatePlanAction(route, "1000000", log);
    expect(mockOracles).toHaveBeenCalledWith([jlJupUsd.underlying_mint, USDC_MINT]);
    expect(est.metadata?.fair_value).toEqual({ status: "ok", deviation_bps: -3 });
  });

  it("#49 review: 交換レート (earn/tokens) は quote の完了を待たずに取りに行く (並行)", async () => {
    let resolveQuote: ((q: ReturnType<typeof quote>) => void) | undefined;
    mockQuote.mockImplementation(
      () => new Promise((resolve) => { resolveQuote = resolve; }) as ReturnType<typeof fetchSwapQuote>
    );
    const estP = estimatePlanAction(route, "1000000", log, { oracleByMint: oracleByMint() });
    for (let i = 0; i < 20 && !resolveQuote; i++) await new Promise((r) => setImmediate(r));
    // quote はまだ pending — それでも markets は既に取りに行っている
    expect(resolveQuote).toBeDefined();
    expect(mockMarkets).toHaveBeenCalledTimes(1);
    resolveQuote!(quote("1000000", "960781"));
    const est = await estP;
    expect(est.metadata?.fair_value).toEqual({ status: "ok", deviation_bps: -3 });
    expect(mockMarkets).toHaveBeenCalledTimes(1);
  });

  it("#49 review: 先行取得した markets が落ちても fail-closed (quote が後から返る)", async () => {
    mockMarkets.mockRejectedValue(new Error("lite-api down"));
    mockQuote.mockResolvedValue(quote("1000000", "960781"));
    const est = await estimatePlanAction(route, "1000000", log, { oracleByMint: oracleByMint() });
    expect(est.warnings).toEqual(["fair_value_unavailable"]);
  });

  it("allowlist 外の inputMint は unsupported_market (quote を呼ばない)", async () => {
    const est = await estimatePlanAction(
      { ...route, inputMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
      "1000000",
      log
    );
    expect(est).toEqual({ estimate_kind: "none", failure_reason: "unsupported_market" });
    expect(mockQuote).not.toHaveBeenCalled();
  });
});

describe("swap-earn (Jupiter quote)", () => {
  it("deposit: underlying → share の quote。out / min_out は share 建て、slippage 50、fee は出さない", async () => {
    mockQuote.mockResolvedValue(quote("1000000", "948000", "943260"));
    const est = await estimatePlanAction({ kind: "swap_earn_deposit", shareMint: jlUsdc.share_mint }, "1000000", log);
    expect(mockQuote).toHaveBeenCalledWith({
      inputMint: jlUsdc.underlying_mint,
      outputMint: jlUsdc.share_mint,
      amount: "1000000",
      slippageBps: 50,
    });
    expect(est).toEqual({
      estimate_kind: "quote",
      estimated_out: "948000",
      estimated_out_mint: jlUsdc.share_mint,
      estimated_out_symbol: "jlUSDC",
      estimated_out_decimals: 6,
      min_out: "943260",
      slippage_bps: 50,
      metadata: { price_impact_pct: "0.0012" },
    });
    // jlUSDC は償還価値の参照を持たない → LST レートを取りに行かない
    expect(mockLst).not.toHaveBeenCalled();
  });

  it("withdraw: share → underlying の quote。out は underlying 建て、LST は fair value ok を metadata に", async () => {
    // 1 jitoSOL → fair ≈ 1.2939 SOL。1.2926 SOL は -10bps (平常の流動性プレミアム)
    mockQuote.mockResolvedValue(quote("1000000000", "1292600000"));
    const est = await estimatePlanAction({ kind: "swap_earn_withdraw", shareMint: jito.share_mint }, "1000000000", log);
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({ inputMint: jito.share_mint, outputMint: jito.underlying_mint })
    );
    expect(est).toMatchObject({
      estimate_kind: "quote",
      estimated_out: "1292600000",
      estimated_out_mint: jito.underlying_mint,
      estimated_out_symbol: "SOL",
      estimated_out_decimals: 9,
      metadata: { fair_value: { status: "ok" } },
    });
    expect(est.warnings).toBeUndefined();
  });

  it("fair value の不利方向の乖離は止めずに warning (fair_value_deviation)", async () => {
    // 0.1 SOL → fair ≈ 77,286,510 jitoSOL に対し 70,000,000 (≈ 942bps 不利)
    mockQuote.mockResolvedValue(quote("100000000", "70000000"));
    const est = await estimatePlanAction({ kind: "swap_earn_deposit", shareMint: jito.share_mint }, "100000000", log);
    expect(est.estimate_kind).toBe("quote");
    expect(est.estimated_out).toBe("70000000");
    expect(est.warnings).toEqual(["fair_value_deviation"]);
    expect(est.metadata?.fair_value).toMatchObject({ status: "blocked", reason: "fair_value_deviation" });
  });

  it("参照レートが取れなければ fair_value_unavailable (検証できなかった、と伝える)", async () => {
    mockQuote.mockResolvedValue(quote("100000000", "77000000"));
    mockLst.mockRejectedValue(new Error("stake pool RPC down"));
    const est = await estimatePlanAction({ kind: "swap_earn_deposit", shareMint: jito.share_mint }, "100000000", log);
    expect(est.warnings).toEqual(["fair_value_unavailable"]);
    expect(log.warn).toHaveBeenCalled();
  });

  it("quote 失敗 / 壊れた quote は quote_unavailable (throw しない)", async () => {
    mockQuote.mockRejectedValue(new Error("Jupiter swap quote HTTP 429"));
    await expect(
      estimatePlanAction({ kind: "swap_earn_deposit", shareMint: jlUsdc.share_mint }, "1000000", log)
    ).resolves.toEqual({ estimate_kind: "none", failure_reason: "quote_unavailable" });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: "Jupiter swap quote HTTP 429", route: "swap_earn_deposit" }),
      expect.any(String)
    );

    mockQuote.mockResolvedValue(quote("1000000", "1.5"));
    expect(
      (await estimatePlanAction({ kind: "swap_earn_deposit", shareMint: jlUsdc.share_mint }, "1000000", log)).failure_reason
    ).toBe("quote_unavailable");
  });
});

describe("Kamino reserve (same_as_input)", () => {
  it("deposit / withdraw とも out = 入力量、underlying 建て", async () => {
    expect(await estimatePlanAction({ kind: "kamino_deposit", reserve: kSol.reserve }, "2500000000", log)).toEqual({
      estimate_kind: "same_as_input",
      estimated_out: "2500000000",
      estimated_out_mint: kSol.underlying_mint,
      estimated_out_symbol: "SOL",
      estimated_out_decimals: 9,
    });
    expect(
      (await estimatePlanAction({ kind: "kamino_withdraw", reserve: kUsdc.reserve }, "1000000", log)).warnings
    ).toBeUndefined(); // 預入停止は withdraw に影響しない
  });
  it("registry の deposit_blocked_reason は deposit_unavailable の warning (上流は叩かない)", async () => {
    const est = await estimatePlanAction({ kind: "kamino_deposit", reserve: kUsdc.reserve }, "1000000", log);
    expect(est.warnings).toEqual(["deposit_unavailable"]);
    expect(est.metadata).toEqual({ deposit_blocked_reason: kUsdc.deposit_blocked_reason });
  });
});

describe("Kamino kVault (exchange_rate)", () => {
  it("deposit: underlying → shares (`${display_name} shares`、mint なし)。withdraw: shares → underlying", async () => {
    mockVault.mockResolvedValue({ apy: "0.05", tokensPerShare: "1.0625", tokenPrice: "1" });
    expect(await estimatePlanAction({ kind: "kamino_vault_deposit", vault: steak.vault }, "10625000", log)).toEqual({
      estimate_kind: "exchange_rate",
      estimated_out: "10000000",
      estimated_out_symbol: "Steakhouse USDC shares",
      estimated_out_decimals: steak.shares_decimals,
      metadata: { tokens_per_share: "1.0625" },
    });
    expect(mockVault).toHaveBeenCalledWith(steak.vault);
    expect(await estimatePlanAction({ kind: "kamino_vault_withdraw", vault: steak.vault }, "10000000", log)).toMatchObject({
      estimate_kind: "exchange_rate",
      estimated_out: "10625000",
      estimated_out_mint: steak.underlying_mint,
      estimated_out_symbol: "USDC",
      estimated_out_decimals: 6,
    });
  });
  it("metrics 取得失敗 / tokensPerShare 0 は rate_unavailable", async () => {
    mockVault.mockRejectedValue(new Error("Kamino API 503"));
    expect(await estimatePlanAction({ kind: "kamino_vault_deposit", vault: steak.vault }, "1000000", log)).toEqual({
      estimate_kind: "none",
      failure_reason: "rate_unavailable",
    });
    mockVault.mockResolvedValue({ apy: "0", tokensPerShare: "0", tokenPrice: "0" });
    expect(
      (await estimatePlanAction({ kind: "kamino_vault_withdraw", vault: steak.vault }, "1000000", log)).failure_reason
    ).toBe("rate_unavailable");
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("Save (exchange_rate)", () => {
  it("deposit: underlying → cToken (cUSDC)。withdraw: cToken → underlying", async () => {
    mockSave.mockResolvedValue([{ reserve: saveUsdc.reserve, supply_apy: 0.02, ctoken_exchange_rate: "1.05" }]);
    expect(await estimatePlanAction({ kind: "save_deposit", reserve: saveUsdc.reserve }, "1050000", log)).toEqual({
      estimate_kind: "exchange_rate",
      estimated_out: "1000000",
      estimated_out_mint: saveUsdc.ctoken_mint,
      estimated_out_symbol: "cUSDC",
      estimated_out_decimals: 6,
      metadata: { ctoken_exchange_rate: "1.05" },
    });
    expect(mockSave).toHaveBeenCalledWith([saveUsdc.reserve]);
    expect(
      await estimatePlanAction({ kind: "save_withdraw", ctokenMint: saveUsdc.ctoken_mint }, "1000000", log)
    ).toMatchObject({ estimated_out: "1050000", estimated_out_symbol: "USDC", estimated_out_mint: saveUsdc.underlying_mint });
  });
  it("取得失敗 / 応答に reserve が無い時は rate_unavailable", async () => {
    mockSave.mockRejectedValue(new Error("Save reserves HTTP 500"));
    expect(
      (await estimatePlanAction({ kind: "save_deposit", reserve: saveUsdc.reserve }, "1000000", log)).failure_reason
    ).toBe("rate_unavailable");
    mockSave.mockResolvedValue([]);
    expect(
      (await estimatePlanAction({ kind: "save_withdraw", ctokenMint: saveUsdc.ctoken_mint }, "1000000", log)).failure_reason
    ).toBe("rate_unavailable");
  });
});

describe("数値を出さない route", () => {
  it("Meteora / Orca は lp_position、Exponent PT redeem は pt_redeem (上流は叩かない)", async () => {
    expect(await estimatePlanAction({ kind: "meteora_deposit", poolKey: METEORA_MARKETS[0]!.pool_id }, "1000000", log)).toEqual({
      estimate_kind: "lp_position",
    });
    expect((await estimatePlanAction({ kind: "orca_withdraw", position: "PosB1111111111111111111111111111111111111111" }, "1", log)).estimate_kind).toBe(
      "lp_position"
    );
    expect((await estimatePlanAction({ kind: "orca_deposit", poolKey: ORCA_MARKETS[0]!.pool_id }, "1000000", log)).estimate_kind).toBe("lp_position");
    expect(await estimatePlanAction({ kind: "exponent_redeem", ptMint: EXPONENT_MARKETS[0]!.pt_mint }, "1000000", log)).toEqual({
      estimate_kind: "pt_redeem",
    });
    expect(mockQuote).not.toHaveBeenCalled();
    expect(mockVault).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });
  it("amount 0 / 不正は amount_required、registry 外は unsupported_market", async () => {
    expect((await estimatePlanAction({ kind: "kamino_deposit", reserve: kSol.reserve }, "0", log)).failure_reason).toBe("amount_required");
    expect((await estimatePlanAction({ kind: "kamino_deposit", reserve: kSol.reserve }, "1.5", log)).failure_reason).toBe("amount_required");
    expect(
      (await estimatePlanAction({ kind: "swap_earn_deposit", shareMint: "Unknown11111111111111111111111111111111111" }, "1", log)).failure_reason
    ).toBe("unsupported_market");
  });
  it("どの kind でも estimated_fee を出さない", async () => {
    mockQuote.mockResolvedValue(quote("1000000", "948000"));
    mockVault.mockResolvedValue({ apy: "0.05", tokensPerShare: "1.1", tokenPrice: "1" });
    mockSave.mockResolvedValue([{ reserve: saveUsdc.reserve, supply_apy: 0.02, ctoken_exchange_rate: "1.05" }]);
    const ests = await Promise.all([
      estimatePlanAction({ kind: "swap_earn_deposit", shareMint: jlUsdc.share_mint }, "1000000", log),
      estimatePlanAction({ kind: "kamino_deposit", reserve: kSol.reserve }, "1000000", log),
      estimatePlanAction({ kind: "kamino_vault_deposit", vault: steak.vault }, "1000000", log),
      estimatePlanAction({ kind: "save_deposit", reserve: saveUsdc.reserve }, "1000000", log),
    ]);
    for (const e of ests) expect("estimated_fee" in e).toBe(false);
  });
});
