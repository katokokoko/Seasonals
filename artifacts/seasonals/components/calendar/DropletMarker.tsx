/**
 * DropletMarker — 仕様書 §5.3 / §9.3
 *
 * カレンダーセル上の time event の visual marker。
 * 8 つの TimeEventCategory + deposit_history 補助表示 = 9 形状を SVG で描く。
 *
 * §32.2 整合性チェック「8 categories of time」を視覚的に担保する核要素。
 *
 * 設計原則:
 * - viewBox 24x24 で標準化、size prop で表示サイズ可変 (default 8px)
 * - urgency に応じた color 変化 (info / watch / critical)
 * - color prop で urgency override 可能 (custom theme / branding)
 * - accessibilityLabel は default で i18n 済み日本語ラベル、custom 上書き可
 * - lockup_end は maturity と同じ形状の outlined 版 (両者を区別する重要な差)
 *
 * @see docs/spec.md §5.3 (カレンダー表示 / 雫ドット仕様)
 * @see docs/spec.md §9.3 (Time Event Marker)
 * @see docs/design-system.md §7 (Time Event Marker token)
 */

import React from "react";
import { Svg, Circle, Path, Rect } from "react-native-svg";

import type { TimeEventCategory, Urgency } from "@workspace/lib/types";
import { COLOR, urgencyColor } from "@workspace/lib/design-system";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Droplet 描画対象。
 * - 8 つの TimeEventCategory: maturity / epoch / claim / health /
 *   vesting_cliff / vote_deadline / lockup_end / forecast_marker
 * - 補助表示: deposit_history (TimeEventCategory ではない、§5.3)
 */
export type DropletShape = TimeEventCategory | "deposit_history";

export interface DropletMarkerProps {
  /** 9 形状のいずれか */
  category: DropletShape;
  /** 緊急度 — color 決定に使う */
  urgency: Urgency;
  /** 表示サイズ (px)。default 8。カレンダーセル内では 6-10px が想定範囲 */
  size?: number;
  /** color の override (urgency 由来の color を上書き) */
  color?: string;
  /** test 用 ID */
  testID?: string;
  /**
   * accessibility label。default は日本語の category 名。
   * i18n が入った段階で UI 側から localized string を渡すこと。
   */
  accessibilityLabel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default accessibility labels (i18n 前の placeholder)
// ─────────────────────────────────────────────────────────────────────────────

const SHAPE_LABEL: Record<DropletShape, string> = {
  maturity: "Maturity",
  lockup_end: "Lockup end",
  epoch: "Epoch boundary",
  claim: "Claim deadline",
  health: "Health alert",
  vesting_cliff: "Vesting cliff",
  vote_deadline: "Vote deadline",
  forecast_marker: "Forecast",
  deposit_history: "Deposit",
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

// 8.81: props は全て primitive — memo 化で月送り時の SVG 再レンダーを reconcile に抑える
export const DropletMarker = React.memo(function DropletMarker({
  category,
  urgency,
  size = 8,
  color: colorProp,
  testID,
  accessibilityLabel,
}: DropletMarkerProps) {
  // health は prototype の "subtle warning" を踏襲: critical でも caramel に固定 (red triangle 化を避ける)
  const color =
    colorProp ?? (category === "health" ? COLOR.caramel : urgencyColor(urgency));
  const label = accessibilityLabel ?? SHAPE_LABEL[category];

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      {renderShape(category, color)}
    </Svg>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderShape(shape: DropletShape, color: string): React.ReactNode {
  switch (shape) {
    case "maturity":
      // 左に尖った雫 (filled)
      // 左尖端 (4,12) → 上半弧 → 右ふくらみ (18,12) → 下半弧 → 戻る
      return (
        <Path
          d="M 4 12 Q 12 4 18 12 Q 12 20 4 12 Z"
          fill={color}
          testID="droplet-shape-maturity"
        />
      );

    case "lockup_end":
      // 左に尖った雫 (outlined) — maturity と区別する
      return (
        <Path
          d="M 4 12 Q 12 4 18 12 Q 12 20 4 12 Z"
          fill="none"
          stroke={color}
          strokeWidth={2}
          testID="droplet-shape-lockup-end"
        />
      );

    case "epoch":
      // 円形ドット
      return (
        <Circle
          cx={12}
          cy={12}
          r={8}
          fill={color}
          testID="droplet-shape-epoch"
        />
      );

    case "claim":
      // 上半円ドット
      // (4,12) から円弧で (20,12) まで描き、下を直線で閉じる
      return (
        <Path
          d="M 4 12 A 8 8 0 0 1 20 12 Z"
          fill={color}
          testID="droplet-shape-claim"
        />
      );

    case "health":
      // 横長 pill — prototype の caramel 小印を踏襲。red triangle ではなく
      // 控えめな warning indicator として表現する (caramel 固定は color 解決側で)。
      return (
        <Rect
          x={3}
          y={9}
          width={18}
          height={6}
          rx={3}
          fill={color}
          testID="droplet-shape-health"
        />
      );

    case "vesting_cliff":
      // ダイヤモンド型
      return (
        <Path
          d="M 12 2 L 22 12 L 12 22 L 2 12 Z"
          fill={color}
          testID="droplet-shape-vesting-cliff"
        />
      );

    case "vote_deadline":
      // 旗型 — 棒 (左) + 三角フラグ (右上)
      return (
        <React.Fragment>
          <Path
            d="M 4 2 L 4 22"
            stroke={color}
            strokeWidth={2}
            testID="droplet-shape-vote-deadline-pole"
          />
          <Path
            d="M 5 4 L 18 8 L 5 12 Z"
            fill={color}
            testID="droplet-shape-vote-deadline-flag"
          />
        </React.Fragment>
      );

    case "forecast_marker":
      // 点線丸 — 予測を表す uncertain な visual
      return (
        <Circle
          cx={12}
          cy={12}
          r={7}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeDasharray="2 2"
          testID="droplet-shape-forecast-marker"
        />
      );

    case "deposit_history":
      // 右に尖った雫 — maturity と左右対称、ポジション履歴の「過去側」を示す
      return (
        <Path
          d="M 20 12 Q 12 4 6 12 Q 12 20 20 12 Z"
          fill={color}
          testID="droplet-shape-deposit-history"
        />
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: 全 9 形状を export (visual showcase / snapshot test 用)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §32.2 整合性チェック「8 categories of time」+ 補助 1 種を網羅するための
 * canonical な配列。テストでこれを iterate することで、新しい
 * TimeEventCategory が enum に追加された場合に static type error として検出される
 * (TIME_EVENT_CATEGORIES の length 変化を `lib/types/enums.ts` 経由で検知)。
 */
export const ALL_DROPLET_SHAPES: readonly DropletShape[] = [
  "maturity",
  "epoch",
  "claim",
  "health",
  "vesting_cliff",
  "vote_deadline",
  "lockup_end",
  "forecast_marker",
  "deposit_history",
] as const;
