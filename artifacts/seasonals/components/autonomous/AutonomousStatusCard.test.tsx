/**
 * AutonomousStatusCard — テスト (Phase 8.30)
 * armed/disarmed/stopped の chip 表示 + kill/resume の押下コールバック。
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { AutonomousStatusCard } from "./AutonomousStatusCard";
import { fixtureAutonomousStatus } from "@workspace/lib/__fixtures__";

describe("AutonomousStatusCard", () => {
  it("DISARMED 表示 + kill ボタン、press で onKill", () => {
    const onKill = jest.fn();
    render(
      <AutonomousStatusCard
        status={fixtureAutonomousStatus}
        onKill={onKill}
        onResume={jest.fn()}
      />
    );
    expect(screen.getByText("DISARMED")).toBeTruthy();
    fireEvent.press(screen.getByTestId("autonomous-kill"));
    expect(onKill).toHaveBeenCalledTimes(1);
  });

  it("killed 状態は STOPPED + resume ボタン、press で onResume", () => {
    const onResume = jest.fn();
    render(
      <AutonomousStatusCard
        status={{ ...fixtureAutonomousStatus, killed: true }}
        onKill={jest.fn()}
        onResume={onResume}
      />
    );
    expect(screen.getByText("STOPPED")).toBeTruthy();
    fireEvent.press(screen.getByTestId("autonomous-resume"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("enabled は ARMED", () => {
    render(
      <AutonomousStatusCard
        status={{ ...fixtureAutonomousStatus, enabled: true }}
        onKill={jest.fn()}
        onResume={jest.fn()}
      />
    );
    expect(screen.getByText("ARMED")).toBeTruthy();
  });

  it("busy 中は callback を発火しない (disabled)", () => {
    const onKill = jest.fn();
    render(
      <AutonomousStatusCard
        status={fixtureAutonomousStatus}
        onKill={onKill}
        onResume={jest.fn()}
        busy
      />
    );
    fireEvent.press(screen.getByTestId("autonomous-kill"));
    expect(onKill).not.toHaveBeenCalled();
  });
});
