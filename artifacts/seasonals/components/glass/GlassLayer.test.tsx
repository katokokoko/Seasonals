/**
 * GlassLayer — 退避ロジックのテスト (Phase 8.36、§2.4)。
 * Skia canvas の絵は assert しない (jest.setup の View pass-through mock)。
 */
import React from "react";
import { AccessibilityInfo } from "react-native";
import { render, waitFor } from "@testing-library/react-native";

import { GlassLayer } from "./GlassLayer";
import { usePrefsStore } from "../../stores/prefs";
import { DeviceMotion } from "expo-sensors";

// useFocusEffect は navigation context 必須のため noop に (購読 gating は
// useTiltRoll の focus state — テストでは「フォーカス中」として扱う)
jest.mock("expo-router", () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React = require("react");
    React.useEffect(() => cb(), [cb]);
  },
}));

const mockAvailable = DeviceMotion.isAvailableAsync as jest.MockedFunction<
  typeof DeviceMotion.isAvailableAsync
>;

describe("GlassLayer — 退避 (§2.4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePrefsStore.setState({ liquidEffect: true, glassHighlights: true });
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(false);
  });

  it("設定 off → Skia canvas を出さず静的背景へ退避", () => {
    usePrefsStore.setState({ liquidEffect: false });
    const { queryByTestId } = render(<GlassLayer />);
    expect(queryByTestId("glass-layer")).toBeNull();
  });

  it("reduce-motion 有効 → 静的背景へ退避", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValue(true);
    mockAvailable.mockResolvedValue(true);
    const { queryByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).toBeNull();
    });
  });

  it("センサー不可 → 静的背景へ退避", async () => {
    mockAvailable.mockResolvedValue(false);
    const { queryByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).toBeNull();
    });
  });

  it("on + reduce-motion off + センサー可 → 液体レイヤを描画", async () => {
    mockAvailable.mockResolvedValue(true);
    const { queryByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).not.toBeNull();
    });
  });

  // 8.40: グラスのハイライト個別 on/off (ハイライトは唯一の RoundedRect ×2)
  it("glassHighlights on → ハイライト (RoundedRect ×2) を描画", async () => {
    mockAvailable.mockResolvedValue(true);
    const { queryByTestId, queryAllByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).not.toBeNull();
    });
    expect(queryAllByTestId("skia-RoundedRect")).toHaveLength(2);
  });

  it("glassHighlights off → 液体レイヤは維持しつつハイライトだけ消える", async () => {
    usePrefsStore.setState({ glassHighlights: false });
    mockAvailable.mockResolvedValue(true);
    const { queryByTestId, queryAllByTestId } = render(<GlassLayer />);
    await waitFor(() => {
      expect(queryByTestId("glass-layer")).not.toBeNull();
    });
    expect(queryAllByTestId("skia-RoundedRect")).toHaveLength(0);
  });
});
