/**
 * AllocationDonut (web) — recharts 版
 *
 * Metro が web platform で resolve すると本ファイルが優先採用される。
 * native (Android / iOS) では AllocationDonut.tsx (react-native-svg) が使われる。
 */

import React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import type { AllocationSegment } from "./allocation";

export interface AllocationDonutProps {
  segments: AllocationSegment[];
  size: number;
  thickness?: number;
  testID?: string;
}

export function AllocationDonut({
  segments,
  size,
  thickness = 22,
  testID,
}: AllocationDonutProps) {
  const outerRadius = size / 2 - 2;
  const innerRadius = outerRadius - thickness;
  return (
    <div data-testid={testID} style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={segments}
            dataKey="sol"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            startAngle={90}
            endAngle={-270}
            stroke="none"
            isAnimationActive={false}
          >
            {segments.map((seg) => (
              <Cell key={seg.category} fill={seg.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
