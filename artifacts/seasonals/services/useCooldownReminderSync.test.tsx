/**
 * useCooldownReminderSync: cold start の wallet 復元前 (null) は切断ではない / 接続後の null は切断
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { renderHook, waitFor } from "@testing-library/react-native";

import { FIXTURE_SKR_WALLET, fixtureCooldownStateCoolingDown } from "@workspace/lib/__fixtures__";

import { viewOf } from "../components/portfolio/cooldown-test-utils";
import {
  COOLDOWN_REMINDER_STORE_KEY,
  __resetCooldownReminderStateForTest,
  buildCooldownReminderPayload,
  deliverCooldownReminderTap,
} from "./cooldown-reminder";
import { useCooldownReminderSync } from "./useCooldownReminderSync";
import type { SkrStakingView } from "./useSkrStakingView";

const N = Notifications as unknown as {
  scheduleNotificationAsync: jest.Mock;
  cancelScheduledNotificationAsync: jest.Mock;
};

const disconnected: SkrStakingView = { ...viewOf(undefined, "loading"), address: null, scope: null };

beforeEach(async () => {
  __resetCooldownReminderStateForTest();
  await AsyncStorage.clear();
  jest.clearAllMocks();
  N.scheduleNotificationAsync.mockResolvedValue("notif_1");
});

describe("useCooldownReminderSync", () => {
  it("cold start の null では保存済み予約を取消さない", async () => {
    await AsyncStorage.setItem(
      COOLDOWN_REMINDER_STORE_KEY,
      JSON.stringify({ notificationId: "kept", scopeKey: `live|mainnet-beta|${FIXTURE_SKR_WALLET}`, scheduleKey: "k" })
    );
    renderHook(() => useCooldownReminderSync(disconnected));
    await new Promise((r) => setTimeout(r, 10));
    expect(N.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(COOLDOWN_REMINDER_STORE_KEY)).not.toBeNull();
  });

  it("過去の予定は予約しない / 接続後の切断で保存済み予約を取消す", async () => {
    const { rerender } = renderHook(({ v }: { v: SkrStakingView }) => useCooldownReminderSync(v), {
      initialProps: { v: viewOf(fixtureCooldownStateCoolingDown, "fresh") },
    });
    // fixture の終了予定は過去 (2026-09-22) なので遡って予約しない
    await new Promise((r) => setTimeout(r, 10));
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();

    await AsyncStorage.setItem(
      COOLDOWN_REMINDER_STORE_KEY,
      JSON.stringify({ notificationId: "old", scopeKey: `live|mainnet-beta|${FIXTURE_SKR_WALLET}`, scheduleKey: "k" })
    );
    rerender({ v: disconnected });
    await waitFor(() => expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith("old"));
  });

  it("tap は scope が一致する時だけ再取得する", async () => {
    const refetch = jest.fn(async () => undefined);
    renderHook(() => useCooldownReminderSync(viewOf(fixtureCooldownStateCoolingDown, "fresh", { refetch })));
    const payload = buildCooldownReminderPayload(fixtureCooldownStateCoolingDown, fixtureCooldownStateCoolingDown.events[0]!);
    deliverCooldownReminderTap(payload);
    deliverCooldownReminderTap({ ...payload, wallet_address: "9hQpJ4xRwY7nKsT2bGvCmHdEq6jPzN5fLrXk3aBoMyVc" });
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
