/**
 * useTiltRoll — 端末のロール角 (rad) を sharedValue へ (Phase 8.36 → 8.46)
 *
 * 8.46: expo-sensors の DeviceMotion (JS スレッド listener) から Reanimated の
 * useAnimatedSensor (**UI スレッド直結**) へ移行。旧経路は
 *   native → RN bridge → JS listener → roll.value
 * で、JS スレッドが詰まる (query refetch / 再レンダー / dev モード) と
 * センサーイベントが溜まり「数秒遅れてゆっくり動く → 溜まった分が一気に来て
 * 急に動く」症状になっていた。新経路はセンサー値が UI スレッドの sharedValue に
 * 直接届くため、JS スレッドの状態に一切影響されない。
 *
 * - Android の SensorType.ROTATION は SensorManager.getOrientation() の
 *   orientation[2] を roll としてそのまま渡す (yaw/pitch は iOS 合わせで反転、
 *   roll は無反転 — ReanimatedSensorListener.java)。DeviceMotion の gamma と同じ
 *   Y 軸まわりの回転なので、旧実装の -gamma に合わせて -roll を使う。
 *   実機で逆なら TiltSensorBridge の符号を反転する
 * - 購読の gating (画面フォーカス中 かつ foreground のみ、電池) は
 *   **TiltSensorBridge の mount/unmount** で表現する — useAnimatedSensor は
 *   unmount 時に unregister するため、離脱 / background で確実に止まる
 * - rotation vector はランタイム権限不要 (旧 DeviceMotion の permission 処理は撤去)
 */

import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  SensorType,
  useAnimatedSensor,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

import { GLASS_TUNING } from "./glass-physics";

/** UI スレッドなので 60Hz でも安い (旧 33ms → 16ms) */
const SENSOR_INTERVAL_MS = 16;

export interface TiltRoll {
  /** 目標傾き (rad、±maxTilt clamp 済)。物理側の targetA に毎フレーム読ませる */
  roll: SharedValue<number>;
  /**
   * null = 未判定 (センサー登録待ち) / false = 利用不可。
   * 呼び手は true になるまで静的退避を出す (未判定中に液体を一瞬出さない — F3)
   */
  available: boolean | null;
  /** true の間だけ <TiltSensorBridge> を mount する (購読 gating の実体) */
  senseActive: boolean;
  /** TiltSensorBridge の onAvailable に渡す */
  reportAvailable: (ok: boolean) => void;
}

/**
 * センサー購読の実体 (null render)。mount 中だけ ROTATION センサーが登録され、
 * UI スレッドで sensor → roll のマッピングが走る。
 */
export function TiltSensorBridge({
  roll,
  onAvailable,
}: {
  roll: SharedValue<number>;
  onAvailable: (ok: boolean) => void;
}): null {
  const rotation = useAnimatedSensor(SensorType.ROTATION, {
    interval: SENSOR_INTERVAL_MS,
  });

  // isAvailable は ref 変異 (再レンダーを起こさない) だが、useAnimatedSensor の
  // effect → 本 effect の順で実行されるため、mount 後にはここで登録結果が読める
  useEffect(() => {
    onAvailable(rotation.isAvailable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // UI スレッド: センサー更新のたびに目標角へマッピング (JS 経由ゼロ)
  useDerivedValue(() => {
    const raw = -rotation.sensor.value.roll; // 旧 -gamma と同一の向き
    roll.value = Math.max(
      -GLASS_TUNING.maxTilt,
      Math.min(GLASS_TUNING.maxTilt, raw)
    );
  });

  return null;
}

export function useTiltRoll(enabled: boolean): TiltRoll {
  const roll = useSharedValue(0);
  const [available, setAvailable] = useState<boolean | null>(null);
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

  const reportAvailable = useCallback((ok: boolean) => {
    setAvailable(ok);
  }, []);

  return {
    roll,
    available,
    senseActive: enabled && focused && foreground,
    reportAvailable,
  };
}
