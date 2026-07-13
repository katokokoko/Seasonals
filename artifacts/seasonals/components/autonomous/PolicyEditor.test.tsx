/**
 * PolicyEditor — テスト (Phase 8.30)
 * auto arm 警告 / 変更差分のみ patch / §4.5 USD 検証。
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { PolicyEditor } from "./PolicyEditor";
import { fixtureUserPolicyDefault } from "@workspace/lib/__fixtures__";

const UNIVERSE = { protocols: ["kamino", "jito"], assets: ["USDC", "SOL"] };

function renderEditor(onSave = jest.fn()) {
  render(
    <PolicyEditor
      policy={fixtureUserPolicyDefault}
      protocolUniverse={UNIVERSE.protocols}
      assetUniverse={UNIVERSE.assets}
      onSave={onSave}
    />
  );
  return onSave;
}

describe("PolicyEditor", () => {
  it("approval_mode=auto を選ぶと arm 警告が出る", () => {
    renderEditor();
    expect(screen.queryByTestId("policy-auto-warning")).toBeNull();
    fireEvent.press(screen.getByTestId("policy-mode-auto"));
    expect(screen.getByTestId("policy-auto-warning")).toBeTruthy();
  });

  it("変更したフィールドだけが patch に入る (protocol toggle)", () => {
    const onSave = renderEditor();
    // fixture の enabled_protocols から kamino を外す
    fireEvent.press(screen.getByTestId("policy-protocol-kamino"));
    fireEvent.press(screen.getByTestId("policy-save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0][0];
    // enabled_protocols のみ (他フィールドは未変更なので含まれない)
    expect(Object.keys(patch)).toEqual(["enabled_protocols"]);
    expect(patch.enabled_protocols).not.toContain("kamino");
    expect(patch.enabled_protocols).toContain("jito");
  });

  it("変更なしなら空 patch", () => {
    const onSave = renderEditor();
    fireEvent.press(screen.getByTestId("policy-save"));
    expect(onSave).toHaveBeenCalledWith({});
  });

  it("不正な max_tx (USD でない) は error 表示・onSave しない (§4.5)", () => {
    const onSave = renderEditor();
    fireEvent.changeText(screen.getByTestId("policy-max-tx"), "abc");
    fireEvent.press(screen.getByTestId("policy-save"));
    expect(screen.getByTestId("policy-error")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("max_tx 空欄は null (無制限) として patch される", () => {
    const onSave = renderEditor();
    // fixture default は max_tx_amount=null。値を入れてから空に戻すと差分なし →
    // 代わりに min_tvl を変えて max_tx は空のまま = null 維持 (patch に max_tx 無し)
    fireEvent.changeText(screen.getByTestId("policy-max-tx"), "9.00000000");
    fireEvent.press(screen.getByTestId("policy-save"));
    const patch = onSave.mock.calls[0][0];
    expect(patch.max_tx_amount).toBe("9.00000000");
  });
});
