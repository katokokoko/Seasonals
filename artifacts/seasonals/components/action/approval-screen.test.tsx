/**
 * approval screen — deep link の解決 (agent-plan 契約 2026-10)
 *
 * BFF の push payload は `{ type: "approval", plan_id }` だけで、approval token は
 * approve の応答で初めて発行される。したがって `/approval/<planId>` (token なし) で
 * plan を表示できなければならない (旧実装は ?token= 必須で実 plan を開けなかった)。
 * 旧形式の `?token=` も引き続き受ける。
 *
 * Phase 8.37 (M2) の「無限 Loading にしない」も維持する (planId 欠落 → invalid-link)。
 */
import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import {
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";

import ApprovalScreen from "../../app/approval/[planId]";
import { createQueryClient } from "../../services/queryClient";

// expo-router: test ごとに params を差し替える
let mockParams: { planId?: string; token?: string } = {};
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));

function freshClient(): QueryClient {
  return createQueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderScreen() {
  return render(
    <QueryClientProvider client={freshClient()}>
      <ApprovalScreen />
    </QueryClientProvider>
  );
}

describe("ApprovalScreen", () => {
  it("token なし (BFF push 形) でも plan を表示し、countdown は出さない", async () => {
    mockParams = { planId: "plan_003" }; // fixture: pending_user
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card")).toBeTruthy()
    );
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByTestId("approval-screen-invalid-link")).toBeNull();
    expect(screen.queryByTestId("approval-screen-card-expires")).toBeNull();
    const cta = screen.getByTestId("approval-screen-card-approve");
    expect(
      cta.props.accessibilityState?.disabled ?? cta.props.disabled
    ).toBeFalsy();
  });

  it("approve 後は応答の approval_token で TTL を出し、web で署名する案内を出す", async () => {
    mockParams = { planId: "plan_003" };
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card-approve")).toBeTruthy()
    );
    fireEvent.press(screen.getByTestId("approval-screen-card-approve"));

    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card-web-hint")).toBeTruthy()
    );
    expect(
      screen.getByText("Sign & send from the Seasonals web app.")
    ).toBeTruthy();
    // fixture の approve 応答は BFF と同じ TTL 300 秒の token を返す
    expect(
      screen.getByText(/^Expires in (5:00|4:5\d)$/)
    ).toBeTruthy();
    // 承認後は再 approve できない
    const cta = screen.getByTestId("approval-screen-card-approve");
    expect(
      cta.props.accessibilityState?.disabled ?? cta.props.disabled
    ).toBeTruthy();
  });

  it("旧形式 ?token= も受け、token の TTL を表示する", async () => {
    mockParams = { planId: "plan_003", token: "tok_active_001" };
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card-expires")).toBeTruthy()
    );
  });

  it("8.37 (M2): planId 欠落は無限 Loading にならず invalid-link 表示", async () => {
    mockParams = {};
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-invalid-link")).toBeTruthy()
    );
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("存在しない plan は Fetch failed (Loading のままにしない)", async () => {
    mockParams = { planId: "plan_missing" };
    renderScreen();
    await waitFor(() => expect(screen.getByText("Fetch failed")).toBeTruthy());
  });
});
