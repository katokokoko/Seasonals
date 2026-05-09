/**
 * HeaderIcons — prototype の header right pill 内 3 アイコン
 *
 * 1. GridIcon       : 4-cell grid (apps grid 様)
 * 2. PhoneIcon      : 縦 rectangle with rounded corners + bottom dot (smartphone)
 * 3. SodaGlassIcon  : cream-soda mascot drink (cup + foam dome + cherry)
 *
 * react-native-svg primitives で実装、size prop で可変。
 * stroke / fill は currentColor 風に color prop 経由で指定。
 */

import React from "react";
import Svg, {
  Circle,
  Path,
  Rect,
} from "react-native-svg";

import { COLOR } from "@workspace/lib/design-system";

interface IconProps {
  size?: number;
  color?: string;
}

export function GridIcon({ size = 18, color = COLOR.textSubtitle }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={3} y={3} width={8} height={8} rx={1.5} stroke={color} strokeWidth={1.6} fill="none" />
      <Rect x={13} y={3} width={8} height={8} rx={1.5} stroke={color} strokeWidth={1.6} fill="none" />
      <Rect x={3} y={13} width={8} height={8} rx={1.5} stroke={color} strokeWidth={1.6} fill="none" />
      <Rect x={13} y={13} width={8} height={8} rx={1.5} stroke={color} strokeWidth={1.6} fill="none" />
    </Svg>
  );
}

export function PhoneIcon({ size = 18, color = COLOR.textSubtitle }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect
        x={6}
        y={2}
        width={12}
        height={20}
        rx={2.5}
        stroke={color}
        strokeWidth={1.6}
        fill="none"
      />
      {/* speaker slit */}
      <Path
        d="M 10 5 L 14 5"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      {/* home dot */}
      <Circle cx={12} cy={19} r={0.9} fill={color} />
    </Svg>
  );
}

/**
 * SodaGlassIcon — Seasonals brand mascot icon (cream soda)
 * cup body + foam dome + cherry on top
 */
export function SodaGlassIcon({ size = 18, color = COLOR.caramel }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* cup body (台形) */}
      <Path
        d="M 7 11 L 17 11 L 16 21 L 8 21 Z"
        stroke={color}
        strokeWidth={1.6}
        fill="none"
        strokeLinejoin="round"
      />
      {/* soda fluid line */}
      <Path
        d="M 8.3 14.5 L 15.7 14.5"
        stroke={color}
        strokeWidth={1.2}
        opacity={0.6}
      />
      {/* foam dome */}
      <Path
        d="M 7 11 Q 8 8 10 8.5 Q 11 7 13 8 Q 15 7.5 16 9 Q 17.5 10 17 11 Z"
        fill={color}
        opacity={0.85}
      />
      {/* cherry */}
      <Circle cx={12} cy={6.6} r={1.5} fill={COLOR.cherryDark} />
      {/* cherry stem */}
      <Path
        d="M 12 5.2 Q 13 3.8 14 4"
        stroke={COLOR.melonText}
        strokeWidth={1}
        fill="none"
        strokeLinecap="round"
      />
    </Svg>
  );
}
