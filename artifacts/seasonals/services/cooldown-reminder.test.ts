/**
 * R0-08 端末の確認通知 (docs/skr-r0-implementation.md §5)
 * - t1 → t2 観測で旧予約取消・新予約 1 件、同じ予定は 1 件のまま
 * - pending = 0 / scope 切替 / 切断で旧予約 0 件、stale では触らない、過去の予定は遡って発火しない
 * - payload は許可 9 欄だけ。不正 / 別 scope の payload は表示・再取得しない。古い tap は再取得
 * - 全ケースで署名 0 件
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";

import {
  FIXTURE_SKR_WALLET,
  FIXTURE_SKR_SHARES,
  FIXTURE_SKR_UNSTAKE_TS_COOLING,
  fixtureCooldownDeriveInput,
  fixtureCooldownLiquid,
  fixtureCooldownStateCoolingDown,
  fixtureCooldownStateNone,
  fixtureCooldownStateUnavailable,
} from "@workspace/lib/__fixtures__";
import { freshCooldownState, type CooldownScopeIdentity } from "@workspace/lib/derive/cooldown-position";
import { COOLDOWN_REMINDER_PAYLOAD_KEYS, type CooldownReminderPayload } from "@workspace/lib/types";

import {
  COOLDOWN_CHANNEL_ID,
  COOLDOWN_REMINDER_BODY,
  COOLDOWN_REMINDER_STORE_KEY,
  __resetCooldownReminderStateForTest,
  addCooldownReminderResponseListener,
  buildCooldownReminderPayload,
  deliverCooldownReminderTap,
  getInitialCooldownReminderResponse,
  handleCooldownReminderTap,
  onCooldownReminderTap,
  reconcileCooldownRemindersOnStartup,
  setActiveCooldownScope,
  shouldPresentNotificationData,
  syncCooldownReminder,
} from "./cooldown-reminder";

jest.mock("./mwa", () => ({
  signTransactions: jest.fn(),
  signAndSendTransactions: jest.fn(),
  signMessages: jest.fn(),
}));

const N = Notifications as unknown as {
  scheduleNotificationAsync: jest.Mock;
  cancelScheduledNotificationAsync: jest.Mock;
  getAllScheduledNotificationsAsync: jest.Mock;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getLastNotificationResponseAsync: jest.Mock;
  __triggerResponse: (r: unknown) => void;
};

const SCOPE: CooldownScopeIdentity = { source: "live", cluster: "mainnet-beta", wallet_address: FIXTURE_SKR_WALLET };
const OTHER_SCOPE: CooldownScopeIdentity = { ...SCOPE, wallet_address: "9hQpJ4xRwY7nKsT2bGvCmHdEq6jPzN5fLrXk3aBoMyVc" };
/** fixture の観測時刻 (終了予定の 47 時間前) */
const NOW = Date.parse(fixtureCooldownStateCoolingDown.observed_at!);

const t1 = fixtureCooldownStateCoolingDown;
/** 追加解除: 1 時間後に timestamp 更新 → 同じ id、新しい revision / triggerAt */
const t2 = freshCooldownState(
  fixtureCooldownDeriveInput({
    user: {
      shares: FIXTURE_SKR_SHARES,
      pending_amount: "400000000",
      unstake_timestamp: (BigInt(FIXTURE_SKR_UNSTAKE_TS_COOLING) + 3600n).toString(),
    },
  }),
  fixtureCooldownLiquid
);

let nextId = 0;

beforeEach(async () => {
  __resetCooldownReminderStateForTest();
  await AsyncStorage.clear();
  jest.clearAllMocks();
  nextId = 0;
  N.scheduleNotificationAsync.mockImplementation(async () => `notif_${++nextId}`);
  N.getPermissionsAsync.mockResolvedValue({ status: "granted" });
  N.getAllScheduledNotificationsAsync.mockResolvedValue([]);
});

afterEach(() => {
  const mwa = jest.requireMock("./mwa") as Record<string, jest.Mock>;
  for (const fn of Object.values(mwa)) expect(fn).not.toHaveBeenCalled(); // 全ケース署名 0 件
});

async function stored(): Promise<{ notificationId: string; scheduleKey: string } | null> {
  const raw = await AsyncStorage.getItem(COOLDOWN_REMINDER_STORE_KEY);
  return raw ? JSON.parse(raw) : null;
}

