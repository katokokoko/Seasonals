/**
 * WalletPickerModal — テスト (Phase 8.76)
 *
 * 新規接続時の wallet 選択カード。選んだ wallet の baseUri が onSelect に渡り、
 * それが connect({ baseUri }) → transact(cb, { baseUri }) → 「Android チューザーを
 * 介さず直接開く」に繋がる (mwa.test.ts 側で透過を担保)。
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import {
  KNOWN_WALLET_APPS,
  WalletPickerModal,
} from "./WalletPickerModal";

describe("WalletPickerModal", () => {
  it("既知 wallet 3 行 (Phantom / Solflare / Other) を表示する", () => {
    render(
      <WalletPickerModal
        visible
        onClose={jest.fn()}
        onSelect={jest.fn()}
        testID="picker"
      />
    );
    expect(screen.getByText("Phantom")).toBeTruthy();
    expect(screen.getByText("Solflare")).toBeTruthy();
    expect(screen.getByText("Other wallet…")).toBeTruthy();
  });

  it("Phantom タップ → onSelect(https://phantom.app)", () => {
    const onSelect = jest.fn();
    render(
      <WalletPickerModal
        visible
        onClose={jest.fn()}
        onSelect={onSelect}
        testID="picker"
      />
    );
    fireEvent.press(screen.getByTestId("picker-phantom"));
    expect(onSelect).toHaveBeenCalledWith("https://phantom.app");
  });

  it("Other タップ → onSelect(null) (= OS チューザーに委ねる)", () => {
    const onSelect = jest.fn();
    render(
      <WalletPickerModal
        visible
        onClose={jest.fn()}
        onSelect={onSelect}
        testID="picker"
      />
    );
    fireEvent.press(screen.getByTestId("picker-other"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("KNOWN_WALLET_APPS の baseUri は https 絶対 URI か null", () => {
    // native 側 (LocalAssociationIntentCreator) は https 以外の prefix を
    // IllegalArgumentException で落とすため、registry の形をここで固定する
    for (const app of KNOWN_WALLET_APPS) {
      if (app.baseUri !== null) {
        expect(app.baseUri).toMatch(/^https:\/\//);
      }
    }
  });
});
