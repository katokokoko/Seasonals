/**
 * MCPClientApprovalCard — テスト
 *
 * §8.6 inline approval card の表示 / approve mutation 起動 / oracle indicator を担保。
 */

import React, { type ReactNode } from "react";
import {
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";

import { MCPClientApprovalCard } from "./MCPClientApprovalCard";
import { createQueryClient } from "../../services/queryClient";
import {
  fixtureAgentPlanDraft,
  fixtureAgentPlanSimulated,
  fixtureAgentPlanSimulatedWithWarning,
} from "@workspace/lib/__fixtures__";

function freshClient(): QueryClient {
  return createQueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function wrap(ui: ReactNode, client = freshClient()) {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe("MCPClientApprovalCard", () => {
  describe("表示", () => {
    it("protocol / action_type / amount / APY を fixture 通りに表示", () => {
      render(
        wrap(
          <MCPClientApprovalCard
            plan={fixtureAgentPlanSimulated}
            testID="card"
          />
        )
      );
      expect(screen.getByText("kamino")).toBeTruthy();
      expect(screen.getByText("re_deposit_include_yield")).toBeTruthy();
      // 1542300000 (smallest, decimals=6) → "1542.3 USDC"
      expect(screen.getByText("1542.3 USDC")).toBeTruthy();
      // candidate.estimated_apy = 0.0842 → "8.42%"
      expect(screen.getByText("8.42%")).toBeTruthy();
    });

    it("oracle 乖離 2-5% で warning indicator が表示される", () => {
      render(
        wrap(
          <MCPClientApprovalCard
            plan={fixtureAgentPlanSimulatedWithWarning}
            testID="card"
          />
        )
      );
      expect(screen.getByTestId("card-oracle-indicator")).toBeTruthy();
      expect(screen.getByText("oracle 乖離 3.4%")).toBeTruthy();
    });

    it("oracle 乖離なし plan では indicator は出ない", () => {
      render(
        wrap(
          <MCPClientApprovalCard
            plan={fixtureAgentPlanSimulated}
            testID="card"
          />
        )
      );
      expect(screen.queryByTestId("card-oracle-indicator")).toBeNull();
    });
  });

  describe("CTA disabled 条件 (§11.7 status 遷移)", () => {
    it("status=draft では approve CTA は disabled", () => {
      render(
        wrap(
          <MCPClientApprovalCard
            plan={fixtureAgentPlanDraft}
            testID="card"
          />
        )
      );
      const cta = screen.getByTestId("card-approve");
      expect(
        cta.props.accessibilityState?.disabled ?? cta.props.disabled
      ).toBeTruthy();
    });

    it("status=simulated / pending_user では approve CTA は enabled", () => {
      render(
        wrap(
          <MCPClientApprovalCard
            plan={fixtureAgentPlanSimulated}
            testID="card"
          />
        )
      );
      const cta = screen.getByTestId("card-approve");
      expect(
        cta.props.accessibilityState?.disabled ?? cta.props.disabled
      ).toBeFalsy();
    });
  });

  describe("CTA インタラクション", () => {
    it("approve タップで mutation 起動 → onApproveSuccess が approved plan で発火", async () => {
      const onApproveSuccess = jest.fn();
      render(
        wrap(
          <MCPClientApprovalCard
            plan={fixtureAgentPlanSimulated}
            onApproveSuccess={onApproveSuccess}
            testID="card"
          />
        )
      );

      fireEvent.press(screen.getByTestId("card-approve"));
      await waitFor(() =>
        expect(onApproveSuccess).toHaveBeenCalledTimes(1)
      );
      const updated = onApproveSuccess.mock.calls[0]![0];
      expect(updated.plan_id).toBe(fixtureAgentPlanSimulated.plan_id);
      expect(updated.status).toBe("approved");
    });

    it("詳細 CTA タップで onPressDetail callback が発火", () => {
      const onPressDetail = jest.fn();
      render(
        wrap(
          <MCPClientApprovalCard
            plan={fixtureAgentPlanSimulated}
            onPressDetail={onPressDetail}
            testID="card"
          />
        )
      );
      fireEvent.press(screen.getByTestId("card-detail"));
      expect(onPressDetail).toHaveBeenCalledTimes(1);
    });
  });
});
