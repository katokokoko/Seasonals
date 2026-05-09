/**
 * WarningArea — テスト
 *
 * §29.2 UX テスト「緊急度が瞬時に伝わるか」と
 * §29.3 セキュリティテスト「warning は素通りしない」をコードで担保する。
 *
 * 環境: jest-expo + @testing-library/react-native
 *
 * NOTE: expo-haptics は jest-expo 環境では mock されている前提
 *       (artifacts/seasonals/jest.setup.js で global mock 済み)。
 */

import React from "react";
import { Text, Pressable } from "react-native";
import { render, screen, act } from "@testing-library/react-native";

import {
  WarningArea,
  type OracleWarning,
  type SimulationWarning,
} from "./WarningArea";

// expo-haptics の mock (jest.setup.js で済んでいない環境向け safety net)
jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

// ─────────────────────────────────────────────────────────────────────────────
// テスト用 fixtures
// ─────────────────────────────────────────────────────────────────────────────

const divergenceWarning: OracleWarning = {
  kind: "oracle_divergence_warning",
  divergencePct: 3.4,
};

const pythStaleWarning: OracleWarning = {
  kind: "oracle_pyth_stale",
  pythAgeSeconds: 92,
};

const simulationApyWarning: SimulationWarning = {
  kind: "apy_volatile",
  message: "過去 24 時間の APY 変動が大きいため、表示値は参考値です",
};

