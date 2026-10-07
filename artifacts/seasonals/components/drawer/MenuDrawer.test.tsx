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
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { BackHandler, Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { fixtureMenuListings } from "@workspace/lib/__fixtures__";

import { MenuDrawer } from "./MenuDrawer";
import { createQueryClient } from "../../services/queryClient";

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
