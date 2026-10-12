/**
 * MenuDrawer — drill-down の smoke テスト (Phase 8.54)
 *
 * 判断ロジックは vault-rows.test.ts が固定するので、ここでは **実際に render して
 * 壊れないこと** と、protocol ごとの見た目の分岐 (CTA / 枠ラベル / サマリー) が
 * 出ることだけを確認する。8.54 以前は MenuDrawer の render テストが 1 つも無く、
 * pane の runtime エラーがテストをすり抜けていた。
 *
 * menu は IS_TEST_ENV の fixture 経路で解決される (network なし)。
 */
import React, { type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { BackHandler, Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { fixtureMenuListings } from "@workspace/lib/__fixtures__";

import { MenuDrawer } from "./MenuDrawer";
import { createQueryClient } from "../../services/queryClient";
import * as api from "../../services/api";

// 2026-10-08: BackHandler は Home が focus の間だけ登録する (useFocusEffect)。
// navigation context が無いので、focus の有無をテストごとに切り替える mock にする
let mockFocused = true;
jest.mock("expo-router", () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React = require("react");
    React.useEffect(() => (mockFocused ? cb() : undefined), [cb]);
  },
}));

function freshClient(): QueryClient {
  return createQueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

const METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 16 },
};

function wrap(ui: ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={freshClient()}>{ui}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** protocol カードを tap して drill-down を開く */
async function openProtocol(protocolId: string) {
  render(wrap(<MenuDrawer visible onClose={() => {}} testID="menu" />));
  const card = await screen.findByTestId(`menu-card-${protocolId}`);
  fireEvent.press(card);
  return card;
}

describe("MenuDrawer drill-down (8.54 カード行)", () => {
  it("Kamino: pool ごとにカード行が出て、APY と pool 名が読める", async () => {
    await openProtocol("kamino");
    await waitFor(() =>
      expect(screen.getByTestId("menu-detail-pool-kamino_usdc_main")).toBeTruthy()
    );
    // subtitle は pool 名 — 同一 asset に複数 pool がある protocol で行を区別する
    expect(screen.getByText(/USDC Main Market/)).toBeTruthy();
    expect(screen.getByTestId("menu-detail-pool-kamino_sol_main")).toBeTruthy();
  });

  it("Kamino: 6 件を超える pool は Others に畳まれる", async () => {
    await openProtocol("kamino");
    // fixture の kamino は 5 pool なので expander は出ない
    await waitFor(() =>
      expect(screen.getByTestId("menu-detail-pool-kamino_usdc_main")).toBeTruthy()
    );
    expect(screen.queryByTestId("menu-detail-others-expander")).toBeNull();
  });

  it("保有ゼロの protocol では Your Balance サマリーを出さない", async () => {
    await openProtocol("kamino");
    await waitFor(() =>
      expect(screen.getByTestId("menu-detail-pool-kamino_usdc_main")).toBeTruthy()
    );
    expect(screen.queryByTestId("menu-detail-summary")).toBeNull();
  });

  it("Exponent: read-only listing は View only バッジで CTA を出さない", async () => {
    await openProtocol("exponent");
    await waitFor(() => expect(screen.getAllByText("View only").length).toBeGreaterThan(0));
    expect(screen.queryByText("Deposit")).toBeNull();
  });

  it("単一 asset の protocol (Jito) ではフィルタチップを出さない", async () => {
    await openProtocol("jito");
    await waitFor(() => expect(screen.getByText("Deposit")).toBeTruthy());
    expect(screen.queryByTestId("menu-detail-filter-all")).toBeNull();
  });

  it("Jupiter: 従来どおり固定チップ + サマリーが出る (回帰していない)", async () => {
    await openProtocol("jupiter");
    await waitFor(() => expect(screen.getByTestId("menu-detail-summary")).toBeTruthy());
    expect(screen.getByTestId("menu-detail-filter-stable")).toBeTruthy();
    expect(screen.getByTestId("menu-detail-filter-deposited")).toBeTruthy();
  });

  it("Perena Tri-Stable: View only のまま note と protocol app への link を出す", async () => {
    const pool = fixtureMenuListings
      .find((e) => e.protocol_id === "perena")!
      .pools.find((p) => p.pool_id === "perena_tri_stable")!;
    expect(pool.note).toBeTruthy();
    expect(pool.external_url).toBeTruthy();
    const openURL = jest
      .spyOn(Linking, "openURL")
      .mockResolvedValue(true as never);

    await openProtocol("perena");
    await waitFor(() =>
      expect(screen.getByTestId("menu-detail-pool-perena_tri_stable")).toBeTruthy()
    );
    // display_only は維持 (deposit 経路なし)
    expect(screen.getByTestId("pool-viewonly-perena_tri_stable")).toBeTruthy();
    expect(screen.getByTestId("pool-note-perena_tri_stable")).toBeTruthy();
    expect(screen.getByText(pool.note!)).toBeTruthy();
    const link = screen.getByTestId("pool-link-perena_tri_stable");
    expect(screen.getByText("Open Perena ↗")).toBeTruthy();
    fireEvent.press(link);
    expect(openURL).toHaveBeenCalledWith(pool.external_url);
    openURL.mockRestore();
  });
});

/**
 * watch-only mode: 公開 address を閲覧中は deposit / withdraw の導線を止める
 * (ActionModal 側でも署名は止まるが、そもそも開かせない)
 */
describe("MenuDrawer — readOnly (watch-only mode)", () => {
  async function openJito(readOnly: boolean, onStartAction: jest.Mock) {
    render(
      wrap(
        <MenuDrawer
          visible
          onClose={() => {}}
          onStartAction={onStartAction}
          readOnly={readOnly}
          testID="menu"
        />
      )
    );
    fireEvent.press(await screen.findByTestId("menu-card-jito"));
    await waitFor(() => expect(screen.getByText("Deposit")).toBeTruthy());
    return screen.getByTestId(/^menu-detail-pool-.*-cta-deposit$/);
  }

  it("Deposit CTA は disabled、banner を出し、押しても onStartAction を呼ばない", async () => {
    const onStartAction = jest.fn();
    const cta = await openJito(true, onStartAction);
    expect(cta.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId("menu-detail-readonly")).toBeTruthy();
    fireEvent.press(cta);
    expect(onStartAction).not.toHaveBeenCalled();
  });

  it("readOnly でなければ banner は出ず、Deposit で onStartAction が呼ばれる", async () => {
    const onStartAction = jest.fn();
    const cta = await openJito(false, onStartAction);
    expect(screen.queryByTestId("menu-detail-readonly")).toBeNull();
    fireEvent.press(cta);
    expect(onStartAction).toHaveBeenCalledWith(
      "jito",
      expect.any(String),
      "deposit",
      expect.any(String)
    );
  });
});

/**
 * 2026-10-13: plans-only server (`/health` の executionTarget = "disabled") では deposit が
 * 必ず 409 になるので、Deposit CTA を "Unavailable" (disabled) にして ActionModal を開かせない
 */
describe("MenuDrawer — plans-only server (executionTarget = disabled)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("Deposit CTA は 'Unavailable' で disabled、押しても onStartAction を呼ばない", async () => {
    jest.spyOn(api, "getHealth").mockResolvedValue({
      status: "ok",
      solana: { heliusConfigured: true, executionTarget: "disabled" },
    });
    const onStartAction = jest.fn();
    render(
      wrap(
        <MenuDrawer
          visible
          onClose={() => {}}
          onStartAction={onStartAction}
          testID="menu"
        />
      )
    );
    fireEvent.press(await screen.findByTestId("menu-card-jito"));
    await waitFor(() => expect(screen.getByText("Unavailable")).toBeTruthy());
    expect(screen.queryByText("Deposit")).toBeNull();
    const cta = screen.getByTestId(/^menu-detail-pool-.*-cta-deposit$/);
    expect(cta.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(cta);
    expect(onStartAction).not.toHaveBeenCalled();
  });
});

