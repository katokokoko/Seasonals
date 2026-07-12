/**
 * Phase 8.15.x: earnings 実値化のテスト。
 *
 * (1) decimal 正規化 (指数表記/符号 — Kamino PnL が返す "6.19e-7" 等)
 * (2) cost-basis 一般化 (cUSDC = SPL⇄SPL / jitoSOL = WSOL⇄SPL)
 * (3) LST / USD* / Save 保有の enriched mapper (rate 換算 / oracle USD / earned)
 * (4) kVault / obligation の PnL attach
 * 全て pure function — network / server 不要。
 */
import type { EarnPosition } from "@workspace/lib/types";
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import { KAMINO_MARKETS, KAMINO_VAULTS } from "@workspace/lib/config/kamino-markets";

import {
  attachKaminoObligationPnl,
  attachKaminoVaultPnl,
  computeCostBasisByShareMint,
  mapSaveHoldingsToEarnPositions,
  mapSwapEarnHoldingsToEarnPositions,
  normalizeDecimalString,
  signedDecimalToSmallest,
  singleSupportedDepositObligations,
} from "./server";
import type { HeliusEnhancedTx } from "./clients/helius-tx";
import type { HeliusAsset } from "./clients/helius";

const WALLET = "WaLLet1111111111111111111111111111111111111";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITO = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jito")!;
const PERENA = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "perena")!;
const JL_USDC = SWAP_EARN_MARKETS.find(
  (m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC"
)!;
const SAVE_USDC = SAVE_MARKETS.find((m) => m.underlying_symbol === "USDC")!;
const KAMINO_USDC = KAMINO_MARKETS.find((m) => m.underlying_symbol === "USDC")!;
const KAMINO_SOL = KAMINO_MARKETS.find((m) => m.underlying_symbol === "SOL")!;
const VAULT_SOL = KAMINO_VAULTS.find((v) => v.underlying_symbol === "SOL")!;

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
function asset(mint: string, balance: string): HeliusAsset {
  return { id: mint, interface: "FungibleToken", token_info: { balance } };
}

// ── decimal 正規化 ────────────────────────────────────────────────────────────

describe("normalizeDecimalString", () => {
  it("plain / 符号 / 指数表記を正規化", () => {
    expect(normalizeDecimalString("1.5")).toEqual({ negative: false, abs: "1.5" });
    expect(normalizeDecimalString("-0.25")).toEqual({ negative: true, abs: "0.25" });
    expect(normalizeDecimalString("6.1998770984595e-7")).toEqual({
      negative: false,
      abs: "0.00000061998770984595",
    });
    expect(normalizeDecimalString("1.5e3")).toEqual({ negative: false, abs: "1500" });
    expect(normalizeDecimalString("-2E-2")).toEqual({ negative: true, abs: "0.02" });
  });
  it("ゼロは正扱い / 不正は null", () => {
    expect(normalizeDecimalString("-0.000")).toEqual({ negative: false, abs: "0" });
    expect(normalizeDecimalString("abc")).toBeNull();
    expect(normalizeDecimalString(undefined)).toBeNull();
  });
});

describe("signedDecimalToSmallest", () => {
  it("符号付き decimal → magnitude smallest", () => {
    expect(signedDecimalToSmallest("-0.5", 9)).toEqual({
      magnitude: "500000000",
      negative: true,
    });
    expect(signedDecimalToSmallest("6.1998770984595e-7", 9)).toEqual({
      magnitude: "619",
      negative: false,
    });
  });
  it("不正は 0/false", () => {
    expect(signedDecimalToSmallest("x", 6)).toEqual({ magnitude: "0", negative: false });
  });
});

// ── cost-basis 一般化 ─────────────────────────────────────────────────────────

describe("computeCostBasisByShareMint — 一般化 (8.15.x)", () => {
  it("Save cUSDC: USDC 出 + cUSDC 入 (SPL⇄SPL) で net を返す", () => {
    const txs = [
      tx("s1", [
        bal(USDC_MINT, WALLET, "-1000000"),
        bal(SAVE_USDC.ctoken_mint, WALLET, "769000"),
      ]),
    ];
    const net = computeCostBasisByShareMint(txs, WALLET);
    expect(net.get(SAVE_USDC.ctoken_mint)).toBe(1_000_000n);
  });

  it("jitoSOL: WSOL 出 + jitoSOL 入 で net を返す (SOL は WSOL として現れる)", () => {
    const txs = [
      tx("l1", [
        bal(SOL_MINT, WALLET, "-50000000", 9),
        bal(JITO.share_mint, WALLET, "38000000", 9),
      ]),
    ];
    const net = computeCostBasisByShareMint(txs, WALLET);
    expect(net.get(JITO.share_mint)).toBe(50_000_000n);
  });

  it("jl 既存挙動は不変 (回帰)", () => {
    const txs = [
      tx("d1", [
        bal(USDC_MINT, WALLET, "-100000000"),
        bal(JL_USDC.share_mint, WALLET, "98000000"),
      ]),
    ];
    expect(computeCostBasisByShareMint(txs, WALLET).get(JL_USDC.share_mint)).toBe(
      100_000_000n
    );
  });
});

// ── swap-earn holdings mapper ─────────────────────────────────────────────────

describe("mapSwapEarnHoldingsToEarnPositions", () => {
  const solValues = new Map([["jitoSOL", 1_275_866_054n]]); // lamports per jitoSOL
  const prices = new Map([
    [SOL_MINT, 77_73929138n], // $77.73929138 ×1e8
    [USDC_MINT, 1_00000000n],
  ]);

  it("jitoSOL: rate 換算 + oracle USD + cost-basis earned (gain)", () => {
    const cost = new Map([[JITO.share_mint, 100_000_000n]]); // 0.1 SOL 入金
    const out = mapSwapEarnHoldingsToEarnPositions(
      [asset(JITO.share_mint, "100000000")], // 0.1 jitoSOL
      solValues,
      new Map(),
      prices,
      cost
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    // 0.1 jitoSOL × 1.275866054 = 0.1275866054 SOL
    expect(p.underlying_amount).toBe("127586605");
    expect(p.asset_symbol).toBe("SOL");
    expect(p.market_symbol).toBe("jitoSOL");
    expect(p.accrued_yield_sign).toBe("gain");
    expect(p.accrued_yield_amount).toBe("27586605"); // 0.0275…SOL
    expect(p.cost_basis_amount).toBe("100000000");
    // USD ≈ 0.1275866054 × 77.739… ≈ 9.918…
    expect(p.underlying_usd.startsWith("9.9")).toBe(true);
  });

  it("LST APY (8.23): lstApys 指定で supply_rate_bps 実値、未指定は null", () => {
    const withApy = mapSwapEarnHoldingsToEarnPositions(
      [asset(JITO.share_mint, "100000000")],
      solValues,
      new Map(),
      prices,
      new Map(),
      new Map([["jitoSOL", 0.0681]])
    );
    expect(withApy[0]!.supply_rate_bps).toBe(681);

    const without = mapSwapEarnHoldingsToEarnPositions(
      [asset(JITO.share_mint, "100000000")],
      solValues,
      new Map(),
      prices,
      new Map()
    );
    expect(without[0]!.supply_rate_bps).toBeNull();
  });

  it("USD*: Jupiter quote rate で USDC 換算 + Perena APY (8.25)", () => {
    const out = mapSwapEarnHoldingsToEarnPositions(
      [asset(PERENA.share_mint, "2000000")], // 2 USD*
      new Map(),
      new Map([["USD*", { probe: 1_000_000n, out: 1_016_373n }]]),
      prices,
      new Map(),
      new Map([["USD*", 0.093]])
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.underlying_amount).toBe("2032746"); // 2 × 1.016373 USDC
    expect(out[0]!.accrued_yield_sign).toBe("unknown"); // cost-basis 無し
    expect(out[0]!.supply_rate_bps).toBe(930);
  });

  it("eUSX (Solstice 8.24): quote rate 換算 + Exponent APY (merge Map 経由)", () => {
    const SOLSTICE = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "solstice")!;
    const out = mapSwapEarnHoldingsToEarnPositions(
      [asset(SOLSTICE.share_mint, "2000000")], // 2 eUSX
      new Map(),
      new Map([["eUSX", { probe: 1_000_000n, out: 1_036_476n }]]), // 実測 rate
      prices,
      new Map(),
      new Map([["eUSX", 0.0376]])
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.protocol_id).toBe("solstice");
    expect(p.underlying_amount).toBe("2072952"); // 2 × 1.036476 USDC
    expect(p.asset_symbol).toBe("USDC");
    expect(p.supply_rate_bps).toBe(376);
  });

  it("rate 不明 → 旧 semantics に degrade (share 建て + unknown)", () => {
    const out = mapSwapEarnHoldingsToEarnPositions(
      [asset(JITO.share_mint, "100000000")],
      new Map(),
      new Map(),
      prices,
      new Map()
    );
    expect(out[0]!.asset_symbol).toBe("jitoSOL");
    expect(out[0]!.underlying_amount).toBe("100000000");
    expect(out[0]!.underlying_usd).toBe("0");
  });

  it("jupiter_lend の share は除外 (jupiterLend 配列と二重計上しない)", () => {
    const out = mapSwapEarnHoldingsToEarnPositions(
      [asset(JL_USDC.share_mint, "1000000")],
      solValues,
      new Map(),
      prices,
      new Map()
    );
    expect(out).toHaveLength(0);
  });
});

// ── save holdings mapper ──────────────────────────────────────────────────────

describe("mapSaveHoldingsToEarnPositions", () => {
  const prices = new Map([[USDC_MINT, 1_00000000n]]);
  const rates = [
    {
      reserve: SAVE_USDC.reserve,
      supply_apy: 0.0203,
      ctoken_exchange_rate: "1.30081714201320922526",
    },
  ];

  it("cUSDC: exchange rate 換算 + APY + earned (gain)", () => {
    const cost = new Map([[SAVE_USDC.ctoken_mint, 1_000_000n]]);
    const out = mapSaveHoldingsToEarnPositions(
      [asset(SAVE_USDC.ctoken_mint, "1000000")], // 1 cUSDC
      rates,
      prices,
      cost
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.underlying_amount).toBe("1300817"); // 1 × 1.300817…
    expect(p.asset_symbol).toBe("USDC");
    expect(p.market_symbol).toBe("cUSDC");
    expect(p.supply_rate_bps).toBe(203);
    expect(p.accrued_yield_sign).toBe("gain");
    expect(p.accrued_yield_amount).toBe("300817");
    expect(p.underlying_usd).toBe("1.30081700");
  });

  it("rate 不明 → cToken 建て degrade", () => {
    const out = mapSaveHoldingsToEarnPositions(
      [asset(SAVE_USDC.ctoken_mint, "1000000")],
      [],
      prices,
      new Map()
    );
    expect(out[0]!.asset_symbol).toBe("cUSDC");
    expect(out[0]!.underlying_amount).toBe("1000000");
  });
});

// ── PnL attach ────────────────────────────────────────────────────────────────

function earnPos(partial: Partial<EarnPosition>): EarnPosition {
  return {
    protocol_id: "kamino",
    protocol_name: "Kamino",
    market_symbol: "X",
    share_mint: "M",
    shares: "1",
    share_decimals: 6,
    asset_symbol: "X",
    underlying_amount: "1",
    underlying_decimals: 6,
    underlying_usd: "0",
    supply_rate_bps: null,
    accrued_yield_amount: "0",
    accrued_yield_sign: "unknown",
    cost_basis_amount: null,
    ...partial,
  };
}

describe("attachKaminoVaultPnl", () => {
  it("token 建て PnL (指数表記) を underlying smallest で attach", () => {
    const pos = earnPos({
      share_mint: VAULT_SOL.vault,
      underlying_decimals: 9,
      asset_symbol: "SOL",
    });
    const out = attachKaminoVaultPnl(
      [pos],
      new Map([
        [
          VAULT_SOL.vault,
          {
            pnlToken: "6.1998770984595e-7",
            pnlUsd: "0.009",
            costBasisToken: "0.12999993716392281073",
          },
        ],
      ])
    );
    expect(out[0]!.accrued_yield_sign).toBe("gain");
    expect(out[0]!.accrued_yield_amount).toBe("619");
    expect(out[0]!.cost_basis_amount).toBe("129999937");
  });

  it("負 PnL は loss、pnl 無しは unchanged", () => {
    const pos = earnPos({ share_mint: VAULT_SOL.vault, underlying_decimals: 9 });
    const out = attachKaminoVaultPnl(
      [pos, earnPos({ share_mint: "other" })],
      new Map([
        [
          VAULT_SOL.vault,
          { pnlToken: "-0.001", pnlUsd: "-0.08", costBasisToken: "1" },
        ],
      ])
    );
    expect(out[0]!.accrued_yield_sign).toBe("loss");
    expect(out[0]!.accrued_yield_amount).toBe("1000000");
    expect(out[1]!.accrued_yield_sign).toBe("unknown");
  });
});

describe("attachKaminoObligationPnl", () => {
  const prices = new Map([[USDC_MINT, 1_00000000n]]);

  it("SOL reserve は pnl.sol を直接 lamports 化", () => {
    const pos = earnPos({
      share_mint: KAMINO_SOL.reserve,
      underlying_decimals: 9,
    });
    const out = attachKaminoObligationPnl(
      [pos],
      new Map([[KAMINO_SOL.reserve, { sol: "0.005", usd: "0.39" }]]),
      prices
    );
    expect(out[0]!.accrued_yield_sign).toBe("gain");
    expect(out[0]!.accrued_yield_amount).toBe("5000000");
  });

  it("USDC reserve は pnl.usd を oracle price で換算 (負は loss)", () => {
    const pos = earnPos({ share_mint: KAMINO_USDC.reserve });
    const out = attachKaminoObligationPnl(
      [pos],
      new Map([[KAMINO_USDC.reserve, { sol: "-0.001", usd: "-1.5" }]]),
      prices
    );
    expect(out[0]!.accrued_yield_sign).toBe("loss");
    expect(out[0]!.accrued_yield_amount).toBe("1500000"); // $1.5 / $1 = 1.5 USDC
  });

  it("price 不明 (USDC) は unchanged", () => {
    const pos = earnPos({ share_mint: KAMINO_USDC.reserve });
    const out = attachKaminoObligationPnl(
      [pos],
      new Map([[KAMINO_USDC.reserve, { sol: "0", usd: "1" }]]),
      new Map()
    );
    expect(out[0]!.accrued_yield_sign).toBe("unknown");
  });
});

describe("singleSupportedDepositObligations", () => {
  const EMPTY = "11111111111111111111111111111111";
  const oblig = (
    addr: string,
    deposits: { depositReserve: string; depositedAmount: string }[],
    borrows: { borrowReserve: string }[] = []
  ) => ({ obligationAddress: addr, deposits, borrows });

  it("供給専用・単一 supported deposit → reserve→obligation", () => {
    const m = singleSupportedDepositObligations([
      oblig("OB1", [
        { depositReserve: KAMINO_USDC.reserve, depositedAmount: "100" },
        { depositReserve: EMPTY, depositedAmount: "0" },
      ]),
    ]);
    expect(m.get(KAMINO_USDC.reserve)).toBe("OB1");
  });

  it("借入あり / 複数 deposit / 非 supported は除外", () => {
    const m = singleSupportedDepositObligations([
      oblig(
        "OB1",
        [{ depositReserve: KAMINO_USDC.reserve, depositedAmount: "100" }],
        [{ borrowReserve: "SomeBorrowReserve11111111111111111111111" }]
      ),
      oblig("OB2", [
        { depositReserve: KAMINO_USDC.reserve, depositedAmount: "100" },
        { depositReserve: KAMINO_SOL.reserve, depositedAmount: "100" },
      ]),
      oblig("OB3", [
        { depositReserve: "UnsupportedReserve1111111111111111111111", depositedAmount: "9" },
      ]),
    ]);
    expect(m.size).toBe(0);
  });

  it("同一 reserve が複数 obligation → 曖昧なので除外", () => {
    const m = singleSupportedDepositObligations([
      oblig("OB1", [{ depositReserve: KAMINO_USDC.reserve, depositedAmount: "1" }]),
      oblig("OB2", [{ depositReserve: KAMINO_USDC.reserve, depositedAmount: "2" }]),
    ]);
    expect(m.size).toBe(0);
  });
});
