/**
 * WalletPopover — drink button から起動する 右上 pop-out popover (Phase 5A.8 / 7.6)
 *
 * 構成 (anchor: top: anchorTop, right: 14, width: 280):
 *   "Wallets" overline
 *   MWA 接続済 wallet の row (label + truncated address + status dot)
 *   watch-only mode (onchain build のみ):
 *     Watching card (未接続で監視 address を読んでいる間)
 *     "Watch an address (read-only)" 入力 + Watch pill
 *     watchlist rows (tap = select、× = remove) + "Stop watching"
 *   "+ Add Wallet" row (tap → useWallet().connect()、MWA はここからのみ起動)
 *   "Subscription" full-width pill button
 *
 * 5A.8.5 empty state: 未接続 → wallet section を完全省略。
 *
 * watch-only mode は公開 address を AsyncStorage に残すだけで MWA には一切触れない
 * (authorization を書かないので Seed Vault に届かない。署名は ActionModal が止める)。
 * 入口はこの popover だけ (SettingsDrawer は状態表示と停止のみ)。
 *
 * Phase 7.6 motion: Modal animationType="none" + SharedValue enter (0→1) で
 * card を transformOrigin "top right" の scale + opacity、backdrop を同期 fade。
 * ActionModal (Phase 6.4) と同じ renderModal lifecycle パターン。
 */

import React, { useEffect, useState } from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { BlurView } from "expo-blur";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";

import { useWallet } from "../../services/useWallet";
import { useActiveAddress } from "../../services/useActiveAddress";
import { USE_ONCHAIN } from "../../services/config";
import { useComingSoon } from "../../stores/comingSoon";
import { useWatchStore } from "../../stores/watch";
import {
  useThemeColors,
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";

// 幅 280 固定の popover に watchlist (最大 6) が載るので、縦は画面の 6 割で scroll させる
const SCREEN_H = Dimensions.get("window").height;

function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `…${addr.slice(-6)}`;
}

function initialOf(label: string | null | undefined): string {
  if (!label) return "S"; // Seeker default
  return label.charAt(0).toUpperCase();
}

export interface WalletPopoverProps {
  visible: boolean;
  /** screen top からの px。drink button のすぐ下に配置するため home から計算して渡す */
  anchorTop: number;
  onClose: () => void;
  testID?: string;
}

