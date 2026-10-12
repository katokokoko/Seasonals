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
import { useWatchStore } from "../../stores/watch";

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

// watch-only mode: 既定は未接続 + 監視なし。watch 表示のテストだけ差し替える
const WATCHED = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";
let mockActiveAddress: {
  address: string | null;
  mode: "connected" | "watch" | "none";
  canSign: boolean;
} = { address: null, mode: "none", canSign: false };
jest.mock("../../services/useActiveAddress", () => ({
  useActiveAddress: () => mockActiveAddress,
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
  mockActiveAddress = { address: null, mode: "none", canSign: false };
});

describe("SettingsDrawer Wallet (watch-only mode)", () => {
  it("未接続 + 監視なしは Not connected で、Stop watching を出さない", () => {
    render(wrap(<SettingsDrawer visible onClose={() => {}} testID="settings" />));
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.queryByTestId("settings-stop-watching")).toBeNull();
  });

  it("watch 中は 'Watching …末尾6' と Stop watching を出し、押すと監視を止める", () => {
    useWatchStore.getState().addWatch(WATCHED);
    mockActiveAddress = { address: WATCHED, mode: "watch", canSign: false };
    const onClose = jest.fn();
    render(wrap(<SettingsDrawer visible onClose={onClose} testID="settings" />));

    expect(screen.getByTestId("settings-watching")).toHaveTextContent(
      `Watching …${WATCHED.slice(-6)}`
    );
    fireEvent.press(screen.getByTestId("settings-stop-watching"));
    expect(useWatchStore.getState().selected).toBeNull();
    expect(useWatchStore.getState().watchlist).toEqual([WATCHED]);
    expect(onClose).toHaveBeenCalled();
    useWatchStore.getState().reset();
  });
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
