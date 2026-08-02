/**
 * Root layout — App entry (Expo Router)
 *
 * 重要: polyfill は **これらの import より前** に設定する必要がある:
 * - react-native-get-random-values: @solana/web3.js が crypto.getRandomValues を要求
 * - Buffer: @solana/web3.js / MWA library が global Buffer を前提
 */

import "react-native-get-random-values";
import { Buffer } from "buffer";
if (typeof (globalThis as { Buffer?: unknown }).Buffer === "undefined") {
  (globalThis as { Buffer: typeof Buffer }).Buffer = Buffer;
}

import { useCallback, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import {
  Pacifico_400Regular,
  useFonts,
} from "@expo-google-fonts/pacifico";
import {
  Quicksand_400Regular,
  Quicksand_500Medium,
  Quicksand_600SemiBold,
  Quicksand_700Bold,
} from "@expo-google-fonts/quicksand";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from "react-native-safe-area-context";

import { createQueryClient } from "../services/queryClient";
import {
  addApprovalResponseListener,
  addExecutionResponseListener,
  getInitialApprovalResponse,
  setupNotificationHandler,
  type ApprovalPushPayload,
} from "../services/push";
import { ComingSoonToast } from "../components/feedback/ComingSoonToast";
import { usePrefsStore } from "../stores/prefs";
import { usePortfolioHistoryStore } from "../stores/portfolioHistory";
import { isDarkBackground, useActiveTheme } from "../stores/theme";

// SplashScreen が消えるタイミングを font load 完了後にする
SplashScreen.preventAutoHideAsync().catch(() => {
  /* noop: race condition で既に hidden の場合は無視 */
});

/** payload を /approval/[planId]?token=<tokenId> URL に変換 */
function approvalDeepLink(payload: ApprovalPushPayload): string {
  return `/approval/${encodeURIComponent(payload.plan_id)}?token=${encodeURIComponent(payload.token_id)}`;
}

export default function RootLayout() {
  // QueryClient は app lifetime で 1 つ。useState で lazy init し再生成を防ぐ。
  const [client] = useState(() => createQueryClient());
  const router = useRouter();

  // brand wordmark = Pacifico、heading/body = Quicksand (CLAUDE.md §6 デザインシステム規約)
  const [fontsLoaded, fontsError] = useFonts({
    Pacifico_400Regular,
    Quicksand_400Regular,
    Quicksand_500Medium,
    Quicksand_600SemiBold,
    Quicksand_700Bold,
  });

  const onLayoutReady = useCallback(async () => {
    if (fontsLoaded || fontsError) {
      await SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [fontsLoaded, fontsError]);

  // Phase 8.36: UI 設定 (液体演出 on/off 等) を起動時に復元
  // Phase 8.56: portfolio の日次スナップショット (chart の実履歴) も復元
  useEffect(() => {
    void usePrefsStore.getState().hydrate();
    void usePortfolioHistoryStore.getState().hydrate();
  }, []);

  // Phase 8.45: edge-to-edge のシステムバーアイコン色を active theme に追従させる。
  // expo-router が内部で <StatusBar style="auto" /> を children の **後ろ** に
  // マウントしており宣言的には勝てないため、命令的 API で上書きする。
  // (auto は端末の color scheme 依存なので、dark mode 端末ではバニラ背景に白アイコン
  //  が乗って消えてしまう)
  const activeTheme = useActiveTheme();
  const barsAreDark = isDarkBackground(activeTheme.ui.bgPrimary);
  //
  // NOTE: ここで `StatusBar.setTranslucent(true)` を呼んではいけない。RN の実装は
  // decorView に `replaceSystemWindowInsets(left, 0, right, bottom)` を返す
  // OnApplyWindowInsetsListener を張る (StatusBarModule.java) ため、**上端だけ**
  // edge-to-edge にして下端のインセットを復活させてしまい、MainActivity の
  // setDecorFitsSystemWindows(false) を打ち消す (実機で黒帯が残ることを確認済)。
  // バーの透明化はネイティブテーマ側 (styles.xml) の責務。
  useEffect(() => {
    StatusBar.setBarStyle(barsAreDark ? "light-content" : "dark-content", true);
    // 色は実行時にも透明を明示する。styles.xml の
    // android:statusBarColor=@android:color/transparent だけでは実機で黒いまま残った
    // (expo-splash-screen が起動時にステータスバー色を握るため)。
    // setBackgroundColor は色を変えるだけでインセットには影響しない
    StatusBar.setBackgroundColor("transparent", true);
  }, [barsAreDark]);

  useEffect(() => {
    setupNotificationHandler();

    // cold start: app が完全に閉じている状態で notification tap で起動した場合
    let mounted = true;
    void (async () => {
      const initial = await getInitialApprovalResponse();
      if (mounted && initial) {
        router.push(approvalDeepLink(initial));
      }
    })();

    // warm: foreground / background 状態で notification tap
    const sub = addApprovalResponseListener((payload) => {
      router.push(approvalDeepLink(payload));
    });

    // Phase 8.29: 自律実行「資金が動いた」通知 (v1 は log のみ、専用画面は後続)
    const execSub = addExecutionResponseListener((payload) => {
      // eslint-disable-next-line no-console
      console.log("[push] autonomous execution", payload);
    });

    return () => {
      mounted = false;
      sub.remove();
      execSub.remove();
    };
  }, [router]);

  if (!fontsLoaded && !fontsError) {
    // Splash の上に空 view を載せる (font load 失敗でも UI は出す)
    return null;
  }

  // 8.45: root と scene に背景色を敷く。edge-to-edge でバーが透明になると、
  // 背景色が無い層はシステムバー領域に react-navigation 既定のグレーを覗かせる
  const bg = activeTheme.ui.bgPrimary;

  return (
    // 8.45: expo-router 既定の SafeAreaProvider は native で initialMetrics を
    // 渡さないため、初回フレームの inset が 0 → 計測後にヘッダーが落ちる。明示ラップする
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: bg }}>
        <QueryClientProvider client={client}>
          <BottomSheetModalProvider>
            <View
              style={{ flex: 1, backgroundColor: bg }}
              onLayout={onLayoutReady}
            >
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: bg },
                }}
              />
              {/* Phase 7.8: global "Coming soon" toast (bottom-center, pointerEvents none) */}
              <ComingSoonToast />
            </View>
          </BottomSheetModalProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
