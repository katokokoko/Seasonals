/**
 * MCPApprovalPushCard — テスト
 *
 * §8.7 push tap → 専用 approval screen の表示 / WarningArea 連携 /
 * expires_at counter / approve+reject mutation を担保する。
 *
 * 注意:
 *   fake timers と TanStack Query mutation (microtask 経路) は混ぜると
 *   waitFor が無限待機になりやすいため、本ファイルは real timer のみで進める。
 *   WarningArea grayout は warningGrayoutMs={50} に短縮して real timer で待つ。
 *   expires_at counter は now() override で現在時刻を仮想化することで観察する。
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

import { MCPApprovalPushCard } from "./MCPApprovalPushCard";
import { createQueryClient } from "../../services/queryClient";
import {
  fixtureAgentPlanSimulated,
  fixtureAgentPlanSimulatedWithWarning,
  fixtureApprovalTokenActive,
  fixtureApprovalTokenExpired,
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

// ─────────────────────────────────────────────────────────────────────────────
// 基準時刻 (fixture と整合)
//
// fixtureApprovalTokenActive.expires_at = "2026-05-06T10:07:00.000Z"
// 残り 4分23秒 となる時刻 = expires_at - 263s = "2026-05-06T10:02:37.000Z"
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_EXPIRES_MS = new Date("2026-05-06T10:07:00.000Z").getTime();
const NOW_4M23S_BEFORE_EXPIRY = ACTIVE_EXPIRES_MS - (4 * 60 + 23) * 1000;

describe("MCPApprovalPushCard", () => {
  describe("expires_at counter", () => {
    it("token expires_at までの残時間を mm:ss で表示", () => {
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulated}
            token={fixtureApprovalTokenActive}
            now={() => NOW_4M23S_BEFORE_EXPIRY}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            testID="push"
          />
        )
      );
      expect(screen.getByText("Expires in 4:23")).toBeTruthy();
    });

    it("8.37 (M3): expires_at 不正 (NaN) は expired 扱い = CTA disabled (fail-closed)", () => {
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulated}
            token={{ ...fixtureApprovalTokenActive, expires_at: "not-a-date" }}
            now={() => Date.now()}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            testID="push"
          />
        )
      );
      const cta = screen.getByTestId("push-approve");
      expect(
        cta.props.accessibilityState?.disabled ?? cta.props.disabled
      ).toBeTruthy();
      // "NaN:NaN" が表示されない
      expect(screen.queryByText(/NaN/)).toBeNull();
    });

    it("expires_at 経過後は CTA disabled + 'Expired' 表示", () => {
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulated}
            token={fixtureApprovalTokenExpired}
            now={() => Date.now()}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            testID="push"
          />
        )
      );
      const cta = screen.getByTestId("push-approve");
      expect(
        cta.props.accessibilityState?.disabled ?? cta.props.disabled
      ).toBeTruthy();
      // CTA 内テキストと expires text の両方に "Expired" が出る
      expect(screen.getAllByText("Expired").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("表示内容 (selected_action / simulation_result)", () => {
    it("protocol / action_type / amount / Est. out / fee を表示", () => {
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulated}
            token={fixtureApprovalTokenActive}
            now={() => NOW_4M23S_BEFORE_EXPIRY}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            testID="push"
          />
        )
      );
      expect(screen.getByText("kamino")).toBeTruthy();
      expect(screen.getByText("re_deposit_include_yield")).toBeTruthy();
      // 1542300000 (decimals=6) → "1542.3 USDC"
      expect(screen.getByText("1542.3 USDC")).toBeTruthy();
      // estimated_out = "1672450000" → "1672.45 USDC"
      expect(screen.getByText("1672.45 USDC")).toBeTruthy();
      // estimated_fee = "120000" → "0.12 USDC"
      expect(screen.getByText("0.12 USDC")).toBeTruthy();
    });
  });

  describe("WarningArea 連携 (§4.6 / §8.5)", () => {
    it("oracle 乖離 2-5% で oracle warning が CTA 直上に表示", () => {
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulatedWithWarning}
            token={fixtureApprovalTokenActive}
            now={() => NOW_4M23S_BEFORE_EXPIRY}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            testID="push"
          />
        )
      );
      expect(screen.getByTestId("push-warning-oracle")).toBeTruthy();
      expect(screen.getByText("Price oracle anomaly detected")).toBeTruthy();
    });

    it("oracle warning がない plan では oracle area が出ない", () => {
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulated}
            token={fixtureApprovalTokenActive}
            now={() => NOW_4M23S_BEFORE_EXPIRY}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            testID="push"
          />
        )
      );
      expect(screen.queryByTestId("push-warning-oracle")).toBeNull();
    });

    it("warning ある場合、grayoutMs 経過まで CTA は disabled、経過後 enabled になり approve 可能", async () => {
      const onApproveSuccess = jest.fn();
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulatedWithWarning}
            token={fixtureApprovalTokenActive}
            now={() => NOW_4M23S_BEFORE_EXPIRY}
            warningGrayoutMs={50}
            hapticsEnabled={false}
            onApproveSuccess={onApproveSuccess}
            testID="push"
          />
        )
      );
      // 初期は disabled
      let cta = screen.getByTestId("push-approve");
      expect(
        cta.props.accessibilityState?.disabled ?? cta.props.disabled
      ).toBeTruthy();

      // grayoutMs (50ms) 経過後 enabled
      await waitFor(() => {
        cta = screen.getByTestId("push-approve");
        expect(
          cta.props.accessibilityState?.disabled ?? cta.props.disabled
        ).toBeFalsy();
      });

      fireEvent.press(cta);
      await waitFor(() =>
        expect(onApproveSuccess).toHaveBeenCalledTimes(1)
      );
      expect(onApproveSuccess.mock.calls[0]![0].status).toBe("approved");
    });
  });

  describe("CTA インタラクション", () => {
    it("warning なし plan では grayoutMs 不要で即 approve 可能", async () => {
      const onApproveSuccess = jest.fn();
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulated}
            token={fixtureApprovalTokenActive}
            now={() => NOW_4M23S_BEFORE_EXPIRY}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            onApproveSuccess={onApproveSuccess}
            testID="push"
          />
        )
      );
      fireEvent.press(screen.getByTestId("push-approve"));
      await waitFor(() =>
        expect(onApproveSuccess).toHaveBeenCalledTimes(1)
      );
    });

    it("reject タップで mutation 起動 → onRejectSuccess が rejected plan で発火", async () => {
      const onRejectSuccess = jest.fn();
      render(
        wrap(
          <MCPApprovalPushCard
            plan={fixtureAgentPlanSimulated}
            token={fixtureApprovalTokenActive}
            now={() => NOW_4M23S_BEFORE_EXPIRY}
            warningGrayoutMs={0}
            hapticsEnabled={false}
            onRejectSuccess={onRejectSuccess}
            testID="push"
          />
        )
      );
      fireEvent.press(screen.getByTestId("push-reject"));
      await waitFor(() =>
        expect(onRejectSuccess).toHaveBeenCalledTimes(1)
      );
      expect(onRejectSuccess.mock.calls[0]![0].status).toBe("rejected");
    });
  });
});