describe("予約の同期", () => {
  it("fresh: 終了予定に DATE trigger で 1 件、payload は許可 9 欄だけ", async () => {
    expect(await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW })).toBe("scheduled");
    expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const req = N.scheduleNotificationAsync.mock.calls[0]![0];
    expect(req.trigger).toEqual({
      type: "date",
      date: new Date(t1.events[0]!.event.triggerAt),
      channelId: COOLDOWN_CHANNEL_ID,
    });
    expect(req.content.body).toBe(COOLDOWN_REMINDER_BODY);
    expect(req.content.body).toBe("SKRの引き出し状況を確認してください");
    expect(Object.keys(req.content.data).sort()).toEqual([...COOLDOWN_REMINDER_PAYLOAD_KEYS].sort());
    expect(JSON.stringify(req.content)).not.toMatch(/250|ready|https?:|plan|token/i);
    expect((await stored())?.notificationId).toBe("notif_1");
  });

  it("同じ予定なら何度同期しても 1 件のまま", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    expect(await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW + 300_000 })).toBe("kept");
    expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(N.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it("並行して呼ばれても二重予約しない", async () => {
    await Promise.all([
      syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW }),
      syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW }),
    ]);
    expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it("t1 → t2 (追加解除): 旧予約を取消して新しい 1 件", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    expect(await syncCooldownReminder({ scope: SCOPE, state: t2, freshness: "fresh", nowMs: NOW })).toBe("scheduled");
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith("notif_1");
    expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    expect(N.scheduleNotificationAsync.mock.calls[1]![0].trigger.date).toEqual(new Date(t2.events[0]!.event.triggerAt));
    expect((await stored())?.notificationId).toBe("notif_2");
  });

  it("正常な pending = 0 で取消、保存値も消す", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    expect(await syncCooldownReminder({ scope: SCOPE, state: fixtureCooldownStateNone, freshness: "fresh", nowMs: NOW })).toBe("cancelled");
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith("notif_1");
    expect(await stored()).toBeNull();
  });

  it("wallet 切替は鮮度に関係なく旧予約を取消す", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    expect(await syncCooldownReminder({ scope: OTHER_SCOPE, state: undefined, freshness: "loading", nowMs: NOW })).toBe("cancelled");
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith("notif_1");
    expect(await stored()).toBeNull();
  });

  it("切断で旧予約を取消す", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    expect(await syncCooldownReminder({ scope: null, state: undefined, freshness: "loading", nowMs: NOW })).toBe("cancelled");
    expect(await stored()).toBeNull();
  });

  it("stale / unavailable では予約を変えない (取消済みと解釈しない)", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    jest.clearAllMocks();
    expect(await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "stale", nowMs: NOW })).toBe("not_fresh");
    expect(await syncCooldownReminder({ scope: SCOPE, state: fixtureCooldownStateUnavailable, freshness: "unavailable", nowMs: NOW })).toBe("not_fresh");
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(N.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect((await stored())?.notificationId).toBe("notif_1");
  });

  it("過去の予定を初めて検出しても遡って通知しない", async () => {
    const after = Date.parse(t1.events[0]!.event.triggerAt) + 1;
    expect(await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: after })).toBe("past");
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it("permission 拒否なら予約しない (Calendar 側は影響なし)", async () => {
    N.getPermissionsAsync.mockResolvedValue({ status: "denied" });
    N.requestPermissionsAsync.mockResolvedValue({ status: "denied" });
    expect(await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW })).toBe("permission_denied");
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
    // poll ごとに permission を尋ね直さない
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});

describe("起動時の照合", () => {
  it("OS に残った孤児の cooldown 予約を取消し、他の通知には触らない", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    N.getAllScheduledNotificationsAsync.mockResolvedValue([
      { identifier: "notif_1", content: { data: { type: "cooldown_reminder" } } },
      { identifier: "orphan", content: { data: { type: "cooldown_reminder" } } },
      { identifier: "approval_x", content: { data: { type: "approval" } } },
    ]);
    jest.clearAllMocks();
    await reconcileCooldownRemindersOnStartup();
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith("orphan");
    expect((await stored())?.notificationId).toBe("notif_1");
  });

  it("保存値の予約が OS に無ければ (発火済み / OS が消した) 保存値を消す", async () => {
    await syncCooldownReminder({ scope: SCOPE, state: t1, freshness: "fresh", nowMs: NOW });
    N.getAllScheduledNotificationsAsync.mockResolvedValue([]);
    await reconcileCooldownRemindersOnStartup();
    expect(await stored()).toBeNull();
  });
});

describe("表示と tap", () => {
  const payload: CooldownReminderPayload = buildCooldownReminderPayload(t1, t1.events[0]!);

  it("foreground 表示: 現在の scope の cooldown 通知だけ出す。他種の通知は従来どおり", () => {
    setActiveCooldownScope(SCOPE);
    expect(shouldPresentNotificationData(payload)).toBe(true);
    expect(shouldPresentNotificationData({ ...payload, wallet_address: OTHER_SCOPE.wallet_address })).toBe(false);
    expect(shouldPresentNotificationData({ type: "cooldown_reminder", event_id: "x" })).toBe(false);
    expect(shouldPresentNotificationData({ type: "approval", plan_id: "p" })).toBe(true);
    expect(shouldPresentNotificationData(undefined)).toBe(true);
    setActiveCooldownScope(null);
    expect(shouldPresentNotificationData(payload)).toBe(false);
  });

  it("tap: scope が一致すれば再取得 (古い予定の tap でも最新 read で解決)、違えば何もしない", () => {
    const refetch = jest.fn(async () => undefined);
    const stale = { ...payload, schedule_revision: "v1:1:172800" };
    expect(handleCooldownReminderTap(stale, SCOPE, refetch)).toBe("refetched");
    expect(handleCooldownReminderTap(payload, OTHER_SCOPE, refetch)).toBe("ignored");
    expect(handleCooldownReminderTap(payload, null, refetch)).toBe("ignored");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("warm listener は不正な payload を渡さない", () => {
    const handler = jest.fn();
    const sub = addCooldownReminderResponseListener(handler);
    N.__triggerResponse({ notification: { request: { content: { data: { type: "cooldown_reminder", event_id: "x" } } } } });
    N.__triggerResponse({ notification: { request: { content: { data: payload } } } });
    sub.remove();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("cold start の tap も同じ形で取り出す (不正なら null)", async () => {
    N.getLastNotificationResponseAsync.mockResolvedValueOnce({ notification: { request: { content: { data: payload } } } });
    expect(await getInitialCooldownReminderResponse()).toEqual(payload);
    N.getLastNotificationResponseAsync.mockResolvedValueOnce({ notification: { request: { content: { data: { type: "approval" } } } } });
    expect(await getInitialCooldownReminderResponse()).toBeNull();
  });

  it("HomeScreen の mount 前に届いた tap は mount 時に渡す (cold start)", () => {
    deliverCooldownReminderTap(payload);
    const listener = jest.fn();
    const off = onCooldownReminderTap(listener);
    expect(listener).toHaveBeenCalledWith(payload);
    deliverCooldownReminderTap(payload);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
