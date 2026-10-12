/**
 * approval screen — deep link の解決 (agent-plan 契約 2026-10)
 *
 * BFF の push payload は `{ type: "approval", plan_id }` だけで、approval token は
 * approve の応答で初めて発行される。したがって `/approval/<planId>` (token なし) で
 * plan を表示できなければならない (旧実装は ?token= 必須で実 plan を開けなかった)。
 * 旧形式の `?token=` も URL としては受ける (2026-10-08 から count-down には使わない)。
 *
 * 2026-10-08: ✕ で閉じられる (戻れなかった実機の不具合)、plan の期限 (Valid until)、
 * status ごとの表示と CTA。
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
import { fixtureAgentPlanPendingUser } from "@workspace/lib/__fixtures__";
import { AgentPlanStatus, type AgentPlan } from "@workspace/lib/types";

import ApprovalScreen from "../../app/approval/[planId]";
import { createQueryClient } from "../../services/queryClient";
import * as api from "../../services/api";

// expo-router: test ごとに params / router を差し替える
let mockParams: { planId?: string; token?: string } = {};
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => mockCanGoBack,
  }),
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

function isDisabled(el: { props: Record<string, unknown> }): boolean {
  const state = el.props.accessibilityState as { disabled?: boolean } | undefined;
  return Boolean(state?.disabled ?? el.props.disabled);
}

/** getAgentPlan の応答を差し替える (fixture に無い status / expires_at を作る) */
function serve(plan: AgentPlan) {
  mockParams = { planId: plan.plan_id };
  return jest.spyOn(api, "getAgentPlan").mockResolvedValue(plan);
}

afterEach(() => {
  jest.restoreAllMocks();
  mockBack.mockClear();
  mockReplace.mockClear();
  mockCanGoBack = true;
});

describe("ApprovalScreen", () => {
  it("token なし (BFF push 形) でも plan を表示し、count-down は出さない", async () => {
    mockParams = { planId: "plan_003" }; // fixture: pending_user
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card")).toBeTruthy()
    );
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByTestId("approval-screen-invalid-link")).toBeNull();
    expect(screen.queryByText(/Expires in/)).toBeNull();
    expect(isDisabled(screen.getByTestId("approval-screen-card-approve"))).toBe(false);
  });

  it("approve 後は web で署名する案内を出し、Approve / Reject を消す (token の TTL は出さない)", async () => {
    mockParams = { planId: "plan_003" };
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card-approve")).toBeTruthy()
    );
    fireEvent.press(screen.getByTestId("approval-screen-card-approve"));

    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card-status").props.children).toBe(
        "Approved — sign & send from the Seasonals web app."
      )
    );
    expect(screen.queryByText(/Expires in/)).toBeNull();
    expect(screen.queryByTestId("approval-screen-card-approve")).toBeNull();
    expect(screen.queryByTestId("approval-screen-card-reject")).toBeNull();
  });

  it("旧形式 ?token= も受けて plan を表示する (token は fetch せず count-down もしない)", async () => {
    const tokenSpy = jest.spyOn(api, "getApprovalToken");
    mockParams = { planId: "plan_003", token: "tok_active_001" };
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card")).toBeTruthy()
    );
    expect(tokenSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Expires in/)).toBeNull();
  });

  it("token の無い plan でも expires_at があれば 'Valid until' を出す", async () => {
    serve({
      ...fixtureAgentPlanPendingUser,
      expires_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
    });
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card-valid-until")).toBeTruthy()
    );
    expect(
      screen.getByTestId("approval-screen-card-valid-until").props.children
    ).toMatch(/^Valid until \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(screen.getByTestId("approval-screen-card-approve")).toBeTruthy();
  });

  it("expires_at を過ぎた plan は status が pending_user でも Approve を出さず Expired", async () => {
    serve({
      ...fixtureAgentPlanPendingUser,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card-status").props.children).toBe(
        "Expired"
      )
    );
    expect(screen.queryByTestId("approval-screen-card-approve")).toBeNull();
    expect(screen.queryByTestId("approval-screen-card-reject")).toBeNull();
  });

  it.each([
    [AgentPlanStatus.PendingUser, null, true],
    [AgentPlanStatus.Simulated, null, true],
    [AgentPlanStatus.Approved, "Approved — sign & send from the Seasonals web app.", false],
    [AgentPlanStatus.Executing, "Being signed in the web app…", false],
    [AgentPlanStatus.Broadcasted, "Sent", false],
    [AgentPlanStatus.Failed, "Failed: user_cancelled", false],
    [AgentPlanStatus.Rejected, "Rejected", false],
    [AgentPlanStatus.Expired, "Expired", false],
  ] as const)("status %s → 表示 %p / CTA %p", async (status, line, cta) => {
    serve({
      ...fixtureAgentPlanPendingUser,
      plan_id: `plan_${status}`,
      status,
      ...(status === AgentPlanStatus.Failed ? { failure_reason: "user_cancelled" } : {}),
    });
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("approval-screen-card")).toBeTruthy()
    );
    if (line === null) {
      expect(screen.queryByTestId("approval-screen-card-status")).toBeNull();
    } else {
      expect(screen.getByTestId("approval-screen-card-status").props.children).toBe(line);
    }
    if (cta) {
      expect(screen.getByTestId("approval-screen-card-approve")).toBeTruthy();
      expect(screen.getByTestId("approval-screen-card-reject")).toBeTruthy();
    } else {
      expect(screen.queryByTestId("approval-screen-card-approve")).toBeNull();
      expect(screen.queryByTestId("approval-screen-card-reject")).toBeNull();
    }
  });

  describe("✕ (close)", () => {
    it("戻れる履歴があれば router.back()", async () => {
      mockParams = { planId: "plan_003" };
      mockCanGoBack = true;
      renderScreen();
      const close = screen.getByTestId("approval-screen-close");
      expect(close.props.accessibilityLabel).toBe("Close");
      fireEvent.press(close);
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it("履歴が無い (cold start の deep link) なら Home へ replace", async () => {
      mockParams = { planId: "plan_003" };
      mockCanGoBack = false;
      renderScreen();
      fireEvent.press(screen.getByTestId("approval-screen-close"));
      expect(mockReplace).toHaveBeenCalledWith("/");
      expect(mockBack).not.toHaveBeenCalled();
    });

    it("planId 欠落の画面でも ✕ で閉じられる", async () => {
      mockParams = {};
      mockCanGoBack = false;
      renderScreen();
      await waitFor(() =>
        expect(screen.getByTestId("approval-screen-invalid-link")).toBeTruthy()
      );
      fireEvent.press(screen.getByTestId("approval-screen-close"));
      expect(mockReplace).toHaveBeenCalledWith("/");
    });
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
