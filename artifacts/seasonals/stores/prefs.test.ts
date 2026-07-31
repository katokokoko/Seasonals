/**
 * prefs store — 背景装飾設定の永続化 (Phase 8.36 → 8.41)。AsyncStorage は
 * jest.setup の in-memory mock。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { usePrefsStore } from "./prefs";

describe("usePrefsStore", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    usePrefsStore.setState({ backgroundMode: "liquid", glassHighlights: true });
  });

  it("default は liquid", () => {
    expect(usePrefsStore.getState().backgroundMode).toBe("liquid");
  });

  it("setBackgroundMode が state と AsyncStorage に反映される", async () => {
    usePrefsStore.getState().setBackgroundMode("none");
    expect(usePrefsStore.getState().backgroundMode).toBe("none");
    // fire-and-forget 書込を待つ
    await new Promise((r) => setTimeout(r, 0));
    expect(await AsyncStorage.getItem("prefs:backgroundMode")).toBe("none");
  });

  it("hydrate が保存値を復元する ('static')", async () => {
    await AsyncStorage.setItem("prefs:backgroundMode", "static");
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().backgroundMode).toBe("static");
  });

  it("hydrate は不正な保存値を無視して default を維持する", async () => {
    await AsyncStorage.setItem("prefs:backgroundMode", "sparkling");
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().backgroundMode).toBe("liquid");
  });

  it("保存値なしなら hydrate は default (liquid) を維持", async () => {
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().backgroundMode).toBe("liquid");
  });

  // 8.41: 旧 boolean キーからの移行
  it("legacy prefs:liquidEffect='0' → static に移行される", async () => {
    await AsyncStorage.setItem("prefs:liquidEffect", "0");
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().backgroundMode).toBe("static");
  });

  it("legacy より新キーが優先される", async () => {
    await AsyncStorage.setItem("prefs:liquidEffect", "0");
    await AsyncStorage.setItem("prefs:backgroundMode", "liquid");
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().backgroundMode).toBe("liquid");
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
    // backgroundMode 側は未保存 → default 維持のまま glassHighlights だけ off
    await usePrefsStore.getState().hydrate();
    expect(usePrefsStore.getState().backgroundMode).toBe("liquid");
    expect(usePrefsStore.getState().glassHighlights).toBe(false);
  });
});
