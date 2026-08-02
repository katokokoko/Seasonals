/**
 * BFF integration tests — Fastify inject() で各 endpoint を直接叩く
 *
 * test 範囲: status code、response shape、fixture との一致、status transition guard
 *
 * §32.2 整合性チェック「same source of truth」を担保する: 本テストの response shape は
 * Mobile artifact が `services/api.ts` で消費する shape と同一であることを fixture
 * 経由で確認する。
 */

import type { FastifyInstance } from "fastify";

import {
  fixtureUnifiedTimeEvents,
  fixturePositions,
  fixtureAgentPlans,
  fixtureApprovalTokens,
  fixtureUserPolicyDefault,
  fixtureWallets,
  fixtureProtocols,
} from "@workspace/lib/__fixtures__";
import { TIME_EVENT_CATEGORIES } from "@workspace/lib/types";

import {
  buildServer,
  computeCostBasisByShareMint,
  mapJupiterLendToEarnPositions,
  jlSharePriceOverrides,
  jupiterLendUsd8,
  mapAssetsToPositions,
  normalizeJup8DecimalUsd,
} from "./server";
import type { HeliusEnhancedTx } from "./clients/helius-tx";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildServer({ logger: false });
});

afterEach(async () => {
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// health
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("status=ok を返す", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// list endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /time-events", () => {
  // Phase 8.4: production cleanup — fixture は返さず空配列。wallet 接続済の
  // 接続済 wallet からの履歴は別途 /time-events/wallet?wallet=<addr> 経由。
  it("returns an empty array (Phase 8.4: no fixture in production)", async () => {
    const res = await app.inject({ method: "GET", url: "/time-events" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ category: string; id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });
});

describe("GET /positions", () => {
  // Phase 8.4: production cleanup — wallet 無指定なら []。
  // wallet 指定時は Helius DAS 経由で実 positions を返す path に行く。
  it("returns an empty array when no wallet query is provided", async () => {
    const res = await app.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<unknown>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });
});

describe("GET /wallets", () => {
  it("fixture の 3 件を返す", async () => {
    const res = await app.inject({ method: "GET", url: "/wallets" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(fixtureWallets.length);
  });
});

describe("GET /protocols", () => {
  it("fixture の protocols (Tier S/A 含む)", async () => {
    const res = await app.inject({ method: "GET", url: "/protocols" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ trust_level: string }>;
    const trustLevels = new Set(body.map((p) => p.trust_level));
    expect(trustLevels.has("S")).toBe(true);
    expect(trustLevels.has("A")).toBe(true);
  });
});

describe("GET /user-policy", () => {
  it("default policy (approval_mode=request_per_action, max_tx_amount=null)", async () => {
    const res = await app.inject({ method: "GET", url: "/user-policy" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as typeof fixtureUserPolicyDefault;
    expect(body.approval_mode).toBe("request_per_action");
    expect(body.max_tx_amount).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agent plans
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /agent-plans/:planId", () => {
  it("plan_002 (simulated) を返す", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent-plans/plan_002",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plan_id: "plan_002",
      status: "simulated",
    });
  });

  it("存在しない plan_id は 404 + agent_plan_not_found", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent-plans/plan_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "agent_plan_not_found" });
  });
});

describe("POST /agent-plans/:planId/approve", () => {
  it("simulated plan を approve すると status=approved を返す", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_002/approve",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plan_id: string; status: string };
    expect(body.plan_id).toBe("plan_002");
    expect(body.status).toBe("approved");
  });

  it("draft 状態の plan は 409 + invalid_status_transition", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_001/approve",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "invalid_status_transition",
      current: "draft",
    });
  });

  it("存在しない plan は 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_x/approve",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /agent-plans/:planId/reject", () => {
  it("status=rejected を返す", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_002/reject",
      payload: { reason: "user changed mind" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rejected" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// approval tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /approval-tokens/:tokenId", () => {
  it("active token を返す", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approval-tokens/tok_active_001",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token_id: string; consumed_at: string | null };
    expect(body.token_id).toBe("tok_active_001");
    expect(body.consumed_at).toBeNull();
  });

  it("存在しない token は 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approval-tokens/tok_x",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "approval_token_not_found" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// push tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /push-tokens", () => {
  it("有効な token は 200 + registered_at", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/push-tokens",
      payload: { token: "ExponentPushToken[abc]" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { registered_at: string };
    expect(typeof body.registered_at).toBe("string");
  });

  it("空 token は 400 + invalid_push_token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/push-tokens",
      payload: { token: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_push_token" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fixture との shape 整合
// ─────────────────────────────────────────────────────────────────────────────

describe("fixture との shape 一致", () => {
  it("/time-events returns empty array (Phase 8.4: no fixture in production)", async () => {
    const res = await app.inject({ method: "GET", url: "/time-events" });
    expect(res.json()).toEqual([]);
  });

  it("/approval-tokens/:id は fixture と一致", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approval-tokens/tok_active_001",
    });
    expect(res.json()).toEqual(fixtureApprovalTokens[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.12: Jupiter Lend underlying_usd 正規化
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 8.12 — Jupiter Lend underlying_usd 正規化", () => {
  it("normalizeJup8DecimalUsd: 8-dec integer string → §4.5 decimal string", () => {
    expect(normalizeJup8DecimalUsd("3763527416")).toBe("37.63527416");
    expect(normalizeJup8DecimalUsd("100000000")).toBe("1");
    expect(normalizeJup8DecimalUsd("1")).toBe("0.00000001");
    expect(normalizeJup8DecimalUsd("0")).toBe("0");
  });

  it("normalizeJup8DecimalUsd: 不正値は '0' fallback", () => {
    expect(normalizeJup8DecimalUsd("")).toBe("0");
    expect(normalizeJup8DecimalUsd("abc")).toBe("0");
    expect(normalizeJup8DecimalUsd("12.3")).toBe("0"); // decimal point は token amount として無効
    expect(normalizeJup8DecimalUsd(null)).toBe("0");
    expect(normalizeJup8DecimalUsd(undefined)).toBe("0");
  });

  it("8.57: underlying_usd は underlyingAssets × asset.price (underlyingBalance ではない)", () => {
    const raws = [
      {
        token: {
          address: "JL_USDC_MINT",
          name: "Jupiter Lend USDC",
          symbol: "jlUSDC",
          decimals: 6,
          assetAddress: "USDC_MINT",
          asset: {
            address: "USDC_MINT",
            symbol: "USDC",
            decimals: 6,
            price: 1.0,
          },
        },
        shares: "37635272",
        underlyingAssets: "37635272",
        underlyingBalance: "3763527416",
        supplyRate: "303",
        rewardsRate: "0",
        totalRate: "303",
        ownerAddress: "TEST_OWNER",
      },
    ];
    const result = mapJupiterLendToEarnPositions(raws);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      protocol_id: "jupiter_lend",
      asset_symbol: "USDC",
      underlying_amount: "37635272",
      underlying_decimals: 6,
      // 8.57: 37.635272 USDC × $1.0。旧版は underlyingBalance を 8-dec USD と
      // 誤解しており、実データ (wallet 残高が入る) では桁が狂っていた
      underlying_usd: "37.63527200",
      supply_rate_bps: 303,
    });
  });

  it("mapJupiterLendToEarnPositions: shares='0' は除外", () => {
    const raws = [
      {
        token: {
          address: "JL_USDC_MINT",
          name: "Jupiter Lend USDC",
          symbol: "jlUSDC",
          decimals: 6,
          assetAddress: "USDC_MINT",
          asset: { address: "USDC_MINT", symbol: "USDC", decimals: 6 },
        },
        shares: "0",
        underlyingAssets: "0",
        underlyingBalance: "0",
        supplyRate: "303",
        rewardsRate: "0",
        totalRate: "303",
        ownerAddress: "TEST",
      },
    ];
    expect(mapJupiterLendToEarnPositions(raws)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.13 — 実 accrued yield (cost-basis from tx history)
// ─────────────────────────────────────────────────────────────────────────────

const WALLET = "WALLET_OWNER_ADDR";
const JL_USDC = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"; // jlUSDC share mint
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC underlying mint

/** balance change を 1 つ作る helper */
function bal(mint: string, owner: string, raw: string, decimals = 6) {
  return { mint, userAccount: owner, rawTokenAmount: { tokenAmount: raw, decimals } };
}

/** tx を 1 つ作る helper (accountData 1 件に複数 balance change を束ねる) */
function tx(sig: string, changes: ReturnType<typeof bal>[]): HeliusEnhancedTx {
  return {
    signature: sig,
    timestamp: 1_700_000_000,
    type: "SWAP",
    fee: 5000,
    accountData: [{ account: "ACC", tokenBalanceChanges: changes }],
  };
}

/** Jupiter Lend raw position を 1 つ作る helper */
function jlRaw(underlyingAssets: string, shares = "1000000") {
  return {
    token: {
      address: JL_USDC,
      name: "Jupiter Lend USDC",
      symbol: "jlUSDC",
      decimals: 6,
      assetAddress: USDC,
      asset: { address: USDC, symbol: "USDC", decimals: 6, price: 1.0 },
    },
    shares,
    underlyingAssets,
    underlyingBalance: normalizeJup8DecimalUsd(underlyingAssets) + "00", // 適当 (mapper は使わない)
    supplyRate: "303",
    rewardsRate: "0",
    totalRate: "303",
    ownerAddress: WALLET,
  };
}

describe("computeCostBasisByShareMint", () => {
  it("単一 deposit: 純入金 = deposit underlying (smallest unit)", () => {
    // wallet が 100 USDC を出し (−100000000) jlUSDC を受け取る
    const txs = [
      tx("d1", [bal(USDC, WALLET, "-100000000"), bal(JL_USDC, WALLET, "98000000")]),
    ];
    const net = computeCostBasisByShareMint(txs, WALLET);
    expect(net.get(JL_USDC)).toBe(100_000_000n);
  });

  it("複数 deposit + 部分 withdraw: running net", () => {
    const txs = [
      tx("d1", [bal(USDC, WALLET, "-100000000"), bal(JL_USDC, WALLET, "98000000")]),
      tx("d2", [bal(USDC, WALLET, "-50000000"), bal(JL_USDC, WALLET, "49000000")]),
      // withdraw 30 USDC: wallet が USDC を受け取り (+30000000) jlUSDC を出す (−)
      tx("w1", [bal(USDC, WALLET, "30000000"), bal(JL_USDC, WALLET, "-29000000")]),
    ];
    const net = computeCostBasisByShareMint(txs, WALLET);
    // 100 + 50 − 30 = 120 USDC
    expect(net.get(JL_USDC)).toBe(120_000_000n);
  });

  it("withdraw のみ in-window: 負の net (mapper 側で unknown 扱い)", () => {
    const txs = [
      tx("w1", [bal(USDC, WALLET, "30000000"), bal(JL_USDC, WALLET, "-29000000")]),
    ];
    const net = computeCostBasisByShareMint(txs, WALLET);
    expect(net.get(JL_USDC)).toBe(-30_000_000n);
  });

  it("share は動くが underlying change が無い tx は寄与しない", () => {
    const txs = [tx("x1", [bal(JL_USDC, WALLET, "98000000")])];
    const net = computeCostBasisByShareMint(txs, WALLET);
    expect(net.has(JL_USDC)).toBe(false);
  });

  it("別 wallet の balance change は無視", () => {
    const txs = [
      tx("d1", [
        bal(USDC, "OTHER", "-100000000"),
        bal(JL_USDC, "OTHER", "98000000"),
      ]),
    ];
    const net = computeCostBasisByShareMint(txs, WALLET);
    expect(net.has(JL_USDC)).toBe(false);
  });
});

describe("mapJupiterLendToEarnPositions — accrued yield", () => {
  it("gain: current > cost-basis → sign=gain, accrued=delta", () => {
    const costBasis = new Map<string, bigint>([[JL_USDC, 100_000_000n]]);
    const pos = mapJupiterLendToEarnPositions([jlRaw("100420000")], costBasis)[0]!;
    expect(pos.accrued_yield_sign).toBe("gain");
    expect(pos.accrued_yield_amount).toBe("420000"); // 100.42 − 100 = 0.42 USDC
    expect(pos.cost_basis_amount).toBe("100000000");
  });

  it("loss: current < cost-basis → sign=loss, accrued は magnitude (^[0-9]+$)", () => {
    const costBasis = new Map<string, bigint>([[JL_USDC, 100_000_000n]]);
    const pos = mapJupiterLendToEarnPositions([jlRaw("99500000")], costBasis)[0]!;
    expect(pos.accrued_yield_sign).toBe("loss");
    expect(pos.accrued_yield_amount).toBe("500000");
    expect(pos.accrued_yield_amount).toMatch(/^[0-9]+$/); // 負数 string にしない
    expect(pos.cost_basis_amount).toBe("100000000");
  });

  it("cost-basis 不明 (空 Map) → sign=unknown, accrued='0', cost_basis=null", () => {
    const pos = mapJupiterLendToEarnPositions([jlRaw("100420000")], new Map())[0]!;
    expect(pos.accrued_yield_sign).toBe("unknown");
    expect(pos.accrued_yield_amount).toBe("0");
    expect(pos.cost_basis_amount).toBeNull();
  });

  it("net <= 0 (withdraw のみ in-window) → unknown ('無限利回り' にしない)", () => {
    const costBasis = new Map<string, bigint>([[JL_USDC, -30_000_000n]]);
    const pos = mapJupiterLendToEarnPositions([jlRaw("5000000")], costBasis)[0]!;
    expect(pos.accrued_yield_sign).toBe("unknown");
    expect(pos.accrued_yield_amount).toBe("0");
    expect(pos.cost_basis_amount).toBeNull();
  });

  it("引数省略時は cost-basis なし扱い (後方互換)", () => {
    const pos = mapJupiterLendToEarnPositions([jlRaw("100420000")])[0]!;
    expect(pos.accrued_yield_sign).toBe("unknown");
  });
});

describe("Phase 8.57 — jupiterLendUsd8", () => {
  it("underlyingAssets × price を 8-dec USD string にする", () => {
    // 実測 (2026-08-01): 10.206598 USDC × $0.999846136315
    // price は §4.5 に合わせ 8 桁で**切り捨て** (0.99984613) してから乗算する
    expect(jupiterLendUsd8("10206598", 6, "0.999846136315")).toBe("10.20502751");
  });

  it("price 欠落 / 不正 amount は '0' (0 円と誤読されない側に倒す)", () => {
    expect(jupiterLendUsd8("10206598", 6, null)).toBe("0");
    expect(jupiterLendUsd8("10206598", 6, "0")).toBe("0");
    expect(jupiterLendUsd8("12.3", 6, "1")).toBe("0");
  });

  it("SOL (9 dec) でも桁が合う", () => {
    // 0.2976 SOL × $74.92 = 22.2961920
    expect(jupiterLendUsd8("297600000", 9, "74.92")).toBe("22.29619200");
  });
});

describe("Phase 8.70 — jlSharePriceOverrides / DAS 価格の上書き", () => {
  /** 実測 (2026-08-03) の jlUSDC market */
  const jlUsdcMarket = {
    jlMint: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
    jlSymbol: "jlUSDC",
    jlDecimals: 6,
    underlyingMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    underlyingSymbol: "USDC",
    underlyingDecimals: 6,
    underlyingPriceUsd: 0.999809443243,
    underlyingPriceRaw: "0.999809443243",
    convertToAssets: "1054007",
    supplyRateBps: 447,
    rewardsRateBps: 72,
    totalRateBps: 519,
    tvlUnderlying: "420563446936375",
  };

  it("convertToAssets × underlying price が 1 share の単価になる", () => {
    const out = jlSharePriceOverrides([jlUsdcMarket]);
    // DAS が返していた 1.08643570 ではなく、償還価値ベースの値
    // price は §4.5 に合わせ 8 桁切り捨てしてから乗算する (既存 helper の規約)
    expect(out.get(jlUsdcMarket.jlMint)).toBe("1.05380614");
  });

  it("convertToAssets 欠落 / price 0 の market は map に入れない (0 を配らない)", () => {
    const { convertToAssets: _drop, ...noRate } = jlUsdcMarket;
    expect(jlSharePriceOverrides([noRate]).size).toBe(0);
    expect(
      jlSharePriceOverrides([
        { ...jlUsdcMarket, underlyingPriceRaw: "0", underlyingPriceUsd: 0 },
      ]).size
    ).toBe(0);
    expect(jlSharePriceOverrides([]).size).toBe(0);
  });

  it("override があれば DAS 価格に勝ち、無ければ DAS のまま", () => {
    const assets = [
      {
        interface: "FungibleToken",
        id: jlUsdcMarket.jlMint,
        token_info: {
          balance: "9685801",
          decimals: 6,
          symbol: "jlUSDC",
          price_info: { price_per_token: 1.0864357 },
        },
      },
      {
        interface: "FungibleToken",
        id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        token_info: {
          balance: "90262168",
          decimals: 6,
          symbol: "USDC",
          price_info: { price_per_token: 0.9997741 },
        },
      },
    ] as unknown as Parameters<typeof mapAssetsToPositions>[0];

    const overridden = mapAssetsToPositions(
      assets,
      "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM",
      jlSharePriceOverrides([jlUsdcMarket])
    );
    const jl = overridden.find((p) => p.asset_symbol === "jlUSDC")!;
    const usdc = overridden.find((p) => p.asset_symbol === "USDC")!;
    expect(jl.unit_price_usd).toBe("1.05380614");
    // override の無い token は DAS のまま (回帰)
    expect(usdc.unit_price_usd).toBe("0.99977410");

    // override 未指定 = 従来どおり全部 DAS
    const legacy = mapAssetsToPositions(
      assets,
      "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM"
    );
    expect(legacy.find((p) => p.asset_symbol === "jlUSDC")!.unit_price_usd).toBe(
      "1.08643570"
    );
  });
});
