/**
 * MCPApprovalPushCard — テスト
 *
 * §8.7 push tap → 専用 approval screen の表示 / WarningArea 連携 /
 * plan の期限 (expires_at) と status 表示 / approve+reject mutation を担保する。
 *
 * 2026-10-08: approval token の TTL count-down は撤去 (web が token を再発行する)。
 * 期限は plan の 24h `expires_at` を「Valid until」で出し、過ぎたら fail-closed で止める。
 *
 * 注意:
 *   fake timers と TanStack Query mutation (microtask 経路) は混ぜると
 *   waitFor が無限待機になりやすいため、本ファイルは real timer のみで進める。
 *   WarningArea grayout は warningGrayoutMs={50} に短縮して real timer で待つ。
 *   期限判定は now() override で現在時刻を仮想化することで観察する。
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
import { Linking } from "react-native";
import { format } from "date-fns";

import { MCPApprovalPushCard, resolveDisplayStatus } from "./MCPApprovalPushCard";
import { createQueryClient } from "../../services/queryClient";
import {
  fixtureAgentPlanSimulated,
  fixtureAgentPlanSimulatedWithWarning,
} from "@workspace/lib/__fixtures__";
import {
  AgentPlanStatus,
  type AgentPlan,
  type SimulationResult,
} from "@workspace/lib/types";

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

function isDisabled(el: { props: Record<string, unknown> }): boolean {
  const state = el.props.accessibilityState as { disabled?: boolean } | undefined;
  return Boolean(state?.disabled ?? el.props.disabled);
}

// 基準時刻 (任意の固定値)。期限はここからの相対で作る
const NOW_MS = new Date("2026-10-08T03:00:00.000Z").getTime();
const now = () => NOW_MS;

function planWith(overrides: Partial<AgentPlan>): AgentPlan {
  return { ...fixtureAgentPlanSimulated, ...overrides };
}

function simWith(overrides: Partial<SimulationResult>): SimulationResult {
  return {
    simulation_id: "sim_new",
    bundle_hash: "0xnew",
    ...overrides,
  };
}

function renderCard(plan: AgentPlan, extra: Record<string, unknown> = {}) {
  return render(
    wrap(
      <MCPApprovalPushCard
        plan={plan}
        now={now}
        warningGrayoutMs={0}
        hapticsEnabled={false}
        testID="push"
        {...extra}
      />
    )
  );
}

describe("MCPApprovalPushCard", () => {
  describe("plan の期限 (expires_at)", () => {
    it("expires_at があれば local 時刻で 'Valid until' を出し、count-down は出さない", () => {
      const expiresAt = new Date(NOW_MS + 6 * 3600_000).toISOString();
      renderCard(planWith({ expires_at: expiresAt }));
      expect(screen.getByTestId("push-valid-until").props.children).toBe(
        `Valid until ${format(new Date(expiresAt), "yyyy/MM/dd HH:mm")}`
      );
      expect(screen.queryByText(/Expires in/)).toBeNull();
      expect(isDisabled(screen.getByTestId("push-approve"))).toBe(false);
    });

    it("expires_at が無ければ期限の行を出さない", () => {
      renderCard(fixtureAgentPlanSimulated);
      expect(screen.queryByTestId("push-valid-until")).toBeNull();
      expect(screen.queryByText(/Valid until/)).toBeNull();
    });

    it("expires_at を過ぎていれば status が simulated のままでも Expired で Approve / Reject を出さない (fail-closed)", () => {
      renderCard(
        planWith({ expires_at: new Date(NOW_MS - 1000).toISOString() })
      );
      expect(screen.queryByTestId("push-approve")).toBeNull();
      expect(screen.queryByTestId("push-reject")).toBeNull();
      expect(screen.getByTestId("push-status").props.children).toBe("Expired");
    });

    it("expires_at が不正 (parse 不能) は expired 扱い (fail-closed)、NaN を表示しない", () => {
      renderCard(planWith({ expires_at: "not-a-date" }));
      expect(screen.queryByTestId("push-approve")).toBeNull();
      expect(screen.getByText("Expired")).toBeTruthy();
      expect(screen.queryByText(/NaN/)).toBeNull();
    });
  });

  describe("status ごとの表示と CTA", () => {
    const sig = "5Qx9kVb2Lr7hT3mN8pW4yZ1aC6dE0fG2hJ4kL6nP8qR0sT2uV4wX6yZ8aB0cD2eF";
    const cases: Array<{
      status: AgentPlanStatus;
      line: string | null;
      cta: boolean;
      extra?: Partial<AgentPlan>;
    }> = [
      { status: AgentPlanStatus.Simulated, line: null, cta: true },
      { status: AgentPlanStatus.PendingUser, line: null, cta: true },
      {
        status: AgentPlanStatus.Approved,
        line: "Approved — sign & send from the Seasonals web app.",
        cta: false,
      },
      {
        status: AgentPlanStatus.Executing,
        line: "Being signed in the web app…",
        cta: false,
      },
      {
        status: AgentPlanStatus.Broadcasted,
        line: "Sent",
        cta: false,
        extra: {
          execution: {
            execution_id: "exe_1",
            signatures: [sig],
            submitted_at: "2026-10-08T03:00:00.000Z",
            via: "web",
          },
        },
      },
      {
        status: AgentPlanStatus.Failed,
        line: "Failed: submit_failed",
        cta: false,
        extra: { failure_reason: "submit_failed" },
      },
      { status: AgentPlanStatus.Rejected, line: "Rejected", cta: false },
      { status: AgentPlanStatus.Expired, line: "Expired", cta: false },
    ];

    it.each(cases)("$status → line=$line / cta=$cta", ({ status, line, cta, extra }) => {
      renderCard(planWith({ status, ...extra }));
      if (line === null) {
        expect(screen.queryByTestId("push-status")).toBeNull();
      } else {
        expect(screen.getByTestId("push-status").props.children).toBe(line);
      }
      if (cta) {
        expect(screen.getByTestId("push-approve")).toBeTruthy();
        expect(screen.getByTestId("push-reject")).toBeTruthy();
      } else {
        expect(screen.queryByTestId("push-approve")).toBeNull();
        expect(screen.queryByTestId("push-reject")).toBeNull();
      }
    });

    it("broadcasted は signature ごとに Solscan link (web 送信 = mainnet)", () => {
      const openURL = jest
        .spyOn(Linking, "openURL")
        .mockResolvedValue(true as never);
      renderCard(
        planWith({
          status: AgentPlanStatus.Broadcasted,
          execution: {
            execution_id: "exe_1",
            signatures: [sig, `${sig}2`],
            submitted_at: "2026-10-08T03:00:00.000Z",
            via: "web",
          },
        })
      );
      fireEvent.press(screen.getByTestId("push-signature-0"));
      expect(openURL).toHaveBeenCalledWith(`https://solscan.io/tx/${sig}`);
      fireEvent.press(screen.getByTestId("push-signature-1"));
      expect(openURL).toHaveBeenLastCalledWith(`https://solscan.io/tx/${sig}2`);
      openURL.mockRestore();
    });

    it("autonomous (devnet 送金) の signature は devnet cluster の link", () => {
      const openURL = jest
        .spyOn(Linking, "openURL")
        .mockResolvedValue(true as never);
      renderCard(
        planWith({
          status: AgentPlanStatus.Broadcasted,
          execution: {
            execution_id: "exe_2",
            signatures: [sig],
            submitted_at: "2026-10-08T03:00:00.000Z",
            via: "autonomous",
          },
        })
      );
      fireEvent.press(screen.getByTestId("push-signature-0"));
      expect(openURL).toHaveBeenCalledWith(
        `https://solscan.io/tx/${sig}?cluster=devnet`
      );
      openURL.mockRestore();
    });

    it("broadcasted / rejected は期限を過ぎていても終端の表示のまま (expired に倒さない)", () => {
      const past = new Date(NOW_MS - 1000).toISOString();
      expect(
        resolveDisplayStatus(
          planWith({ status: AgentPlanStatus.Broadcasted, expires_at: past }),
          NOW_MS,
          { approved: false, rejected: false }
        )
      ).toBe(AgentPlanStatus.Broadcasted);
      expect(
        resolveDisplayStatus(
          planWith({ status: AgentPlanStatus.Approved, expires_at: past }),
          NOW_MS,
          { approved: false, rejected: false }
        )
      ).toBe(AgentPlanStatus.Expired);
    });
  });

  describe("表示内容 (selected_action / simulation_result)", () => {
    it("旧形式 (fixture plan_002) は従来どおり入力 asset の単位で Est. out / fee を出す", () => {
      renderCard(fixtureAgentPlanSimulated);
      expect(screen.getByText("kamino")).toBeTruthy();
      expect(screen.getByText("re_deposit_include_yield")).toBeTruthy();
      // 1542300000 (decimals=6) → "1542.3 USDC"
      expect(screen.getByText("1542.3 USDC")).toBeTruthy();
      // estimated_out = "1672450000" → "1672.45 USDC"
      expect(screen.getByTestId("push-estimated-out").props.children).toBe(
        "1672.45 USDC"
      );
      // estimated_fee = "120000" → "0.12 USDC"
      expect(screen.getByTestId("push-fee").props.children).toBe("0.12 USDC");
      expect(screen.queryByTestId("push-sim-warnings")).toBeNull();
    });

    it("新形式の quote は受け取り token の単位で '≈' 付き、fee は '—'", () => {
      renderCard(
        planWith({
          selected_action: {
            wallet_id: "wal_001",
            action_type: fixtureAgentPlanSimulated.selected_action!.action_type,
            protocol: "jupiter",
            asset: "USDC",
            amount: "1000000",
          },
          simulation_result: simWith({
            estimate_kind: "quote",
            estimated_out: "940000",
            estimated_out_symbol: "jlUSDC",
            estimated_out_decimals: 6,
            min_out: "935300",
          }),
        })
      );
      expect(screen.getByTestId("push-estimated-out").props.children).toBe(
        "≈ 0.94 jlUSDC"
      );
      expect(screen.getByTestId("push-fee").props.children).toBe("—");
    });

    it("failure_reason は out 行に文で出す", () => {
      renderCard(
        planWith({
          simulation_result: simWith({
            estimate_kind: "none",
            failure_reason: "quote_unavailable",
          }),
        })
      );
      expect(screen.getByTestId("push-estimated-out").props.children).toBe(
        "Quote unavailable"
      );
      expect(screen.getByTestId("push-fee").props.children).toBe("—");
    });

    it("simulate の warnings は muted な 1 行 (oracle の WarningArea には載せない)", () => {
      renderCard(
        planWith({
          simulation_result: simWith({
            estimate_kind: "quote",
            estimated_out: "940000",
            estimated_out_symbol: "jlUSDC",
            estimated_out_decimals: 6,
            warnings: ["fair_value_unavailable", "deposit_unavailable"],
          }),
        })
      );
      expect(screen.getByTestId("push-sim-warnings").props.children).toBe(
        "Couldn't verify the redemption value · Deposits are paused for this market"
      );
      expect(screen.queryByTestId("push-warning-oracle")).toBeNull();
    });
  });

  describe("WarningArea 連携 (§4.6 / §8.5)", () => {
    it("oracle 乖離 2-5% で oracle warning が CTA 直上に表示", () => {
      renderCard(fixtureAgentPlanSimulatedWithWarning);
      expect(screen.getByTestId("push-warning-oracle")).toBeTruthy();
      expect(screen.getByText("Price oracle anomaly detected")).toBeTruthy();
    });

    it("oracle warning がない plan では oracle area が出ない", () => {
      renderCard(fixtureAgentPlanSimulated);
      expect(screen.queryByTestId("push-warning-oracle")).toBeNull();
    });

    it("warning ある場合、grayoutMs 経過まで CTA は disabled、経過後 enabled になり approve 可能", async () => {
      const onApproveSuccess = jest.fn();
      renderCard(fixtureAgentPlanSimulatedWithWarning, {
        warningGrayoutMs: 50,
        onApproveSuccess,
      });
      // 初期は disabled
      let cta = screen.getByTestId("push-approve");
      expect(isDisabled(cta)).toBe(true);

      // grayoutMs (50ms) 経過後 enabled
      await waitFor(() => {
        cta = screen.getByTestId("push-approve");
        expect(isDisabled(cta)).toBe(false);
      });

      fireEvent.press(cta);
      await waitFor(() => expect(onApproveSuccess).toHaveBeenCalledTimes(1));
      expect(onApproveSuccess.mock.calls[0]![0].status).toBe("approved");
    });
  });

  describe("CTA インタラクション", () => {
    it("warning なし plan では grayoutMs 不要で即 approve 可能", async () => {
      const onApproveSuccess = jest.fn();
      renderCard(fixtureAgentPlanSimulated, { onApproveSuccess });
      expect(screen.getByText("Approve")).toBeTruthy();
      // 承認前は状態の行を出さない
      expect(screen.queryByTestId("push-status")).toBeNull();
      fireEvent.press(screen.getByTestId("push-approve"));
      await waitFor(() => expect(onApproveSuccess).toHaveBeenCalledTimes(1));
    });

    it("approve 成功で (refetch 前でも) approved の行を出し、Approve / Reject を消す", async () => {
      const onApproveSuccess = jest.fn();
      // plan prop は simulated のまま (親の refetch が追いついていない状態)
      renderCard(fixtureAgentPlanSimulated, { onApproveSuccess });
      fireEvent.press(screen.getByTestId("push-approve"));
      await waitFor(() => expect(onApproveSuccess).toHaveBeenCalledTimes(1));
      // 契約: 応答は { ...plan, approval_token }
      const result = onApproveSuccess.mock.calls[0]![0];
      expect(result.status).toBe("approved");
      expect(result.approval_token?.plan_id).toBe(fixtureAgentPlanSimulated.plan_id);

      await waitFor(() =>
        expect(screen.getByTestId("push-status").props.children).toBe(
          "Approved — sign & send from the Seasonals web app."
        )
      );
      expect(screen.queryByTestId("push-approve")).toBeNull();
      expect(screen.queryByTestId("push-reject")).toBeNull();
      // token の TTL は出さない
      expect(screen.queryByText(/Expires in/)).toBeNull();
    });

    it("reject タップで mutation 起動 → onRejectSuccess が rejected plan で発火し、Rejected を出す", async () => {
      const onRejectSuccess = jest.fn();
      renderCard(fixtureAgentPlanSimulated, { onRejectSuccess });
      fireEvent.press(screen.getByTestId("push-reject"));
      await waitFor(() => expect(onRejectSuccess).toHaveBeenCalledTimes(1));
      expect(onRejectSuccess.mock.calls[0]![0].status).toBe("rejected");
      await waitFor(() =>
        expect(screen.getByTestId("push-status").props.children).toBe("Rejected")
      );
      expect(screen.queryByTestId("push-approve")).toBeNull();
    });
  });
});
