/**
 * Charts (web) — recharts 版 portfolio time-series chart
 *
 * Metro が web platform で resolve すると本ファイルが Charts.tsx の代わりに採用される。
 * native (Android / iOS) では Charts.tsx (react-native-svg) が使われる。
 *
 * 同 Props を受け取り同じ time-series を描画する。past = solid sodaText line、
 * future = dashed melonText line。
 */

import React, { useMemo } from "react";
import { format } from "date-fns";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";

import { COLOR } from "@workspace/lib/design-system";

import type { CurrencyUnit } from "./allocation";
import {
  chartBounds,
  formatAxisValue,
  type PortfolioPoint,
} from "./portfolioTimeSeries";

export interface ChartsProps {
  data: PortfolioPoint[];
  /** 8.55: y 軸ラベルの通貨単位 (USDC ↔ SOL トグルに追従、data と同じ建て) */
  unit: CurrencyUnit;
  width: number;
  height: number;
  testID?: string;
}

interface RechartsRow {
  date: string;
  value: number;
  pastValue: number | null;
  futureValue: number | null;
}

export function Charts({ data, unit, width, height, testID }: ChartsProps) {
  const { rows, todayLabel, bounds } = useMemo(() => {
    const todayIndex = data.findIndex((p) => p.isFuture) - 1;
    const pivot = todayIndex >= 0 ? data[todayIndex] : null;

    const rows: RechartsRow[] = data.map((p) => ({
      date: format(p.date, "M/d"),
      value: p.value,
      pastValue: p.isFuture ? null : p.value,
      futureValue: p.isFuture
        ? p.value
        : pivot && p === pivot
          ? p.value // pivot は past / future 両方に乗せて line を連続させる
          : null,
    }));
    return {
      rows,
      todayLabel: pivot ? format(pivot.date, "M/d") : null,
      bounds: chartBounds(data),
    };
  }, [data]);

  return (
    <div data-testid={testID} style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 16, right: 12, left: 0, bottom: 8 }}
        >
          <CartesianGrid stroke={COLOR.divider} vertical={false} />
          <XAxis
            dataKey="date"
            stroke={COLOR.textMuted}
            tick={{ fontSize: 9 }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke={COLOR.textMuted}
            domain={[bounds.minValue, bounds.maxValue]}
            tick={{ fontSize: 9 }}
            tickFormatter={(v: number) => `${formatAxisValue(v)} ${unit}`}
            width={54}
          />
          {todayLabel && (
            <ReferenceLine
              x={todayLabel}
              stroke={COLOR.borderStrong}
              strokeDasharray="2 3"
            />
          )}
          <Line
            type="monotone"
            dataKey="pastValue"
            stroke={COLOR.sodaText}
            strokeWidth={3.5}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="futureValue"
            stroke={COLOR.melonText}
            strokeWidth={3.5}
            strokeDasharray="6 4"
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
