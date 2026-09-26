/**
 * 資産推移グラフ (Seeker の Charts.web.tsx と同じ recharts、UI v2 §11)。
 *
 * - 1 系列なので凡例は置かず、見出し (Total / Deposited) が系列を名指しする
 * - 入出金の段差には marker (8.65 flowMarkerIndices)。色だけに頼らず tooltip で
 *   「Deposit / Withdrawal」と金額を出す
 * - 値は BFF が復元した実データのみ。Number 化は描画直前 (display only、CLAUDE.md §3)
 * - 色は lib の COLOR token (hex 直書きしない)
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { COLOR } from "@workspace/lib/design-system";
import {
  chartBounds,
  flowMarkerIndices,
  formatAxisValue,
  type PortfolioPoint,
} from "@workspace/lib/derive/portfolio";
import { fmtCompactUsd } from "../../ui/format";

const DAY_MS = 86_400_000;
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const DATE_FULL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

interface Datum {
  t: number;
  value: number;
  flow: number;
}

export function HistoryChart({ points, height = 260 }: { points: PortfolioPoint[]; height?: number }) {
  const data: Datum[] = points.map((p) => ({ t: p.date.getTime(), value: p.value, flow: p.flow ?? 0 }));
  const { minValue, maxValue } = chartBounds(points);
  const step = (maxValue - minValue) / 4;
  // 等間隔の 5 目盛り (recharts 任せだと domain の端が混ざって間隔が不揃いになる)
  const yTicks = [0, 1, 2, 3, 4].map((i) => minValue + step * i);
  const spanMs = data.length > 1 ? data[data.length - 1]!.t - data[0]!.t : 0;
  const tickDate = (t: number) => (spanMs < 2 * DAY_MS ? DATE_TIME : DATE).format(new Date(t));
  // 軸の表記は系列全体で揃える (1 本の軸に "$11.4K" と "$9381" を混ぜない)
  const compact = Math.max(Math.abs(minValue), Math.abs(maxValue)) >= 10_000;
  const tickValue = (v: number) => (compact ? fmtCompactUsd(v) : `$${formatAxisValue(v, step)}`);
  const markers = flowMarkerIndices(points).map((i) => data[i]!);

  return (
    <div className="history-chart" data-testid="history-chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="portfolio-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR.sodaText} stopOpacity={0.24} />
              <stop offset="100%" stopColor={COLOR.sodaText} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={COLOR.border} strokeDasharray="0" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={tickDate}
            tick={{ fill: COLOR.textMuted, fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            minTickGap={48}
          />
          <YAxis
            domain={[minValue, maxValue]}
            tickFormatter={tickValue}
            tick={{ fill: COLOR.textMuted, fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            width={72}
            ticks={yTicks}
            interval={0}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: COLOR.borderStrong, strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={COLOR.sodaText}
            strokeWidth={2}
            fill="url(#portfolio-fill)"
            isAnimationActive={false}
            activeDot={{ r: 4, fill: COLOR.sodaText, stroke: COLOR.bgPrimary, strokeWidth: 2 }}
          />
          {markers.map((m) => (
            <ReferenceDot
              key={m.t}
              x={m.t}
              y={m.value}
              r={5}
              fill={m.flow > 0 ? COLOR.melonText : COLOR.cherryDark}
              stroke={COLOR.bgPrimary}
              strokeWidth={2}
              ifOverflow="extendDomain"
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Datum }> }) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{DATE_FULL.format(new Date(d.t))}</div>
      <div className="chart-tooltip-value">{USD.format(d.value)}</div>
      {d.flow !== 0 && (
        <div className="chart-tooltip-flow">
          {d.flow > 0 ? "Deposit" : "Withdrawal"} {USD.format(Math.abs(d.flow))}
        </div>
      )}
    </div>
  );
}
