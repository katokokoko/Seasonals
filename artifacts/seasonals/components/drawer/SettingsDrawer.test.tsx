/**
 * SettingsDrawer — About section / version footer の smoke テスト
 *
 * 配布 APK (eas.json `preview-onchain` / `production-onchain`) では DEVELOPER block が
 * 消えるので、privacy policy / source への導線は About section が担う
 * (dApp Store Publisher Policy、docs/external-release-api-handling.md §7)。
 * footer の version は app.config.ts の `version` (services/config.ts APP_VERSION) から出す。
 *
 * wallet (MWA / web3.js) と expo-router は本テストの対象外なので stub する。
 */
import React, { type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SettingsDrawer } from "./SettingsDrawer";

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("../../services/useWallet", () => ({
  useWallet: () => ({
    authorization: null,
    isConnected: false,
    disconnect: jest.fn(),
  }),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 16 },
};

function wrap(ui: ReactNode) {
  return <SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("SettingsDrawer About", () => {
  it("Privacy policy row は公開 site の /privacy を開く", () => {
    const openURL = jest
      .spyOn(Linking, "openURL")
      .mockResolvedValue(true);
    render(wrap(<SettingsDrawer visible onClose={() => {}} testID="settings" />));

    const row = screen.getByTestId("settings-privacy");
    expect(row.props.accessibilityRole).toBe("link");
    fireEvent.press(row);

    expect(openURL).toHaveBeenCalledWith("https://seasonals.cafe/privacy");
  });

  it("Source row は GitHub repository を開く", () => {
    const openURL = jest
      .spyOn(Linking, "openURL")
      .mockResolvedValue(true);
    render(wrap(<SettingsDrawer visible onClose={() => {}} testID="settings" />));

    fireEvent.press(screen.getByTestId("settings-source"));

    expect(openURL).toHaveBeenCalledWith(
      "https://github.com/katokokoko/Seasonals"
    );
  });

  it("footer は hard-code ではなく APP_VERSION から version を出す", () => {
    render(wrap(<SettingsDrawer visible onClose={() => {}} testID="settings" />));

    const footer = screen.getByTestId("settings-version");
    expect(footer).toHaveTextContent(/^Seasonals · v\d/);
  });
});
