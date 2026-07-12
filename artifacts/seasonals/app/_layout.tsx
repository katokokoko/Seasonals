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
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";

import { createQueryClient } from "../services/queryClient";
import {
  addApprovalResponseListener,
  addExecutionResponseListener,
  getInitialApprovalResponse,
  setupNotificationHandler,
  type ApprovalPushPayload,
} from "../services/push";
import { ComingSoonToast } from "../components/feedback/ComingSoonToast";

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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={client}>
        <BottomSheetModalProvider>
          <View style={{ flex: 1 }} onLayout={onLayoutReady}>
            <Stack screenOptions={{ headerShown: false }} />
            {/* Phase 7.8: global "Coming soon" toast (bottom-center, pointerEvents none) */}
            <ComingSoonToast />
          </View>
        </BottomSheetModalProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
