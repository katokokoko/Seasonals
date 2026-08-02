/**
 * useReduceMotion — OS の「視差効果を減らす」設定を購読する (Phase 8.36、§2.4)
 *
 * codebase 初の AccessibilityInfo 利用。液体演出はこれが true の時
 * 静的表示 (MelonSodaBackground static) へ退避する。
 */

import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (mounted) setReduced(v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (v) => setReduced(v)
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
