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
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MenuDrawer } from "./MenuDrawer";
import { createQueryClient } from "../../services/queryClient";

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
});
