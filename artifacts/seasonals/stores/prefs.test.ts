/**
 * prefs store — 液体演出設定の永続化 (Phase 8.36)。AsyncStorage は jest.setup の
 * in-memory mock。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { usePrefsStore } from "./prefs";

describe("usePrefsStore", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    usePrefsStore.setState({ liquidEffect: true, glassHighlights: true });
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

  // 8.40: glassHighlights (グラスのハイライト個別 on/off)
  it("glassHighlights: default on / set が state + AsyncStorage に反映", async () => {
    expect(usePrefsStore.getState().glassHighlights).toBe(true);
    usePrefsStore.getState().setGlassHighlights(false);
    expect(usePrefsStore.getState().glassHighlights).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(await AsyncStorage.getItem("prefs:glassHighlights")).toBe("0");
  });

  it("glassHighlights: hydrate が両キーを独立に復元する", async () => {
    await AsyncStorage.setItem("prefs:glassHighlights", "0");
    // liquidEffect 側は未保存 → default 維持のまま glassHighlights だけ off
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().liquidEffect).toBe(true);
    expect(usePrefsStore.getState().glassHighlights).toBe(false);
  });
});
