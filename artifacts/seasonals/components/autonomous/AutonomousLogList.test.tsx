/**
 * AutonomousLogList — テスト (Phase 8.30)
 * empty state / record 行 (decision + explorer リンク / reason) の描画。
 */

import React from "react";
import { render, screen } from "@testing-library/react-native";

import { AutonomousLogList } from "./AutonomousLogList";
import { fixtureAutonomousLog } from "@workspace/lib/__fixtures__";

describe("AutonomousLogList", () => {
  it("空配列は empty state", () => {
    render(<AutonomousLogList records={[]} />);
    expect(screen.getByTestId("autonomous-log-empty")).toBeTruthy();
  });

  it("record を newest 順に描画 (executed の explorer リンク / rejected の reason)", () => {
    render(<AutonomousLogList records={fixtureAutonomousLog} />);
    expect(screen.getByTestId("autonomous-log-list")).toBeTruthy();
    // executed record は tx_signature → explorer リンク
    const executed = fixtureAutonomousLog.find((r) => r.decision === "executed")!;
    expect(
      screen.getByTestId(`autonomous-log-sig-${executed.record_id}`)
    ).toBeTruthy();
    // rejected record は reason 表示 + violations
    const rejected = fixtureAutonomousLog.find((r) => r.decision === "rejected")!;
    expect(screen.getByTestId(`autonomous-log-${rejected.record_id}`)).toBeTruthy();
    expect(screen.getByText(rejected.reason!)).toBeTruthy();
  });
});
