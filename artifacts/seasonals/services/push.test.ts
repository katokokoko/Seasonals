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
  addApprovalResponseListener,
  getInitialApprovalResponse,
  getPushToken,
  isApprovalPushPayload,
  scheduleLocalApprovalNotification,
  setupNotificationHandler,
} from "./push";
import {
  fixtureAgentPlanPendingUser,
  fixtureApprovalTokenActive,
} from "@workspace/lib/__fixtures__";

const mockedNotifications = Notifications as unknown as {
  setNotificationHandler: jest.Mock;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getExpoPushTokenAsync: jest.Mock;
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponseAsync: jest.Mock;
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
  it("type=approval + plan_id + token_id を持つオブジェクトに true", () => {
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

  it("plan_id / token_id が string でないと false", () => {
    expect(
      isApprovalPushPayload({ type: "approval", plan_id: 123, token_id: "t" })
    ).toBe(false);
    expect(
      isApprovalPushPayload({ type: "approval", plan_id: "p" })
    ).toBe(false);
  });

  it("non-object は false", () => {
    expect(isApprovalPushPayload(null)).toBe(false);
    expect(isApprovalPushPayload(undefined)).toBe(false);
    expect(isApprovalPushPayload("approval")).toBe(false);
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
  it("default は fixture (PendingUser plan + Active token) で payload を組む", async () => {
    await scheduleLocalApprovalNotification({});

    const call = mockedNotifications.scheduleNotificationAsync.mock.calls[0]![0];
    expect(call.content.data).toEqual({
      type: "approval",
      plan_id: fixtureAgentPlanPendingUser.plan_id,
      token_id: fixtureApprovalTokenActive.token_id,
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
