/**
 * StakingRow (docs/skr-r0-implementation.md §4、R0-05 UI 部分)
 */
import React from "react";
import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

import {
  fixtureCooldownStateCoolingDown,
  fixtureCooldownStateDemoCoolingDown,
  fixtureCooldownStateReady,
} from "@workspace/lib/__fixtures__";
import { SKR_STAKING_PORTAL_URL } from "@workspace/lib/config/skr-staking";

import { viewOf } from "./cooldown-test-utils";
import { StakingRow } from "./StakingRow";

describe("StakingRow", () => {
  it("推定 stake / 解除待ち / 元本・収益・USD は — / 合計外ラベル", () => {
    render(<StakingRow view={viewOf(fixtureCooldownStateCoolingDown, "fresh")} testID="row" />);
    expect(screen.getByTestId("row-staked")).toHaveTextContent("1,141,844.79 SKR");
    expect(screen.getByTestId("row-pending")).toHaveTextContent("250 SKR");
    expect(screen.getByText("— · — · —")).toBeTruthy();
    expect(screen.getByTestId("row-excluded")).toHaveTextContent("Not in totals");
    expect(screen.queryByTestId("row-demo")).toBeNull();
  });

  it("ROI / 入金日 / 収益額を捏造しない", () => {
    render(<StakingRow view={viewOf(fixtureCooldownStateCoolingDown, "fresh")} testID="row" />);
    expect(screen.queryByText(/ROI/)).toBeNull();
    expect(screen.queryByText(/Deposited/)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("demo source は Demo pill", () => {
    render(<StakingRow view={viewOf(fixtureCooldownStateDemoCoolingDown, "fresh")} testID="row" />);
    expect(screen.getByTestId("row-demo")).toHaveTextContent("Demo");
  });

  it("stale は観測時刻と awaiting update、ready を断定しない", () => {
    render(<StakingRow view={viewOf(fixtureCooldownStateReady, "stale")} testID="row" />);
    expect(screen.getByTestId("row-observed")).toHaveTextContent(/awaiting update/);
    expect(screen.getByTestId("row-status")).not.toHaveTextContent(/Withdrawable/);
  });

  it("公式ポータルを開く (署名・送金はしない)", () => {
    const spy = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    render(<StakingRow view={viewOf(fixtureCooldownStateCoolingDown, "fresh")} testID="row" />);
    fireEvent.press(screen.getByTestId("row-portal"));
    expect(spy).toHaveBeenCalledWith(SKR_STAKING_PORTAL_URL);
    spy.mockRestore();
  });
});
