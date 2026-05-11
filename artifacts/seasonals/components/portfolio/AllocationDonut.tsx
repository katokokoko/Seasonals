/**
 * AllocationDonut — native (Android / iOS) 用 donut chart
 *
 * react-native-svg の Path で arc を直接描く。中心穴あり (donut)。
 * Charts.web.tsx と同 props を採用、web 側は recharts <Pie> で同等表現。
 */

import React, { useMemo } from "react";
import { View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import type { AllocationSegment } from "./allocation";

export interface AllocationDonutProps {
  segments: AllocationSegment[];
  /** chart 全体の正方形サイズ (px) */
  size: number;
  /** donut 厚み (default 22px) */
  thickness?: number;
  testID?: string;
}

/** 角度 (radians) → 円周上の点 (cx,cy) を中心とする半径 r 上の (x, y) */
function polar(cx: number, cy: number, r: number, rad: number) {
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

/** SVG arc path 文字列を生成 (donut 1 segment 分) */
function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startRad: number,
  endRad: number
): string {
  const largeArc = endRad - startRad > Math.PI ? 1 : 0;
  const p1 = polar(cx, cy, rOuter, startRad);
  const p2 = polar(cx, cy, rOuter, endRad);
  const p3 = polar(cx, cy, rInner, endRad);
  const p4 = polar(cx, cy, rInner, startRad);
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

export function AllocationDonut({
  segments,
  size,
  thickness = 22,
  testID,
}: AllocationDonutProps) {
  const { paths, fullCircleSegment } = useMemo(() => {
    const total = segments.reduce((acc, s) => acc + s.value, 0);
    if (total <= 0) return { paths: [], fullCircleSegment: null };

    const cx = size / 2;
    const cy = size / 2;
    const rOuter = size / 2 - 2;
    const rInner = rOuter - thickness;

    // Phase 8.8.3: 1 segment === 100% (full circle) は SVG arc では描画できない
    // (始点 = 終点で degenerate)。Circle で代替描画。
    const positive = segments.filter((s) => s.value > 0);
    if (positive.length === 1) {
      return {
        paths: [],
        fullCircleSegment: {
          category: positive[0]!.category,
          color: positive[0]!.color,
          cx,
          cy,
          radius: (rOuter + rInner) / 2,
          strokeWidth: thickness,
        },
      };
    }

    let cursor = -Math.PI / 2; // 12 時方向開始
    const pathList = segments
      .filter((s) => s.value > 0)
      .map((seg) => {
        const sweep = (seg.value / total) * Math.PI * 2;
        const start = cursor;
        const end = cursor + sweep;
        cursor = end;
        return {
          d: arcPath(cx, cy, rOuter, rInner, start, end),
          color: seg.color,
          category: seg.category,
        };
      });
    return { paths: pathList, fullCircleSegment: null };
  }, [segments, size, thickness]);

  return (
    <View style={{ width: size, height: size }} testID={testID}>
      <Svg width={size} height={size}>
        {fullCircleSegment && (
          <Circle
            cx={fullCircleSegment.cx}
            cy={fullCircleSegment.cy}
            r={fullCircleSegment.radius}
            stroke={fullCircleSegment.color}
            strokeWidth={fullCircleSegment.strokeWidth}
            fill="none"
            testID={`${testID}-seg-${fullCircleSegment.category}`}
          />
        )}
        {paths.map((p) => (
          <Path
            key={p.category}
            d={p.d}
            fill={p.color}
            testID={`${testID}-seg-${p.category}`}
          />
        ))}
      </Svg>
    </View>
  );
}
