/**
 * GlassLayer — 退避ロジックのテスト (Phase 8.36、§2.4)。
 * Skia canvas の絵は assert しない (jest.setup の View pass-through mock)。
 *
 * 8.46: センサーは reanimated の useAnimatedSensor (UI スレッド直結) に移行した
 * ため、mock 対象を DeviceMotion から useAnimatedSensor へ変更。spread-actual で
 * useAnimatedSensor だけ差し替える (useSharedValue / useFrameCallback 等は実物)。
 */
import React from "react";
import { AccessibilityInfo } from "react-native";
import { render, waitFor } from "@testing-library/react-native";

import { GlassLayer } from "./GlassLayer";
import { usePrefsStore } from "../../stores/prefs";

// useFocusEffect は navigation context 必須のため noop に (購読 gating は
// useTiltRoll の focus state — テストでは「フォーカス中」として扱う)
jest.mock("expo-router", () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React = require("react");
    React.useEffect(() => cb(), [cb]);
  },
}));

// センサー可用性をテストごとに切り替える (名前は jest の out-of-scope 規約で mock*)。
// reanimated 本体の spread mock は default export (Animated.View) を壊すため、
// useTiltRoll モジュールを mock する。本テストの対象は GlassLayer の退避 gating
// であり、useTiltRoll 内部 (focus / AppState) はここでは対象外
let mockSensorAvailable = true;
jest.mock("./useTiltRoll", () => ({
  useTiltRoll: (enabled: boolean) => ({
    roll: { value: 0 },
    shake: { value: 0 },
    available: enabled ? mockSensorAvailable : null,
    senseActive: enabled,
    reportAvailable: () => undefined,
  }),
  TiltSensorBridge: () => null,
}));

describe("GlassLayer — 退避 (§2.4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSensorAvailable = true;
    usePrefsStore.setState({ backgroundMode: "liquid" });
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(false);
  });

  it("static → Skia canvas を出さず静的背景へ退避", () => {
    usePrefsStore.setState({ backgroundMode: "static" });
    const { queryByTestId, toJSON } = render(<GlassLayer />);
    expect(queryByTestId("glass-layer")).toBeNull();
    expect(toJSON()).not.toBeNull(); // MelonSodaBackground static は描く
  });

  // 8.41: none = うす緑の静的背景すら描かない
  it("none → 背景装飾を一切描かない", () => {
    usePrefsStore.setState({ backgroundMode: "none" });
    const { toJSON } = render(<GlassLayer />);
    expect(toJSON()).toBeNull();
  });

  it("reduce-motion 有効 → 静的背景へ退避", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(true);
    const { queryByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).toBeNull();
    });
  });

  it("センサー不可 → 静的背景へ退避", async () => {
    mockSensorAvailable = false;
    const { queryByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).toBeNull();
    });
  });

  it("on + reduce-motion off + センサー可 → 液体レイヤを描画", async () => {
    const { queryByTestId, queryAllByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).not.toBeNull();
    });
    // 8.42/8.43: 全画面 sky Rect (薄緑) とガラスのハイライト (白い縦筋) は撤去済
    // — 液面より上と液体越しにアプリ本来の背景が透ける
    expect(queryAllByTestId("skia-Rect")).toHaveLength(0);
    expect(queryAllByTestId("skia-RoundedRect")).toHaveLength(0);
  });
});
