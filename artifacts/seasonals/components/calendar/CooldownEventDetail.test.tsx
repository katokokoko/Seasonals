/**
 * CooldownEventDetail (docs/skr-r0-implementation.md §4): event id で read response を直接解決する
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { fixtureCooldownStateCoolingDown } from "@workspace/lib/__fixtures__";

import { viewOf } from "../portfolio/cooldown-test-utils";
import { CooldownEventDetail } from "./CooldownEventDetail";

const EVENT_ID = fixtureCooldownStateCoolingDown.events[0]!.event.id;

describe("CooldownEventDetail", () => {
  it("event id に対応する position を表示する", () => {
    render(
      <CooldownEventDetail view={viewOf(fixtureCooldownStateCoolingDown, "fresh")} eventId={EVENT_ID} testID="d" />
    );
    // fixture の終了予定は 2026-09-22。端末時刻が過ぎていても chain が cooling_down なら「確認待ち」
    expect(screen.getByTestId("d-status")).toHaveTextContent(/Cooling down|waiting for on-chain confirmation/);
    expect(screen.getByTestId("d-status")).not.toHaveTextContent(/Withdrawable/);
    expect(screen.getByTestId("d-amounts")).toHaveTextContent(
      "Unstaking 250 SKR · Staked (est.) 1,141,844.79 SKR"
    );
  });

  it("id が一致しない (予定が変わった / 未取得) なら断定せず Refresh を促す", () => {
    render(
      <CooldownEventDetail view={viewOf(fixtureCooldownStateCoolingDown, "fresh")} eventId="lockup_end:other" testID="d" />
    );
    expect(screen.getByTestId("d-unresolved")).toBeTruthy();
    expect(screen.queryByTestId("d-status")).toBeNull();
  });

  it("Refresh は BFF を再取得する", () => {
    const refetch = jest.fn(async () => undefined);
    render(
      <CooldownEventDetail
        view={viewOf(fixtureCooldownStateCoolingDown, "fresh", { refetch })}
        eventId={EVENT_ID}
        testID="d"
      />
    );
    fireEvent.press(screen.getByTestId("d-refresh"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
