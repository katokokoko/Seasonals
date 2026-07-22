/**
 * prefs store — 液体演出設定の永続化 (Phase 8.36)。AsyncStorage は jest.setup の
 * in-memory mock。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { usePrefsStore } from "./prefs";

describe("usePrefsStore", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    usePrefsStore.setState({ liquidEffect: true });
  });

  it("default は on", () => {
    expect(usePrefsStore.getState().liquidEffect).toBe(true);
  });

  it("setLiquidEffect(false) が state と AsyncStorage に反映される", async () => {
    usePrefsStore.getState().setLiquidEffect(false);
    expect(usePrefsStore.getState().liquidEffect).toBe(false);
    // fire-and-forget 書込を待つ
    await new Promise((r) => setTimeout(r, 0));
    expect(await AsyncStorage.getItem("prefs:liquidEffect")).toBe("0");
  });

  it("hydrate が保存値を復元する ('0' → off)", async () => {
    await AsyncStorage.setItem("prefs:liquidEffect", "0");
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().liquidEffect).toBe(false);
  });

  it("保存値なしなら hydrate は default (on) を維持", async () => {
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().liquidEffect).toBe(true);
  });
});
