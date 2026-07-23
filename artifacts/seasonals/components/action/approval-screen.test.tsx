/**
 * approval screen — Phase 8.37 (M2): token なし deep link の退避。
 * 旧実装は useApprovalToken(null) (disabled query) の isPending 永久 true で
 * 無限 Loading だった。plan 解決後に「Invalid approval link」を表示することを固定する。
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";
import {
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";

import ApprovalScreen from "../../app/approval/[planId]";
import { createQueryClient } from "../../services/queryClient";

// expo-router: params は token なし (壊れた deep link) を再現
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ planId: "plan_001" }), // fixture 実在 plan
  Stack: { Screen: () => null },
}));

function freshClient(): QueryClient {
  return createQueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("ApprovalScreen — 8.37 (M2)", () => {
  it("token なしリンクは無限 Loading にならず invalid-link 表示へ", async () => {
    render(
      <QueryClientProvider client={freshClient()}>
        <ApprovalScreen />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("approval-screen-invalid-link")).toBeTruthy();
    });
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