describe("MenuDrawer — Android back (2026-10-08)", () => {
  afterEach(() => {
    mockFocused = true;
    jest.restoreAllMocks();
  });

  function backRegistrations(spy: jest.SpyInstance) {
    return spy.mock.calls.filter(([event]) => event === "hardwareBackPress");
  }

  it("Home が focus なら back を処理する (詳細 → 一覧で true を返す)", async () => {
    const spy = jest.spyOn(BackHandler, "addEventListener");
    await openProtocol("kamino");
    await waitFor(() =>
      expect(screen.getByTestId("menu-detail-pool-kamino_usdc_main")).toBeTruthy()
    );
    const regs = backRegistrations(spy);
    expect(regs.length).toBeGreaterThan(0);
    const handler = regs[regs.length - 1]![1] as () => boolean;
    expect(handler()).toBe(true);
  });

  it("Home が focus 外 (承認画面が上に積まれている) なら back を登録しない = 上の画面に届く", async () => {
    mockFocused = false;
    const spy = jest.spyOn(BackHandler, "addEventListener");
    await openProtocol("kamino");
    await waitFor(() =>
      expect(screen.getByTestId("menu-detail-pool-kamino_usdc_main")).toBeTruthy()
    );
    expect(backRegistrations(spy)).toHaveLength(0);
  });
});

describe("MenuDrawer — 保有 positions は Home と同じ wallet key で引く (Phase A-1)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("walletAddress を渡すと address 付きで取得する (Home と同 key = 追加リクエスト 0)", async () => {
    const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
    const spy = jest.spyOn(api, "getPositions");
    render(wrap(<MenuDrawer visible onClose={() => {}} walletAddress={A} testID="menu" />));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.every(([address]) => address === A)).toBe(true);
  });
});

