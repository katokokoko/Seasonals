/**
 * Charts — native (Android / iOS) 用 portfolio time-series chart
 *
 * react-native-svg で Path 直書き。past = solid sodaText line + sodaText fade fill、
 * future = dashed melonText line。past と future の繋ぎ目を today (vertical reference) に。
 *
 * Charts.web.tsx は recharts ベース、同 Props で同 data を render。
 */

import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, {
  Defs,
  LinearGradient,
  Path,
  Stop,
  Line,
} from "react-native-svg";
import { format } from "date-fns";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  WEIGHT,
} from "@workspace/lib/design-system";

import {
  chartBounds,
  type PortfolioPoint,
} from "./portfolioTimeSeries";

export interface ChartsProps {
  data: PortfolioPoint[];
  width: number;
  height: number;
  testID?: string;
}

const PADDING_LEFT = 40;
const PADDING_RIGHT = 12;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 28;

export function Charts({ data, width, height, testID }: ChartsProps) {
  const { paths, yLabels, xLabels } = useMemo(() => {
    if (data.length === 0) {
      return { paths: null, yLabels: [], xLabels: [] };
    }

    const { minSol, maxSol } = chartBounds(data);
    const innerW = width - PADDING_LEFT - PADDING_RIGHT;
    const innerH = height - PADDING_TOP - PADDING_BOTTOM;

    const xOf = (idx: number) =>
      PADDING_LEFT + (idx / (data.length - 1)) * innerW;
    const yOf = (sol: number) =>
      PADDING_TOP +
      innerH -
      ((sol - minSol) / (maxSol - minSol)) * innerH;

    const past: PortfolioPoint[] = [];
    const future: PortfolioPoint[] = [];
    let pivotIdx = -1;
    data.forEach((p, i) => {
      if (p.isFuture) {
        if (pivotIdx === -1) pivotIdx = i;
        future.push(p);
      } else {
        past.push(p);
      }
    });
    // past の最後の点を future の起点に追加して連続線にする
    const futureWithPivot =
      past.length > 0 ? [past[past.length - 1]!, ...future] : future;

    const buildD = (pts: PortfolioPoint[], offset: number): string => {
      if (pts.length === 0) return "";
      return pts
        .map((p, i) => {
          const idx = offset + i;
          const x = xOf(idx);
          const y = yOf(p.sol);
          return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(" ");
    };

    const pastD = buildD(past, 0);
    const futureD = buildD(futureWithPivot, past.length - 1);

    // past area fill (sodaText fade、x 軸まで閉じる)
    const lastPastIdx = past.length - 1;
    const firstX = xOf(0);
    const lastPastX = lastPastIdx >= 0 ? xOf(lastPastIdx) : firstX;
    const baseY = PADDING_TOP + innerH;
    const fillD =
      pastD.length > 0
        ? `${pastD} L ${lastPastX.toFixed(1)} ${baseY.toFixed(1)} L ${firstX.toFixed(1)} ${baseY.toFixed(1)} Z`
        : "";

    // pivot line (今日の縦の参照線)
    const pivotX = past.length > 0 ? xOf(past.length - 1) : null;

    // y 軸 label (4 段)
    const yTicks = 4;
    const yLabels = Array.from({ length: yTicks }, (_, i) => {
      const sol = minSol + ((maxSol - minSol) * (yTicks - 1 - i)) / (yTicks - 1);
      const y = yOf(sol);
      return { sol, y };
    });

    // x 軸 label (5-7 個間引き)
    const xTickCount = Math.min(7, data.length);
    const xStep = Math.max(1, Math.floor((data.length - 1) / (xTickCount - 1)));
    const xLabelArr: { x: number; date: Date }[] = [];
    for (let i = 0; i < data.length; i += xStep) {
      xLabelArr.push({ x: xOf(i), date: data[i]!.date });
    }

    return {
      paths: { fillD, pastD, futureD, pivotX, baseY },
      yLabels,
      xLabels: xLabelArr,
    };
  }, [data, width, height]);

  if (!paths) {
    return <View style={[styles.container, { width, height }]} testID={testID} />;
  }

  return (
    <View
      style={[styles.container, { width, height }]}
      testID={testID}
      pointerEvents="none"
    >
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="sodaFade" x1="0" y1="0" x2="0" y2="1">
            <Stop
              offset="0%"
              stopColor={COLOR.sodaText}
              stopOpacity={0.45}
            />
            <Stop
              offset="100%"
              stopColor={COLOR.sodaText}
              stopOpacity={0.04}
            />
          </LinearGradient>
        </Defs>

        {/* y 軸 grid lines (薄い水平線) */}
        {yLabels.map((tick, i) => (
          <Line
            key={`grid-${i}`}
            x1={PADDING_LEFT}
            y1={tick.y}
            x2={width - PADDING_RIGHT}
            y2={tick.y}
            stroke={COLOR.divider}
            strokeWidth={1}
          />
        ))}

        {/* past 下部 fade fill */}
        {paths.fillD && <Path d={paths.fillD} fill="url(#sodaFade)" />}

        {/* past line (solid, sodaText) — prototype と一致するよう strokeWidth 強化 */}
        {paths.pastD && (
          <Path
            d={paths.pastD}
            stroke={COLOR.sodaText}
            strokeWidth={3.5}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* future line (dashed, melonText) */}
        {paths.futureD && (
          <Path
            d={paths.futureD}
            stroke={COLOR.melonText}
            strokeWidth={3.5}
            fill="none"
            strokeDasharray="6 4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* pivot vertical line at today */}
        {paths.pivotX !== null && (
          <Line
            x1={paths.pivotX}
            y1={PADDING_TOP}
            x2={paths.pivotX}
            y2={paths.baseY}
            stroke={COLOR.borderStrong}
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        )}
      </Svg>

      {/* y 軸 label (Text overlay、SVG 外で flex 配置の方が control しやすい) */}
      {yLabels.map((tick, i) => (
        <Text
          key={`y-${i}`}
          style={[
            styles.yLabel,
            { top: tick.y - 8, left: 4 },
          ]}
        >
          {tick.sol.toFixed(2)}
          {"\n"}SOL
        </Text>
      ))}

      {/* x 軸 label */}
      {xLabels.map((tick, i) => (
        <Text
          key={`x-${i}`}
          style={[styles.xLabel, { left: tick.x - 14, top: height - 16 }]}
        >
          {format(tick.date, "M/d")}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
  },
  yLabel: {
    position: "absolute",
    fontSize: 8,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.regular,
    color: COLOR.textMuted,
    width: 36,
    lineHeight: 9,
  },
  xLabel: {
    position: "absolute",
    fontSize: 9,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
    textAlign: "center",
    width: 28,
  },
});
