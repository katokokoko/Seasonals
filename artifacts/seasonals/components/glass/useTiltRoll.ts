/**
 * useTiltRoll — DeviceMotion からロール角 (rad) を sharedValue へ (Phase 8.36)
 *
 * ハンドオフ §4 に従い expo-sensors の DeviceMotion (rotation) を使用。
 * - app は portrait 固定 (app.config.ts orientation: "portrait") のため
 *   ロール = rotation.gamma で確定 (landscape 対応時は軸入替が必要 — コメント参照)
 * - sharedValue へ**直接代入** (MelonSodaBackground Phase 7.3 の知見:
 *   sensor 入力を withTiming で包むと animation queue thrash になる)
 * - 購読は「画面フォーカス中 かつ foreground」のみ。離脱 / background で確実に解除
 *   (電池、受け入れ基準)
 * - センサー利用不可端末では available=false を返し、呼び手は静的表示へ退避する
 */

import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { DeviceMotion } from "expo-sensors";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

import { GLASS_TUNING } from "./glass-physics";

const SENSOR_INTERVAL_MS = 33; // ~30Hz (ばね補間があるので 60Hz は不要)

export interface TiltRoll {
  /** 目標傾き (rad、±maxTilt clamp 済)。物理側の targetA に毎フレーム読ませる */
  roll: SharedValue<number>;
  /** false = センサー利用不可 (エミュレータ等) → 静的退避 */
  available: boolean;
}

export function useTiltRoll(enabled: boolean): TiltRoll {
  const roll = useSharedValue(0);
  const [available, setAvailable] = useState(true);
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(true);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [])
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) =>
      setForeground(s === "active")
    );
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!enabled || !focused || !foreground) return;
    let cancelled = false;
    let sub: { remove: () => void } | null = null;

    (async () => {
      const ok = await DeviceMotion.isAvailableAsync().catch(() => false);
      if (cancelled) return;
      if (!ok) {
        setAvailable(false);
        return;
      }
      // Android は権限不要 / iOS は初回 prompt (ユーザー操作起点)。拒否は静的退避
      const perm = await DeviceMotion.requestPermissionsAsync().catch(() => null);
      if (cancelled) return;
      if (perm && !perm.granted) {
        setAvailable(false);
        return;
      }
      setAvailable(true);
      DeviceMotion.setUpdateInterval(SENSOR_INTERVAL_MS);
      sub = DeviceMotion.addListener((m) => {
        const gamma = m.rotation?.gamma;
        if (typeof gamma !== "number" || !Number.isFinite(gamma)) return;
        // portrait 固定: roll = gamma (rad)。符号は「右に傾ける → 液が右へ寄る」
        // 向きに合わせる (プロトタイプ同様 -roll)。実機で逆なら GLASS_TUNING では
        // なくここを反転する
        const t = Math.max(
          -GLASS_TUNING.maxTilt,
          Math.min(GLASS_TUNING.maxTilt, -gamma)
        );
        roll.value = t; // 直接代入 (withTiming 禁止 — Phase 7.3 知見)
      });
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [enabled, focused, foreground, roll]);

  return { roll, available };
}
