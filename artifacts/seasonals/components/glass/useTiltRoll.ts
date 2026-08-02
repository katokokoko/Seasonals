/**
 * useTiltRoll — 端末の傾き (rad) を sharedValue へ (Phase 8.36 → 8.46 → 8.49)
 *
 * 8.46: expo-sensors の DeviceMotion (JS スレッド listener) から Reanimated の
 * useAnimatedSensor (**UI スレッド直結**) へ移行。旧経路は
 *   native → RN bridge → JS listener → roll.value
 * で、JS スレッドが詰まる (query refetch / 再レンダー / dev モード) と
 * センサーイベントが溜まり「数秒遅れてゆっくり動く → 溜まった分が一気に来て
 * 急に動く」症状になっていた。新経路はセンサー値が UI スレッドの sharedValue に
 * 直接届くため、JS スレッドの状態に一切影響されない。
 *
 * 8.49: 傾きの取得元を Euler の roll から **重力ベクトル** (SensorType.GRAVITY) へ
 * 変更。roll は端末を立てて持つとジンバルロック近傍で暴れ、手を 5° 動かしただけで
 * 90° 振れて maxTilt に張り付いていた (「ちょっと傾けただけで大きく揺れる」)。
 * 変換は glass-physics.ts の `tiltFromGravity` (姿勢に依らず手の動きと 1:1)。
 *
 * - 購読の gating (画面フォーカス中 かつ foreground のみ、電池) は
 *   **TiltSensorBridge の mount/unmount** で表現する — useAnimatedSensor は
 *   unmount 時に unregister するため、離脱 / background で確実に止まる
 * - gravity / linear acceleration はランタイム権限不要 (旧 DeviceMotion の
 *   permission 処理は撤去)
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

import { tiltFromGravity } from "./glass-physics";

/** UI スレッドなので 60Hz でも安い (旧 33ms → 16ms) */
const SENSOR_INTERVAL_MS = 16;

export interface TiltRoll {
  /** 目標傾き (rad、±maxTilt clamp 済)。物理側の targetA に毎フレーム読ませる */
  roll: SharedValue<number>;
  /**
   * 8.47: 端末の揺さぶりの強さ |a| (m/s²、重力除去済みなので静止時 ~0)。
   * 物理側の shake に毎フレーム読ませる (泡あふれメーターの 2 系統目の入力)
   */
  shake: SharedValue<number>;
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
  shake,
  onAvailable,
}: {
  roll: SharedValue<number>;
  shake: SharedValue<number>;
  onAvailable: (ok: boolean) => void;
}): null {
  // 8.49: ROTATION (Euler roll) から GRAVITY へ変更。roll は端末を立てて持つと
  // ジンバルロック近傍で暴れ、手を 5° 動かしただけで 90° 振れて maxTilt に張り付いて
  // いた (「ちょっと傾けただけで大きく揺れる」の原因)。詳細は tiltFromGravity の doc
  const gravity = useAnimatedSensor(SensorType.GRAVITY, {
    interval: SENSOR_INTERVAL_MS,
  });
  // 8.47: 2 本目。reanimated の ACCELEROMETER は Android の
  // TYPE_LINEAR_ACCELERATION にマップされる = **重力除去済み** (静止時 ~0)
  const accel = useAnimatedSensor(SensorType.ACCELEROMETER, {
    interval: SENSOR_INTERVAL_MS,
  });

  // 罠 (8.46 で実機実測): useAnimatedSensor は**登録 effect の中で ref.current を
  // sensor sharedValue ごと作り直す** (useAnimatedSensor.ts: effect 内で
  // `ref.current = { sensor: initializeSensor(...), ... }`)。初回 render で返る
  // オブジェクトは登録前の殻で、isAvailable は false のまま・sensor も実データが
  // 届かない方を掴んでいる。そこで mount 直後に 1 回 re-render し、登録後の実体
  // (新しい ref.current) を読み直す。
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) onAvailable(gravity.isAvailable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // sensor sharedValue を**直接ローカルに掴む** — useDerivedValue の依存とマッパー
  // 入力は worklet closure から抽出されるため、re-render 後の実体 (S2) を closure に
  // 直接入れることで、マッパーが正しい sharedValue に付き直る
  const gravitySV = gravity.sensor;
  useDerivedValue(() => {
    const g = gravitySV.value;
    // clamp は tiltFromGravity 内 (±maxTilt)
    roll.value = tiltFromGravity(g.x, g.y, g.z);
  });

  // 8.47: 揺さぶりの強さ = 並進加速度の大きさ。向きは問わないので |a| だけ見る
  // (portrait 固定 + 大きさは軸入替で不変なので interface orientation は無関係)
  const accelSV = accel.sensor;
  useDerivedValue(() => {
    const a = accelSV.value;
    shake.value = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  });

  return null;
}

export function useTiltRoll(enabled: boolean): TiltRoll {
  const roll = useSharedValue(0);
  const shake = useSharedValue(0);
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
    shake,
    available,
    senseActive: enabled && focused && foreground,
    reportAvailable,
  };
}
