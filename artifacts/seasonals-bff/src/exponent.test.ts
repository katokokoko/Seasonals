/**
 * Phase 8.33: Exponent PT read-only 統合の pure function テスト。
 *
 * (1) exponentMarketUnion — live 優先 / registry backstop
 * (2) mapPtHoldingsToMaturityEvents — PT/YT → maturity イベント (§11.4)
 * (3) mapExponentHoldingsToEarnPositions — decimals 変換 / usd8 bigint / degrade
 * (4) buildExponentMenuPools — maturity filter / quote 建て TVL 換算 / display_only
 * 全て pure — network / server 起動なし。maturity は now 注入で時限爆弾なし。
 */
import type { FastifyInstance } from "fastify";

import {
  EXPONENT_MARKETS,
  exponentMaturityIso,
  exponentPoolId,
} from "@workspace/lib/config/exponent-markets";
import { fetchExponentFullMarkets, type ExponentFullMarket } from "./clients/rates";
import {
  buildExponentMenuPools,
  buildServer,
  exponentMarketUnion,
  mapExponentHoldingsToEarnPositions,
  mapPtHoldingsToMaturityEvents,
} from "./server";
import type { HeliusAsset } from "./clients/helius";
import { buildExponentRedeemTx } from "./clients/exponent-tx";
import { getOracleResult } from "./clients/oracle";

// Phase 8.34: /protocols/exponent/redeem-tx 用 mock (pure function テストには影響なし)
jest.mock("./clients/rates");
jest.mock("./clients/oracle");
jest.mock("./clients/exponent-tx", () => ({
  ...jest.requireActual("./clients/exponent-tx"),
  buildExponentRedeemTx: jest.fn(),
}));

const WALLET = "WaLLet1111111111111111111111111111111111111";
// snapshot と衝突しない合成 market。maturity は NOW から相対で組む (deterministic)。
const NOW = new Date("2026-07-10T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function liveMarket(p: Partial<ExponentFullMarket> = {}): ExponentFullMarket {
  return {
    ticker: "tUSD",
    underlying_mint: "Under1111111111111111111111111111111111111",
    underlying_decimals: 6,
    pt_mint: "Pt111111111111111111111111111111111111111111",
    yt_mint: "Yt111111111111111111111111111111111111111111",
    vault_address: "Vault111111111111111111111111111111111111111",
    pt_decimals: 6,
    maturity_ts: NOW_SEC + 68 * 86400, // +68d → info
    implied_apy: 0.08,
    underlying_apy: 0.05,
    total_market_size: 1_000_000,
    quote_ticker: "USD",
    pt_price_in_asset: 0.95,
    market_status: "active",
    ...p,
  };
}

function asset(mint: string, balance: string): HeliusAsset {
  return { id: mint, interface: "FungibleToken", token_info: { balance } };
}

describe("exponentMarketUnion", () => {
  it("live 無し → registry snapshot 全件", () => {
    const u = exponentMarketUnion(undefined);
    expect(u).toHaveLength(EXPONENT_MARKETS.length);
    expect(u.every((m) => m.market_status === "registry")).toBe(true);
  });

  it("live は registry の同 pt_mint を上書きし、registry 外は残る (backstop)", () => {
    const usx = EXPONENT_MARKETS.find((m) => m.underlying_symbol === "USX")!;
    const live = liveMarket({ pt_mint: usx.pt_mint, implied_apy: 0.099 });
    const u = exponentMarketUnion([live]);
    expect(u).toHaveLength(EXPONENT_MARKETS.length); // 同 key は置換、件数不変
    const merged = u.find((m) => m.pt_mint === usx.pt_mint)!;
    expect(merged.implied_apy).toBe(0.099); // live 優先
    // registry 専有 entry (live に無い) は残る
    expect(
      u.filter((m) => m.market_status === "registry").length
    ).toBe(EXPONENT_MARKETS.length - 1);
  });
});

