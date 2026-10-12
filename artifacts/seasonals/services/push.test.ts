/**
 * services/push — テスト
 *
 * expo-notifications を mock し、push wrapper の振る舞いを検証:
 * - isApprovalPushPayload (runtime type guard)
 * - getPushToken の permission flow (granted / denied)
 * - addApprovalResponseListener (notification.data の type 識別)
 * - scheduleLocalApprovalNotification の payload 形
 */

import * as Notifications from "expo-notifications";

import {
  __resetApprovalRouteGuard,
  addApprovalResponseListener,
  claimApprovalRoute,
  clearInitialApprovalResponse,
  getInitialApprovalResponse,
  getPushToken,
  isApprovalPushPayload,
  isExecutionPushPayload,
  scheduleLocalApprovalNotification,
  setupNotificationHandler,
} from "./push";
import { fixtureAgentPlanPendingUser } from "@workspace/lib/__fixtures__";

const mockedNotifications = Notifications as unknown as {
  setNotificationHandler: jest.Mock;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getExpoPushTokenAsync: jest.Mock;
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponseAsync: jest.Mock;
  clearLastNotificationResponse: jest.Mock;
  scheduleNotificationAsync: jest.Mock;
  __triggerResponse: (response: unknown) => void;
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// isApprovalPushPayload
// ─────────────────────────────────────────────────────────────────────────────

describe("isApprovalPushPayload", () => {
  it("BFF 契約の { type: approval, plan_id } (token_id なし) に true", () => {
    expect(
      isApprovalPushPayload({ type: "approval", plan_id: "plan_003" })
    ).toBe(true);
  });

  it("旧 payload (token_id 付き) も引き続き true", () => {
    expect(
      isApprovalPushPayload({
        type: "approval",
        plan_id: "plan_003",
        token_id: "tok_active_001",
      })
    ).toBe(true);
  });

  it("type が違うと false", () => {
    expect(
      isApprovalPushPayload({
        type: "info",
        plan_id: "plan_003",
        token_id: "tok_active_001",
      })
    ).toBe(false);
  });

  it("plan_id が string でない / 空、token_id が string 以外なら false", () => {
    expect(
      isApprovalPushPayload({ type: "approval", plan_id: 123, token_id: "t" })
    ).toBe(false);
    expect(isApprovalPushPayload({ type: "approval" })).toBe(false);
    expect(isApprovalPushPayload({ type: "approval", plan_id: "" })).toBe(false);
    expect(
      isApprovalPushPayload({ type: "approval", plan_id: "p", token_id: 42 })
    ).toBe(false);
  });

  it("non-object は false", () => {
    expect(isApprovalPushPayload(null)).toBe(false);
    expect(isApprovalPushPayload(undefined)).toBe(false);
    expect(isApprovalPushPayload("approval")).toBe(false);
  });
});

describe("isExecutionPushPayload (Phase 8.29)", () => {
  it("type=execution + record_id で true、approval とは排他", () => {
    expect(
      isExecutionPushPayload({
        type: "execution",
        record_id: "auto_1",
        plan_id: "p1",
        protocol: "kamino",
        action_type: "deposit",
        amount_usd8: "20.00000000",
        tx_signature: "SIG",
        status: "executed",
      })
    ).toBe(true);
    expect(isExecutionPushPayload({ type: "approval", plan_id: "p" })).toBe(false);
    expect(isExecutionPushPayload({ type: "execution" })).toBe(false); // record_id 欠落
    expect(isExecutionPushPayload(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setupNotificationHandler
// ─────────────────────────────────────────────────────────────────────────────

describe("setupNotificationHandler", () => {
  it("setNotificationHandler を呼ぶ (idempotent な複数呼出も問題なし)", () => {
    setupNotificationHandler();
    setupNotificationHandler();
    expect(mockedNotifications.setNotificationHandler).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPushToken
// ─────────────────────────────────────────────────────────────────────────────

describe("getPushToken", () => {
  it("permission granted で ExpoPushToken を返す", async () => {
    mockedNotifications.getPermissionsAsync.mockResolvedValueOnce({
      status: "granted",
    });
    mockedNotifications.getExpoPushTokenAsync.mockResolvedValueOnce({
      data: "ExponentPushToken[abc]",
    });
    const result = await getPushToken();
    expect(result.token).toBe("ExponentPushToken[abc]");
  });

  it("permission denied は throw", async () => {
    mockedNotifications.getPermissionsAsync.mockResolvedValueOnce({
      status: "denied",
    });
    mockedNotifications.requestPermissionsAsync.mockResolvedValueOnce({
      status: "denied",
    });
    await expect(getPushToken()).rejects.toThrow(
      "notification_permission_denied"
    );
  });

  it("初回 not-granted でも request で granted なら token 取得", async () => {
    mockedNotifications.getPermissionsAsync.mockResolvedValueOnce({
      status: "undetermined",
    });
    mockedNotifications.requestPermissionsAsync.mockResolvedValueOnce({
      status: "granted",
    });
    mockedNotifications.getExpoPushTokenAsync.mockResolvedValueOnce({
      data: "ExponentPushToken[after-prompt]",
    });
    const result = await getPushToken();
    expect(result.token).toBe("ExponentPushToken[after-prompt]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addApprovalResponseListener
// ─────────────────────────────────────────────────────────────────────────────

describe("addApprovalResponseListener", () => {
  it("approval payload を持つ notification 経路で handler が発火", () => {
    const handler = jest.fn();
    const sub = addApprovalResponseListener(handler);

    mockedNotifications.__triggerResponse({
      notification: {
        request: {
          content: {
            data: {
              type: "approval",
              plan_id: "plan_003",
              token_id: "tok_active_001",
            },
          },
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      type: "approval",
      plan_id: "plan_003",
      token_id: "tok_active_001",
    });

    sub.remove();
  });

  it("BFF の { type, plan_id } payload (token_id なし) でも handler が発火", () => {
    const handler = jest.fn();
    const sub = addApprovalResponseListener(handler);

    mockedNotifications.__triggerResponse({
      notification: {
        request: {
          content: { data: { type: "approval", plan_id: "plan_live_1" } },
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      type: "approval",
      plan_id: "plan_live_1",
    });
    sub.remove();
  });

  it("approval 以外の payload では handler が発火しない", () => {
    const handler = jest.fn();
    const sub = addApprovalResponseListener(handler);

    mockedNotifications.__triggerResponse({
      notification: {
        request: { content: { data: { type: "info", message: "hi" } } },
      },
    });

    expect(handler).not.toHaveBeenCalled();
    sub.remove();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getInitialApprovalResponse
// ─────────────────────────────────────────────────────────────────────────────

describe("getInitialApprovalResponse", () => {
  it("最後の notification が approval なら payload を返す", async () => {
    mockedNotifications.getLastNotificationResponseAsync.mockResolvedValueOnce(
      {
        notification: {
          request: {
            content: {
              data: {
                type: "approval",
                plan_id: "plan_003",
                token_id: "tok_active_001",
              },
            },
          },
        },
      }
    );
    const payload = await getInitialApprovalResponse();
    expect(payload?.plan_id).toBe("plan_003");
    expect(payload?.token_id).toBe("tok_active_001");
  });

  it("token_id なしの approval payload も返す (cold start)", async () => {
    mockedNotifications.getLastNotificationResponseAsync.mockResolvedValueOnce(
      {
        notification: {
          request: {
            content: { data: { type: "approval", plan_id: "plan_live_1" } },
          },
        },
      }
    );
    const payload = await getInitialApprovalResponse();
    expect(payload?.plan_id).toBe("plan_live_1");
    expect(payload?.token_id).toBeUndefined();
  });

  it("最後の notification が approval 以外なら null", async () => {
    mockedNotifications.getLastNotificationResponseAsync.mockResolvedValueOnce(
      {
        notification: {
          request: { content: { data: { type: "info" } } },
        },
      }
    );
    const payload = await getInitialApprovalResponse();
    expect(payload).toBeNull();
  });

  it("notification 履歴なしで null", async () => {
    mockedNotifications.getLastNotificationResponseAsync.mockResolvedValueOnce(
      null
    );
    const payload = await getInitialApprovalResponse();
    expect(payload).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scheduleLocalApprovalNotification
// ─────────────────────────────────────────────────────────────────────────────

describe("scheduleLocalApprovalNotification", () => {
  it("default は fixture PendingUser plan で BFF と同じ { type, plan_id } 形 (token_id なし)", async () => {
    await scheduleLocalApprovalNotification({});

    const call = mockedNotifications.scheduleNotificationAsync.mock.calls[0]![0];
    expect(call.content.data).toEqual({
      type: "approval",
      plan_id: fixtureAgentPlanPendingUser.plan_id,
      protocol: fixtureAgentPlanPendingUser.selected_action!.protocol,
      action_type: fixtureAgentPlanPendingUser.selected_action!.action_type,
    });
    expect(call.trigger).toBeNull(); // 即時発火
  });

  it("opts で plan_id / token_id を override 可能", async () => {
    await scheduleLocalApprovalNotification({
      plan_id: "plan_001",
      token_id: "tok_consumed_001",
      protocol: "marinade",
      action_type: "vote",
    });

    const call = mockedNotifications.scheduleNotificationAsync.mock.calls[0]![0];
    expect(call.content.data).toMatchObject({
      type: "approval",
      plan_id: "plan_001",
      token_id: "tok_consumed_001",
      protocol: "marinade",
      action_type: "vote",
    });
  });

  it("delaySeconds > 0 で trigger に seconds をセット", async () => {
    await scheduleLocalApprovalNotification({ delaySeconds: 10 });
    const call = mockedNotifications.scheduleNotificationAsync.mock.calls[0]![0];
    expect(call.trigger).toMatchObject({ seconds: 10 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-08: cold start response の消去 / 同じ plan への連続遷移の抑止
// ─────────────────────────────────────────────────────────────────────────────

describe("clearInitialApprovalResponse", () => {
  it("expo-notifications の clearLastNotificationResponse を呼ぶ", () => {
    clearInitialApprovalResponse();
    expect(mockedNotifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("native module が無く throw しても落ちない (guard 側で重複を防ぐ)", () => {
    mockedNotifications.clearLastNotificationResponse.mockImplementationOnce(() => {
      throw new Error("UnavailabilityError");
    });
    expect(() => clearInitialApprovalResponse()).not.toThrow();
  });
});

describe("claimApprovalRoute", () => {
  beforeEach(() => __resetApprovalRouteGuard());

  it("同じ plan への連続遷移は 2 回目を拒否する (cold + warm の二重届き)", () => {
    expect(claimApprovalRoute("plan_a", 1_000)).toBe(true);
    expect(claimApprovalRoute("plan_a", 1_500)).toBe(false);
  });

  it("別の plan は通す", () => {
    expect(claimApprovalRoute("plan_a", 1_000)).toBe(true);
    expect(claimApprovalRoute("plan_b", 1_100)).toBe(true);
    // 直前が plan_b なので plan_a は再び通る
    expect(claimApprovalRoute("plan_a", 1_200)).toBe(true);
  });

  it("時間窓 (5 秒) を過ぎた同じ plan は通す (閉じてから再度 tap)", () => {
    expect(claimApprovalRoute("plan_a", 1_000)).toBe(true);
    expect(claimApprovalRoute("plan_a", 6_000)).toBe(true);
  });
});