export function WalletPopover({
  visible,
  anchorTop,
  onClose,
  testID,
}: WalletPopoverProps) {
  const router = useRouter();
  // Phase 7.4: fixture wallets を撤去、MWA authorization のみを表示
  // Phase 8.5.1: disconnect も使えるように expose
  // 8.77: status / error も読む — 接続失敗が UI のどこにも出ていなかった
  const { authorization, connect, disconnect, status, error } = useWallet();
  // watch-only mode: 監視 address (公開情報のみ、AsyncStorage)。fixture variant では出さない
  const { mode } = useActiveAddress();
  const watchlist = useWatchStore((s) => s.watchlist);
  const selectedWatch = useWatchStore((s) => s.selected);
  const [watchInput, setWatchInput] = useState("");
  const [watchError, setWatchError] = useState<string | null>(null);
  const watching = mode === "watch" && selectedWatch !== null;
  // Phase 7.9: theme 連動 styles
  const styles = useThemedStyles(makeStyles);
  const c = useThemeColors();

  // Phase 7.6 motion: ActionModal と同型の renderModal lifecycle で
  // close 完了後に Modal を unmount する (中断時は finished===false で安全)。
  const [renderModal, setRenderModal] = useState(visible);
  const enter = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setRenderModal(true);
      enter.value = withSpring(1, {
        damping: 18,
        stiffness: 220,
        mass: 0.6,
      });
    } else {
      enter.value = withTiming(
        0,
        { duration: 180, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setRenderModal)(false);
        }
      );
    }
  }, [visible, enter]);

  const cardAnim = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ scale: 0.88 + 0.12 * enter.value }],
  }));

  const backdropAnim = useAnimatedStyle(() => ({
    opacity: enter.value * 0.18,
  }));

  const handleAddWallet = async () => {
    // Phase 7.8: 接続済 wallet がある状態での "+ Add Wallet" は multi-wallet
    // 機能 (未実装) の入口として扱い、Coming Soon を表示。未接続なら初回
    // connect の動線として MWA connect を起動。
    //
    // 8.77: 8.76 で挟んだ wallet 選択カードは撤去した。決め打ちの
    // `https://phantom.app` は Phantom の verified app-link に入っておらず、
    // **ブラウザで phantom.app が開くだけ**だった (実機で確認)。新規接続は
    // OS のチューザーに任せる — 接続後の署名は wallet 自身が報告した
    // walletUriBase で直接起動するので、チューザーが出るのは初回だけ。
    if (authorization) {
      onClose();
      useComingSoon
        .getState()
        .show("Multi-wallet support is coming soon");
      return;
    }
    onClose();
    try {
      await connect();
    } catch (err) {
      // 8.77: 握り潰さない。walletStore は status:"error" を持つが表示する側が
      // 居らず、失敗が完全に無言だった (今回の調査で判明)。
      // toast は "coming soon" 用の命名のまま流用している (汎用リネームは別途)
      const message = err instanceof Error ? err.message : String(err);
      useComingSoon
        .getState()
        .show(`Wallet connection failed: ${message}`.slice(0, 120));
    }
  };

  const handleSubscription = () => {
    onClose();
    // /settings/subscription route 未実装 — TODO Phase 5+
    router.push("/theme-shop");
  };

  // watch-only mode: address を検証して watchlist の先頭へ (MWA は起動しない)
  const handleAddWatch = () => {
    const result = useWatchStore.getState().addWatch(watchInput);
    if (!result.ok) {
      setWatchError(result.error);
      return;
    }
    setWatchInput("");
    setWatchError(null);
    onClose();
    // 接続 wallet が優先されるので、追加しても今は表示が変わらないことを伝える
    if (authorization) {
      useComingSoon
        .getState()
        .show("Added to watchlist — shown when you disconnect");
    }
  };

  const handleSelectWatch = (address: string) => {
    useWatchStore.getState().select(address);
    onClose();
    if (authorization) {
      useComingSoon
        .getState()
        .show("Added to watchlist — shown when you disconnect");
    }
  };

  // 監視停止 (list は残す。cache は address key のまま保持 = 接続状態 ≠ データ保持)
  const handleStopWatching = () => {
    useWatchStore.getState().select(null);
    onClose();
  };

  // Phase 8.5.1: 接続済 wallet を切断 (mainnet 接続切替 / disconnect 用)
  const handleDisconnect = async () => {
    onClose();
    try {
      await disconnect();
    } catch {
      /* silent */
    }
  };

  return (
    <Modal
      visible={renderModal}
      transparent
      animationType="none"
      onRequestClose={onClose}
      // 8.45: ActionModal と同じく全画面 window にする。これが無いと Modal の座標系が
      // ステータスバーを含まず、anchorTop (画面ルート座標) との差分だけ popover が下にズレる
      statusBarTranslucent
      testID={testID}
    >
      <Animated.View
        style={[styles.backdropBase, backdropAnim]}
        pointerEvents="none"
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close wallet menu"
      />
      <Animated.View style={[styles.card, { top: anchorTop }, cardAnim]}>
        <BlurView
          intensity={60}
          tint="light"
          style={styles.cardBlur}
          pointerEvents="none"
        />
        <View style={styles.cardTint} pointerEvents="none" />
        <View style={styles.cardHighlight} pointerEvents="none" />

        <ScrollView
          style={styles.scroll}
          keyboardShouldPersistTaps="handled"
          bounces={false}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.heading}>Wallets</Text>

          {/* 8.77: 直近の接続失敗をここに残す。toast は 2200ms で消えるので、
              再試行する場所 (この popover) にも出しておく */}
          {status === "error" && error && (
            <View
              style={styles.errorRow}
              testID={testID ? `${testID}-error` : undefined}
            >
              <Text style={styles.errorText} numberOfLines={3}>
                Couldn&apos;t connect: {error}
              </Text>
            </View>
          )}

          {/* Phase 7.4: 接続済 MWA wallet 1 行のみ。未接続なら section 全省略 (5A.8.5) */}
          {authorization && (
            <View style={styles.walletsSection}>
              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                style={styles.walletRow}
                testID={testID ? `${testID}-wallet-current` : undefined}
              >
                <View style={styles.iconDark}>
                  <Text style={styles.iconLetter}>
                    {initialOf(authorization.label)}
                  </Text>
                </View>
                <View style={styles.walletMain}>
                  <Text style={styles.walletLabel}>Connected wallet</Text>
                  <Text style={styles.walletProvider} numberOfLines={1}>
                    {authorization.label ?? "Seeker wallet"}
                  </Text>
                  <Text style={styles.walletAddress} numberOfLines={1}>
                    {shortenAddress(authorization.address)}
                  </Text>
                </View>
                <View style={styles.statusDot} />
              </Pressable>
            </View>
          )}

          {/* watch-only mode: 監視中の address (署名不可)。接続 wallet があればそちらが優先 */}
          {USE_ONCHAIN && watching && selectedWatch && (
            <View style={styles.walletsSection}>
              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                style={styles.walletRow}
                testID={testID ? `${testID}-watching` : undefined}
              >
                <View style={[styles.iconDark, styles.iconWatch]}>
                  <Text style={styles.iconLetter}>W</Text>
                </View>
                <View style={styles.walletMain}>
                  <Text style={styles.walletLabel}>Connect a wallet to sign</Text>
                  <Text style={styles.walletProvider} numberOfLines={1}>
                    Watching (read-only)
                  </Text>
                  <Text style={styles.walletAddress} numberOfLines={1}>
                    {shortenAddress(selectedWatch)}
                  </Text>
                </View>
                <View style={[styles.statusDot, styles.statusDotWatch]} />
              </Pressable>
            </View>
          )}

          {/* watch-only mode: 入力 + watchlist。fixture variant (USE_ONCHAIN=false) では出さない */}
          {USE_ONCHAIN && (
            <View style={styles.watchSection}>
              <Text style={styles.walletLabel}>Watch an address (read-only)</Text>
              <View style={styles.watchInputRow}>
                <TextInput
                  style={styles.watchInput}
                  value={watchInput}
                  onChangeText={(v) => {
                    setWatchInput(v);
                    if (watchError) setWatchError(null);
                  }}
                  onSubmitEditing={handleAddWatch}
                  placeholder="Solana address"
                  placeholderTextColor={c.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  numberOfLines={1}
                  testID={testID ? `${testID}-watch-input` : undefined}
                />
                <Pressable
                  accessibilityRole="button"
                  onPress={handleAddWatch}
                  disabled={watchInput.trim().length === 0}
                  accessibilityState={{ disabled: watchInput.trim().length === 0 }}
                  style={[
                    styles.watchBtn,
                    watchInput.trim().length === 0 && styles.watchBtnDisabled,
                  ]}
                  testID={testID ? `${testID}-watch-submit` : undefined}
                >
                  <Text style={styles.watchBtnText}>Watch</Text>
                </Pressable>
              </View>
              {watchError && (
                <View
                  style={styles.errorRow}
                  testID={testID ? `${testID}-watch-error` : undefined}
                >
                  <Text style={styles.errorText} numberOfLines={2}>
                    {watchError}
                  </Text>
                </View>
              )}

              {watchlist.map((addr) => {
                const isWatching = watching && addr === selectedWatch;
                const isConnectedAddr = authorization?.address === addr;
                return (
                  <View
                    key={addr}
                    style={[styles.watchRow, isWatching && styles.watchRowActive]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: isWatching }}
                      onPress={() => handleSelectWatch(addr)}
                      style={styles.watchRowMain}
                      testID={testID ? `${testID}-watch-row-${addr}` : undefined}
                    >
                      <Text style={styles.watchRowAddress} numberOfLines={1}>
                        {shortenAddress(addr)}
                      </Text>
                      {isConnectedAddr ? (
                        <Text style={[styles.watchTag, styles.watchTagConnected]}>
                          connected
                        </Text>
                      ) : isWatching ? (
                        <Text style={styles.watchTag}>watching</Text>
                      ) : null}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${shortenAddress(addr)} from watchlist`}
                      onPress={() => useWatchStore.getState().removeWatch(addr)}
                      hitSlop={8}
                      style={styles.watchRemove}
                      testID={testID ? `${testID}-watch-remove-${addr}` : undefined}
                    >
                      <Text style={styles.watchRemoveText}>×</Text>
                    </Pressable>
                  </View>
                );
              })}

              {watching && (
                <Pressable
                  accessibilityRole="button"
                  onPress={handleStopWatching}
                  style={styles.disconnectRow}
                  testID={testID ? `${testID}-stop-watching` : undefined}
                >
                  <Text style={[styles.disconnectText, styles.stopWatchingText]}>
                    Stop watching
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* + Add Wallet (MWA fires here only) */}
          <Pressable
            accessibilityRole="button"
            onPress={handleAddWallet}
            style={styles.addRow}
            testID={testID ? `${testID}-add-wallet` : undefined}
          >
            <View style={styles.addBadge}>
              <Text style={styles.addBadgePlus}>+</Text>
            </View>
            <View style={styles.walletMain}>
              <Text style={styles.walletProvider}>+ Add Wallet</Text>
              <Text style={styles.walletLabel}>
                {watching ? "Connect a wallet to sign" : "Track another Solana wallet"}
              </Text>
            </View>
          </Pressable>

          {/* Subscription footer */}
          <Pressable
            accessibilityRole="button"
            onPress={handleSubscription}
            style={styles.subBtn}
            testID={testID ? `${testID}-subscription` : undefined}
          >
            <Text style={styles.subBtnText}>Subscription</Text>
          </Pressable>

          {/* Phase 8.5.1: Disconnect (接続済時のみ表示) */}
          {authorization && (
            <Pressable
              accessibilityRole="button"
              onPress={handleDisconnect}
              style={styles.disconnectRow}
              testID={testID ? `${testID}-disconnect` : undefined}
            >
              <Text style={styles.disconnectText}>Disconnect</Text>
            </Pressable>
          )}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// Phase 7.9: theme 連動 styles factory
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    // Phase 7.6: backdrop は alpha を Animated で駆動するため不透明色 + opacity 分離
    backdropBase: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "#000",
    },
    card: {
      position: "absolute",
      right: 14,
      width: 280,
      backgroundColor: c.bgCard,
      borderRadius: RADIUS.lg,
      padding: 14,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
      // Phase 7.6: drink button (右上) を支点に scale させる
      transformOrigin: "top right",
      shadowColor: "rgba(0,0,0,0.18)",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 1,
      shadowRadius: 18,
      elevation: 12,
    },
    scroll: {
      maxHeight: SCREEN_H * 0.6,
    },
    cardBlur: {
      ...StyleSheet.absoluteFill,
      borderRadius: RADIUS.lg,
    },
    cardTint: {
      ...StyleSheet.absoluteFill,
      backgroundColor: c.bgCard,
      borderRadius: RADIUS.lg,
    },
    cardHighlight: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 1,
      backgroundColor: "rgba(255,255,255,0.65)",
    },
    heading: {
      color: c.textMuted,
      fontFamily: FONT.heading,
      fontSize: FONT_SIZE.overline,
      fontWeight: WEIGHT.bold,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: SPACE.sm,
      marginLeft: 2,
    },
    walletsSection: {
      gap: SPACE.xs,
      marginBottom: SPACE.xs,
    },
    walletRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: withAlpha(c.textOnColor, 0.6),
      borderRadius: RADIUS.md,
      padding: 10,
      borderWidth: 1,
      borderColor: c.border,
    },
    iconDark: {
      width: 36,
      height: 36,
      borderRadius: RADIUS.md,
      backgroundColor: c.textPrimary,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    iconLetter: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    walletMain: {
      flex: 1,
      gap: 1,
    },
    walletLabel: {
      color: c.textMuted,
      fontFamily: FONT.body,
      fontSize: 11,
    },
    walletProvider: {
      color: c.textPrimary,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      fontSize: FONT_SIZE.bodyMD,
    },
    walletAddress: {
      color: c.textMuted,
      fontFamily: FONT.mono,
      fontSize: FONT_SIZE.bodySM,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.melonText,
      marginLeft: SPACE.xs,
    },
    // watch-only mode
    iconWatch: {
      backgroundColor: c.caramel,
    },
    statusDotWatch: {
      backgroundColor: c.caramel,
    },
    watchSection: {
      gap: SPACE.xs,
      marginTop: SPACE.xs,
    },
    watchInputRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    watchInput: {
      flex: 1,
      minWidth: 0,
      color: c.textPrimary,
      fontFamily: FONT.mono,
      fontSize: FONT_SIZE.bodySM,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: RADIUS.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: withAlpha(c.textOnColor, 0.6),
    },
    watchBtn: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: RADIUS.pill,
      backgroundColor: c.sodaText,
    },
    watchBtnDisabled: {
      opacity: 0.45,
    },
    watchBtnText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    watchRow: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: RADIUS.md,
      paddingLeft: 10,
      paddingRight: 6,
    },
    watchRowActive: {
      backgroundColor: withAlpha(c.caramel, 0.1),
    },
    watchRowMain: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
      paddingVertical: 6,
    },
    watchRowAddress: {
      flexShrink: 1,
      color: c.textPrimary,
      fontFamily: FONT.mono,
      fontSize: FONT_SIZE.bodySM,
    },
    watchTag: {
      color: c.caramel,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.semibold,
      fontSize: 11,
    },
    watchTagConnected: {
      color: c.melonText,
    },
    watchRemove: {
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    watchRemoveText: {
      color: c.textMuted,
      fontFamily: FONT.heading,
      fontSize: FONT_SIZE.bodyLG,
    },
    stopWatchingText: {
      color: c.textMuted,
    },
    addRow: {
      flexDirection: "row",
      alignItems: "center",
      padding: 10,
      marginTop: SPACE.xs,
      borderRadius: RADIUS.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: withAlpha(c.textOnColor, 0.4),
    },
    addBadge: {
      width: 36,
      height: 36,
      borderRadius: RADIUS.md,
      backgroundColor: c.sodaLight,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    addBadgePlus: {
      fontSize: 22,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.sodaText,
      lineHeight: 24,
    },
    subBtn: {
      marginTop: SPACE.sm,
      paddingVertical: 10,
      borderRadius: RADIUS.pill,
      // Phase 7.9: melonDeep は theme palette 外なので melonText (CTA primary) にマップ
      backgroundColor: c.melonText,
      alignItems: "center",
    },
    subBtnText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    // 8.77: 接続失敗の残留表示 (toast は 2200ms で消えるため)
    errorRow: {
      backgroundColor: withAlpha(c.cherryDark, 0.1),
      borderRadius: RADIUS.md,
      borderWidth: 1,
      borderColor: withAlpha(c.cherryDark, 0.35),
      padding: 10,
      marginBottom: SPACE.xs,
    },
    errorText: {
      color: c.cherryDark,
      fontFamily: FONT.body,
      fontSize: FONT_SIZE.bodySM,
    },
    // Phase 8.5.1: Disconnect 行 (cherryDark で警告系)
    disconnectRow: {
      marginTop: SPACE.xs,
      paddingVertical: SPACE.xs + 2,
      alignItems: "center",
    },
    disconnectText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.cherryDark,
    },
  });
}
