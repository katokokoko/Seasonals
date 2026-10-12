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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
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
import {
  configureReanimatedLogger,
  ReanimatedLogLevel,
} from "react-native-reanimated";

// 8.87 (Reanimated 4): strict mode は navigation ライブラリ内部の
// 「render 中の .value 読み取り」(Stack) まで警告するため off にする。
// アプリ自身のコードで .value を render 中に読まない規約は維持
configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false });

import {
  attachAppStateFocus,
  createQueryClient,
} from "../services/queryClient";
import {
  addApprovalResponseListener,
  addExecutionResponseListener,
  claimApprovalRoute,
  clearInitialApprovalResponse,
  getInitialApprovalResponse,
  setupNotificationHandler,
  type ApprovalPushPayload,
} from "../services/push";
import {
  addCooldownReminderResponseListener,
  deliverCooldownReminderTap,
  ensureCooldownNotificationChannel,
  getInitialCooldownReminderResponse,
  reconcileCooldownRemindersOnStartup,
} from "../services/cooldown-reminder";
import { ComingSoonToast } from "../components/feedback/ComingSoonToast";
import { usePrefsStore } from "../stores/prefs";
// §4.0: 永続化の対象判定 (純関数) と、その入力の recentWallets
import { shouldPersistQuery } from "../services/persist-filter";
import {
  isWalletStoreHydrated,
  useWalletStore,
  walletStoreHydrationFailed,
} from "../services/walletStore";
import { WALLET_QUERY_GC_MS } from "../services/queries";
import { useWatchStore } from "../stores/watch";
import { isDarkBackground, useActiveTheme } from "../stores/theme";

// SplashScreen が消えるタイミングを font load 完了後にする
SplashScreen.preventAutoHideAsync().catch(() => {
  /* noop: race condition で既に hidden の場合は無視 */
});

/**
 * payload を /approval/[planId] URL に変換。BFF の push は `{ type, plan_id }` だけ
 * (token は approve 後に発行される)。旧 payload の token_id があれば ?token= で渡す
 */
function approvalDeepLink(payload: ApprovalPushPayload): string {
  const base = `/approval/${encodeURIComponent(payload.plan_id)}`;
  return payload.token_id
    ? `${base}?token=${encodeURIComponent(payload.token_id)}`
    : base;
}

export default function RootLayout() {
  // QueryClient は app lifetime で 1 つ。useState で lazy init し再生成を防ぐ。
  const [client] = useState(() => createQueryClient());
  const router = useRouter();

  // 8.93: AppState → focusManager 配線。フォアグラウンド復帰を focus として
  // stale query を refetch する (refetchOnWindowFocus: true とセット)
  useEffect(() => attachAppStateFocus(), []);

  // 8.83: portfolio-history query を AsyncStorage に永続化する
  // (stale-while-revalidate)。再起動時は前回の完全グラフが即復元され、
  // staleTime 超過なら裏で refetch — cold start の brewing は初回起動と
  // maxAge (24h) 超の離脱時だけになる。
  // §4.0: wallet 系 (recentWallets の wallet だけ) と menu-listings も載せる。
  // 何を載せ何を載せないか (SKR / oracle / quote / plan は載せない) は
  // services/persist-filter.ts。recentWallets は dehydrate の瞬間に読む
  const [persistOptions] = useState(() => ({
    persister: createAsyncStoragePersister({
      storage: AsyncStorage,
      key: "seasonals.queryCache.v1",
      // 起動直後の連続書き込みをまとめる (default 1s は RN でも妥当)
      throttleTime: 1_000,
    }),
    maxAge: 24 * 60 * 60_000,
    // §4.0: 復元した query は observer が付くまで既定 gcTime (5 分) で GC される。
    // 接続していない recentWallets の wallet (再起動後まだ繋いでいない) の cache が
    // 5 分で消え、次の書き込みで永続からも落ちるので、復元分は wallet 系と同じ 24h 保持する
    hydrateOptions: {
      defaultOptions: { queries: { gcTime: WALLET_QUERY_GC_MS } },
    },
    dehydrateOptions: {
      shouldDehydrateQuery: (query: {
        queryKey: readonly unknown[];
        state: { status: string };
      }) =>
        shouldPersistQuery(
          query,
          // 復元前と復元失敗は null = wallet 系を全部残す (recentWallets が空のまま
          // 書き込むと、繋ぎ直していない wallet の cache が一過性の失敗で消える)。
          // watch-only mode: watchlist の address も残す (watch store の復元前は同じく null)
          isWalletStoreHydrated() &&
            !walletStoreHydrationFailed() &&
            useWatchStore.persist.hasHydrated()
            ? [
                ...useWalletStore.getState().recentWallets.map((w) => w.address),
                ...useWatchStore.getState().watchlist,
              ]
            : null
        ),
    },
  }));

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
  // (8.56 の portfolio 日次スナップショットは §4.0 で wallet 別になり、
  //  active wallet が決まる app/index.tsx で hydrate(address) する)
  useEffect(() => {
    void usePrefsStore.getState().hydrate();
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

    // cold start: app が完全に閉じている状態で notification tap で起動した場合。
    // 2026-10-08: 処理したら last response を消す (残すと layout の再 mount = dev の
    // JS reload 等で同じ承認画面を再び push する)。同じ plan への連続遷移は
    // claimApprovalRoute で防ぐ (cold と warm が同じ tap を両方届ける場合も 1 枚だけ)
    let mounted = true;
    void (async () => {
      const initial = await getInitialApprovalResponse();
      // unmount 済みなら消さずに次の mount へ残す
      if (!initial || !mounted) return;
      clearInitialApprovalResponse();
      if (claimApprovalRoute(initial.plan_id)) {
        router.push(approvalDeepLink(initial));
      }
    })();

    // warm: foreground / background 状態で notification tap
    const sub = addApprovalResponseListener((payload) => {
      if (!claimApprovalRoute(payload.plan_id)) return;
      router.push(approvalDeepLink(payload));
    });

    // Phase 8.29: 自律実行「資金が動いた」通知 (v1 は log のみ、専用画面は後続)
    const execSub = addExecutionResponseListener((payload) => {
      // eslint-disable-next-line no-console
      console.log("[push] autonomous execution", payload);
    });

    // SKR 確認通知 (docs/skr-r0-implementation.md §5): channel 作成と OS 予約一覧との照合。
    // tap は cold start / warm とも HomeScreen へ渡し、scope が一致すれば BFF を再取得する
    void ensureCooldownNotificationChannel();
    void reconcileCooldownRemindersOnStartup().catch(() => undefined);
    void (async () => {
      const initialCooldown = await getInitialCooldownReminderResponse();
      if (mounted && initialCooldown) {
        deliverCooldownReminderTap(initialCooldown);
        router.navigate("/");
      }
    })();
    const cooldownSub = addCooldownReminderResponseListener((payload) => {
      deliverCooldownReminderTap(payload);
      router.navigate("/");
    });

    return () => {
      mounted = false;
      sub.remove();
      execSub.remove();
      cooldownSub.remove();
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
        <PersistQueryClientProvider
          client={client}
          persistOptions={persistOptions}
        >
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
        </PersistQueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