describe("mapPtHoldingsToMaturityEvents (§11.4 実データ源)", () => {
  const m = liveMarket();

  it("PT 保有 → maturity イベント (id / ISO / headline / actions 空)", () => {
    const events = mapPtHoldingsToMaturityEvents(
      [asset(m.pt_mint, "5000000")],
      [m],
      WALLET,
      NOW
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe(`maturity_${m.pt_mint}`);
    expect(e.category).toBe("maturity");
    expect(e.triggerAt).toBe(exponentMaturityIso(m.maturity_ts));
    expect(e.urgency).toBe("info"); // +68d
    expect(e.metadata.side).toBe("PT");
    expect(e.metadata.headline).toBe(
      "PT tUSD matures — redeemable 1:1 for tUSD"
    );
    expect(e.metadata.pt_amount).toBe("5000000");
    expect(e.actions).toHaveLength(0); // read-only v1
  });

  it("YT 保有 → YT headline のイベント", () => {
    const events = mapPtHoldingsToMaturityEvents(
      [asset(m.yt_mint, "1")],
      [m],
      WALLET,
      NOW
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.side).toBe("YT");
    expect(events[0]!.metadata.headline).toBe(
      "YT tUSD expires — yield accrual ends"
    );
  });

  it("満期を過ぎた PT は critical (過去日 = 今すぐ対応)", () => {
    const past = liveMarket({ maturity_ts: NOW_SEC - 86400 });
    const events = mapPtHoldingsToMaturityEvents(
      [asset(past.pt_mint, "1")],
      [past],
      WALLET,
      NOW
    );
    expect(events[0]!.urgency).toBe("critical");
  });

  it("zero balance / 未知 mint は無視", () => {
    const events = mapPtHoldingsToMaturityEvents(
      [asset(m.pt_mint, "0"), asset("Other111111111111111111111111111111111111", "9")],
      [m],
      WALLET,
      NOW
    );
    expect(events).toHaveLength(0);
  });
});

describe("mapExponentHoldingsToEarnPositions", () => {
  const m = liveMarket();

  it("PT 保有 → EarnPosition (usd8 bigint 演算 / maturity_at / implied bps)", () => {
    // 5 PT (5_000_000 smallest, dec 6) × ptPrice 0.95 × $1.00 = $4.75
    const price = new Map([[m.underlying_mint, 100_000_000n]]);
    const out = mapExponentHoldingsToEarnPositions(
      [asset(m.pt_mint, "5000000")],
      [m],
      price
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.protocol_id).toBe("exponent");
    expect(p.asset_symbol).toBe("PT-tUSD");
    expect(p.share_mint).toBe(m.pt_mint);
    expect(p.shares).toBe("5000000");
    expect(p.underlying_amount).toBe("5000000"); // dec 6→6 変換なし
    expect(p.underlying_usd).toBe("4.75000000");
    expect(p.supply_rate_bps).toBe(800); // implied 0.08
    expect(p.maturity_at).toBe(exponentMaturityIso(m.maturity_ts));
  });

  it("pt_decimals ≠ underlying_decimals の bigint pow10 変換", () => {
    const m9 = liveMarket({ underlying_decimals: 9, pt_decimals: 6 });
    const out = mapExponentHoldingsToEarnPositions(
      [asset(m9.pt_mint, "5000000")], // 5 PT (dec 6)
      [m9],
      new Map()
    );
    expect(out[0]!.underlying_amount).toBe("5000000000"); // 5.0 (dec 9)
  });

  it("oracle 不明 + 非 stable ticker → underlying_usd '0' (偽 USD なし)", () => {
    const out = mapExponentHoldingsToEarnPositions(
      [asset(m.pt_mint, "5000000")],
      [m], // ticker tUSD は EXPONENT_STABLE_TICKERS 外
      new Map()
    );
    expect(out[0]!.underlying_usd).toBe("0");
  });

  it("oracle 不明でも stable ticker (USX) は $1.00 とみなす", () => {
    const usx = liveMarket({ ticker: "USX" });
    const out = mapExponentHoldingsToEarnPositions(
      [asset(usx.pt_mint, "1000000")], // 1 PT × 0.95
      [usx],
      new Map()
    );
    expect(out[0]!.underlying_usd).toBe("0.95000000");
  });

  it("YT 保有は EarnPosition を作らない (v1 対象外)", () => {
    const out = mapExponentHoldingsToEarnPositions(
      [asset(m.yt_mint, "1000000")],
      [m],
      new Map()
    );
    expect(out).toHaveLength(0);
  });
});

describe("buildExponentMenuPools", () => {
  it("maturity filter + 昇順 + display_only + implied APY", () => {
    const near = liveMarket({
      ticker: "aUSD",
      pt_mint: "PtA11111111111111111111111111111111111111111",
      yt_mint: "YtA11111111111111111111111111111111111111111",
      maturity_ts: NOW_SEC + 10 * 86400,
    });
    const far = liveMarket({
      ticker: "bUSD",
      pt_mint: "PtB11111111111111111111111111111111111111111",
      yt_mint: "YtB11111111111111111111111111111111111111111",
      maturity_ts: NOW_SEC + 90 * 86400,
    });
    const matured = liveMarket({
      ticker: "cUSD",
      pt_mint: "PtC11111111111111111111111111111111111111111",
      yt_mint: "YtC11111111111111111111111111111111111111111",
      maturity_ts: NOW_SEC - 1,
    });
    const pools = buildExponentMenuPools([far, matured, near], NOW_SEC, 80);
    expect(pools.map((p) => p.asset)).toEqual(["aUSD", "bUSD"]); // 満期除外 + 昇順
    expect(pools.every((p) => p.display_only === true)).toBe(true);
    expect(pools[0]!.pool_id).toBe(exponentPoolId("aUSD", near.maturity_ts));
    expect(pools[0]!.apy).toBe(0.08);
  });

  it("TVL: USD quote は ×1、SOL quote は ×SOL 価格、未知 quote は 0", () => {
    const usd = liveMarket({ total_market_size: 1_000_000, quote_ticker: "USD" });
    const sol = liveMarket({
      pt_mint: "PtS11111111111111111111111111111111111111111",
      yt_mint: "YtS11111111111111111111111111111111111111111",
      ticker: "fragSOL",
      total_market_size: 1000,
      quote_ticker: "SOL",
    });
    const exotic = liveMarket({
      pt_mint: "PtX11111111111111111111111111111111111111111",
      yt_mint: "YtX11111111111111111111111111111111111111111",
      ticker: "xSOL",
      total_market_size: 999_999,
      quote_ticker: "xSOL",
    });
    const pools = buildExponentMenuPools([usd, sol, exotic], NOW_SEC, 80);
    const byAsset = new Map(pools.map((p) => [p.asset, p]));
    expect(byAsset.get("tUSD")!.tvl_usd).toBe(1_000_000);
    expect(byAsset.get("fragSOL")!.tvl_usd).toBe(80_000);
    expect(byAsset.get("xSOL")!.tvl_usd).toBe(0); // 換算不能は 0 (偽 USD なし)
  });

  it("SOL 価格不明なら SOL quote market の TVL は 0", () => {
    const sol = liveMarket({ ticker: "rkuSOL", quote_ticker: "SOL" });
    const pools = buildExponentMenuPools([sol], NOW_SEC, undefined);
    expect(pools[0]!.tvl_usd).toBe(0);
  });
});

// ── Phase 8.34: POST /protocols/exponent/redeem-tx ───────────────────────────

describe("POST /protocols/exponent/redeem-tx", () => {
  const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
  // 実行時 now 相対で組む (wall-clock 時限爆弾なし)
  const nowSec = Math.floor(Date.now() / 1000);
  const MATURED = liveMarket({
    ticker: "mUSD",
    pt_mint: "PtMat111111111111111111111111111111111111111",
    yt_mint: "YtMat111111111111111111111111111111111111111",
    vault_address: "VaultMat111111111111111111111111111111111111",
    maturity_ts: nowSec - 86400,
  });
  const NOT_MATURED = liveMarket({
    ticker: "fUSD",
    pt_mint: "PtFut111111111111111111111111111111111111111",
    yt_mint: "YtFut111111111111111111111111111111111111111",
    vault_address: "VaultFut111111111111111111111111111111111111",
    maturity_ts: nowSec + 90 * 86400,
  });

  const mockMarkets = fetchExponentFullMarkets as jest.MockedFunction<
    typeof fetchExponentFullMarkets
  >;
  const mockOracle = getOracleResult as jest.MockedFunction<typeof getOracleResult>;
  const mockBuild = buildExponentRedeemTx as jest.MockedFunction<
    typeof buildExponentRedeemTx
  >;

  let app: FastifyInstance;
  beforeEach(async () => {
    jest.clearAllMocks();
    mockMarkets.mockResolvedValue([MATURED, NOT_MATURED]);
    mockOracle.mockResolvedValue({ status: "ok" } as Awaited<
      ReturnType<typeof getOracleResult>
    >);
    mockBuild.mockResolvedValue({ transaction: "REDEEM_TX_B64" });
    app = await buildServer({ logger: false });
  });
  afterEach(async () => {
    await app.close();
  });

  function post(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/protocols/exponent/redeem-tx",
      payload: body,
    });
  }

  it("満期済 PT → 200 + unsigned tx (builder へ market を渡す)", async () => {
    const res = await post({ user: VALID_USER, ptMint: MATURED.pt_mint, amount: "5000000" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      transaction: "REDEEM_TX_B64",
      ptMint: MATURED.pt_mint,
      underlyingMint: MATURED.underlying_mint,
    });
    expect(mockBuild).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: {
        pt_mint: MATURED.pt_mint,
        yt_mint: MATURED.yt_mint,
        vault_address: MATURED.vault_address,
        underlying_mint: MATURED.underlying_mint,
      },
      amountSmallest: "5000000",
    });
  });

  it("満期前 PT → 400 not_matured (fail-closed、builder を呼ばない)", async () => {
    const res = await post({ user: VALID_USER, ptMint: NOT_MATURED.pt_mint, amount: "1" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_matured");
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("未知 ptMint → 400 unsupported_market", async () => {
    const res = await post({ user: VALID_USER, ptMint: "Unknown111111111111111111111111111111111111", amount: "1" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_market");
  });

  it("バリデーション: missing / 不正 wallet / 不正 amount は 400 (§4.5)", async () => {
    expect((await post({ user: VALID_USER, ptMint: MATURED.pt_mint })).statusCode).toBe(400);
    expect(
      (await post({ user: "bad wallet", ptMint: MATURED.pt_mint, amount: "1" })).statusCode
    ).toBe(400);
    const bad = await post({ user: VALID_USER, ptMint: MATURED.pt_mint, amount: "1.5" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_amount");
  });

  it("oracle blocked → 409 (§4.6 fail-closed)", async () => {
    mockOracle.mockResolvedValue({
      status: "blocked",
      block_reason: "oracle_both_stale",
    } as Awaited<ReturnType<typeof getOracleResult>>);
    const res = await post({ user: VALID_USER, ptMint: MATURED.pt_mint, amount: "1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("oracle_blocked");
  });

  it("template 不在 (新満期直後) → 409 redeem_template_unavailable", async () => {
    mockBuild.mockRejectedValue(new Error("redeem_template_unavailable"));
    const res = await post({ user: VALID_USER, ptMint: MATURED.pt_mint, amount: "1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("redeem_template_unavailable");
  });

  it("builder の他エラー → 502 exponent_tx_failed", async () => {
    mockBuild.mockRejectedValue(new Error("vault_pt_mint_mismatch"));
    const res = await post({ user: VALID_USER, ptMint: MATURED.pt_mint, amount: "1" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("exponent_tx_failed");
  });
});