/**
 * 2026-10-13: funding-token deposit。Jupiter Lend JupUSD は registry の funding allowlist で
 * USDC を受け付ける。underlying (JupUSD) が無く USDC だけ持つなら USDC 払いで開く
 * (asset = "USDC" + { shareMint })、JupUSD を持つなら従来どおり underlying (shareMint なし)
 */
describe("MenuDrawer — funding deposit (Jupiter Lend JupUSD)", () => {
  // lib registry から引く (mint を test に直書きしない)
  const { findMarketByProtocolAsset } = jest.requireActual(
    "@workspace/lib/config/swap-earn-markets"
  ) as typeof import("@workspace/lib/config/swap-earn-markets");
  const MARKET = findMarketByProtocolAsset("jupiter_lend", "JupUSD")!;
  const USDC_MINT = MARKET.funding![0]!.mint;

  const JUPUSD_MARKET: api.JupiterLendMarketDTO = {
    jlMint: MARKET.share_mint,
    jlSymbol: "jlJupUSD",
    jlDecimals: 6,
    underlyingMint: MARKET.underlying_mint,
    // Jupiter API は "jupUSD" 表記 (Menu の行は displayJupiterAsset で "JupUSD")
    underlyingSymbol: "jupUSD",
    underlyingDecimals: 6,
    underlyingPriceUsd: 1,
    supplyRateBps: 800,
    rewardsRateBps: 0,
    totalRateBps: 800,
    tvlUnderlying: "1000000000000",
  };

  function walletRow(symbol: string, mint: string, amount: string) {
    return {
      position_id: `helius_x_${mint}`,
      protocol_id: "wallet_stable",
      asset_symbol: symbol,
      current_amount: amount,
      raw_state: { mint, source: "helius_das", decimals: 6 },
    } as unknown as import("@workspace/lib/types").Position;
  }

  afterEach(() => jest.restoreAllMocks());

  async function tapJupUsdDeposit(
    positions: import("@workspace/lib/types").Position[],
    onStartAction: jest.Mock
  ) {
    jest.spyOn(api, "getJupiterLendMarkets").mockResolvedValue([JUPUSD_MARKET]);
    jest.spyOn(api, "getPositions").mockResolvedValue(positions);
    render(
      wrap(
        <MenuDrawer
          visible
          onClose={() => {}}
          onStartAction={onStartAction}
          testID="menu"
        />
      )
    );
    fireEvent.press(await screen.findByTestId("menu-card-jupiter"));
    const cta = await screen.findByTestId("menu-detail-vault-JupUSD-cta-deposit");
    return cta;
  }

  it("USDC だけ保有 → 'Pay with USDC' を添え、asset 'USDC' + { shareMint } で開く", async () => {
    const onStartAction = jest.fn();
    const cta = await tapJupUsdDeposit(
      [walletRow("USDC", USDC_MINT, "5000000")],
      onStartAction
    );
    await waitFor(() =>
      expect(screen.getByTestId(`pool-paywith-${MARKET.share_mint}`)).toBeTruthy()
    );
    expect(screen.getByText("Pay with USDC")).toBeTruthy();
    fireEvent.press(cta);
    expect(onStartAction).toHaveBeenCalledWith(
      "jupiter",
      "USDC",
      "deposit",
      "jl_JupUSD",
      { shareMint: MARKET.share_mint }
    );
  });

  it("JupUSD を保有 (DAS 表記 'jupUSD') → 従来どおり asset 'JupUSD'、shareMint なし、sub-label なし", async () => {
    const onStartAction = jest.fn();
    const cta = await tapJupUsdDeposit(
      [
        walletRow("jupUSD", MARKET.underlying_mint, "2000000"),
        walletRow("USDC", USDC_MINT, "5000000"),
      ],
      onStartAction
    );
    // positions 取得後も sub-label は出ない (underlying 優先)
    await waitFor(() => expect(api.getPositions).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId(`pool-paywith-${MARKET.share_mint}`)).toBeNull();
    fireEvent.press(cta);
    expect(onStartAction).toHaveBeenCalledTimes(1);
    expect(onStartAction.mock.calls[0]).toEqual([
      "jupiter",
      "JupUSD",
      "deposit",
      "jl_JupUSD",
    ]);
  });

  it("どちらも無い → 従来どおり asset 'JupUSD' で開く (ActionModal が Insufficient + hint を出す)", async () => {
    const onStartAction = jest.fn();
    const cta = await tapJupUsdDeposit([], onStartAction);
    await waitFor(() => expect(api.getPositions).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId(`pool-paywith-${MARKET.share_mint}`)).toBeNull();
    fireEvent.press(cta);
    expect(onStartAction.mock.calls[0]).toEqual([
      "jupiter",
      "JupUSD",
      "deposit",
      "jl_JupUSD",
    ]);
  });
});