function MockCta({ disabled }: { disabled: boolean }) {
  return (
    <Pressable disabled={disabled} testID="cta-button">
      <Text>署名して実行</Text>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("WarningArea", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── 表示系 ──

  it("oracle warning がない場合、警告領域も simulation 領域も表示しない", () => {
    render(
      <WarningArea
        oracleWarnings={[]}
        simulationWarnings={[]}
        renderCta={(state) => <MockCta {...state} />}
        testID="wa"
      />
    );
    expect(screen.queryByTestId("wa-oracle")).toBeNull();
    expect(screen.queryByTestId("wa-simulation")).toBeNull();
    expect(screen.getByTestId("cta-button")).toBeTruthy();
  });

  it("divergence warning の見出しと乖離率を render する", () => {
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        renderCta={(state) => <MockCta {...state} />}
        testID="wa"
      />
    );
    expect(screen.getByText("価格 oracle に異常を検出")).toBeTruthy();
    expect(
      screen.getByText("Pyth と Switchboard の価格が 3.4% 乖離しています")
    ).toBeTruthy();
  });

  it("Pyth stale warning の見出しと経過秒数を render する", () => {
    render(
      <WarningArea
        oracleWarnings={[pythStaleWarning]}
        renderCta={(state) => <MockCta {...state} />}
        testID="wa"
      />
    );
    expect(screen.getByText("Pyth が古い価格を返しています")).toBeTruthy();
    expect(
      screen.getByText("Pyth の最終更新から 92 秒経過。Switchboard を使用中")
    ).toBeTruthy();
  });

  it("oracle warning area には accessibilityRole='alert' が付与される", () => {
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        renderCta={(state) => <MockCta {...state} />}
        testID="wa"
      />
    );
    const alertNode = screen.getByTestId("wa-oracle");
    expect(alertNode.props.accessibilityRole).toBe("alert");
  });

  it("simulation warning は subtle 領域に表示される", () => {
    render(
      <WarningArea
        oracleWarnings={[]}
        simulationWarnings={[simulationApyWarning]}
        renderCta={(state) => <MockCta {...state} />}
        testID="wa"
      />
    );
    expect(screen.getByTestId("wa-simulation")).toBeTruthy();
    expect(screen.getByText(simulationApyWarning.message)).toBeTruthy();
    expect(screen.queryByTestId("wa-oracle")).toBeNull();
  });

  it("oracle warning が複数あれば全て render する", () => {
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning, pythStaleWarning]}
        renderCta={(state) => <MockCta {...state} />}
        testID="wa"
      />
    );
    expect(screen.getByTestId("wa-oracle-0")).toBeTruthy();
    expect(screen.getByTestId("wa-oracle-1")).toBeTruthy();
  });

  it("Switchboard stale warning の見出しと経過秒数を render する", () => {
    render(
      <WarningArea
        oracleWarnings={[{ kind: "oracle_switchboard_stale", switchboardAgeSeconds: 121 }]}
        renderCta={(state) => <MockCta {...state} />}
        testID="wa"
      />
    );
    expect(screen.getByText("Switchboard が古い価格を返しています")).toBeTruthy();
    expect(
      screen.getByText("Switchboard の最終更新から 121 秒経過。Pyth を使用中")
    ).toBeTruthy();
  });

  // ── CTA grayout タイマー ──

  it("oracle warning がない時、CTA は最初から enabled", () => {
    render(
      <WarningArea
        oracleWarnings={[]}
        simulationWarnings={[simulationApyWarning]}
        renderCta={(state) => <MockCta {...state} />}
      />
    );
    const cta = screen.getByTestId("cta-button");
    expect(cta.props.accessibilityState?.disabled ?? cta.props.disabled).toBeFalsy();
  });

  it("oracle warning がある時、CTA は grayoutMs まで disabled、その後 enabled", () => {
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        renderCta={(state) => <MockCta {...state} />}
        grayoutMs={1000}
        hapticsEnabled={false}
      />
    );

    // 初期状態 = disabled
    let cta = screen.getByTestId("cta-button");
    expect(
      cta.props.accessibilityState?.disabled ?? cta.props.disabled
    ).toBeTruthy();

    // 999ms 経過してもまだ disabled
    act(() => {
      jest.advanceTimersByTime(999);
    });
    cta = screen.getByTestId("cta-button");
    expect(
      cta.props.accessibilityState?.disabled ?? cta.props.disabled
    ).toBeTruthy();

    // 1000ms 経過で enabled
    act(() => {
      jest.advanceTimersByTime(1);
    });
    cta = screen.getByTestId("cta-button");
    expect(
      cta.props.accessibilityState?.disabled ?? cta.props.disabled
    ).toBeFalsy();
  });

  it("カスタム grayoutMs を尊重する (§17.2 A/B 対象)", () => {
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        renderCta={(state) => <MockCta {...state} />}
        grayoutMs={2500}
        hapticsEnabled={false}
      />
    );

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    let cta = screen.getByTestId("cta-button");
    expect(
      cta.props.accessibilityState?.disabled ?? cta.props.disabled
    ).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    cta = screen.getByTestId("cta-button");
    expect(
      cta.props.accessibilityState?.disabled ?? cta.props.disabled
    ).toBeFalsy();
  });

  // ── analytics 発火 ──

  it("mount 時に onWarningShown が oracle / simulation の混合 kinds で発火", () => {
    const onWarningShown = jest.fn();
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        simulationWarnings={[simulationApyWarning]}
        renderCta={(state) => <MockCta {...state} />}
        analytics={{ onWarningShown }}
        hapticsEnabled={false}
      />
    );
    expect(onWarningShown).toHaveBeenCalledTimes(1);
    expect(onWarningShown).toHaveBeenCalledWith([
      "oracle_divergence_warning",
      "apy_volatile",
    ]);
  });

  it("warning が空の場合 onWarningShown は発火しない", () => {
    const onWarningShown = jest.fn();
    render(
      <WarningArea
        oracleWarnings={[]}
        simulationWarnings={[]}
        renderCta={(state) => <MockCta {...state} />}
        analytics={{ onWarningShown }}
        hapticsEnabled={false}
      />
    );
    expect(onWarningShown).not.toHaveBeenCalled();
  });

  it("hapticsEnabled=false の場合でも警告表示は継続する", () => {
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        renderCta={(state) => <MockCta {...state} />}
        hapticsEnabled={false}
        testID="wa"
      />
    );
    expect(screen.getByTestId("wa-oracle")).toBeTruthy();
  });

  it("grayout 経過後に onCtaEnabled が発火 (1 回のみ)", () => {
    const onCtaEnabled = jest.fn();
    render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        renderCta={(state) => <MockCta {...state} />}
        grayoutMs={500}
        analytics={{ onCtaEnabled }}
        hapticsEnabled={false}
      />
    );
    expect(onCtaEnabled).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(onCtaEnabled).toHaveBeenCalledTimes(1);

    // さらに時間が経っても再発火しない
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(onCtaEnabled).toHaveBeenCalledTimes(1);
  });

  it("unmount 時に onWarningDismissed が発火", () => {
    const onWarningDismissed = jest.fn();
    const { unmount } = render(
      <WarningArea
        oracleWarnings={[divergenceWarning]}
        renderCta={(state) => <MockCta {...state} />}
        analytics={{ onWarningDismissed }}
        hapticsEnabled={false}
      />
    );

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    unmount();
    expect(onWarningDismissed).toHaveBeenCalledTimes(1);
    const elapsed = onWarningDismissed.mock.calls[0][0];
    expect(typeof elapsed).toBe("number");
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});
