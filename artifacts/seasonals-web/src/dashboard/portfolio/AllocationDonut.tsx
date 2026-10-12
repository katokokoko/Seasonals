/**
 * Allocation donut — category 別の構成 (Seeker の AllocationDonut と同じ区分・色)。
 *
 * category 色は Seeker と共有 (lib COLOR_BY_CATEGORY) だが、色だけでは見分けにくい
 * 組み合わせがある (caramel / melonDeep 等) ので、**凡例に名前・割合・金額を必ず並べ**、
 * segment 間に地色の 2px の隙間を入れる。下の holdings 表が table view を兼ねる。
 */
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { COLOR } from "@workspace/lib/design-system";
import type { AllocationSegment } from "@workspace/lib/derive/portfolio";
import { fmtUsd } from "../../ui/format";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SIZE = 184;

function percent(value: number, total: number): string {
  if (!(total > 0)) return "—";
  const p = (value / total) * 100;
  return p > 0 && p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`;
}

export function AllocationDonut({ segments, totalUsd8 }: { segments: AllocationSegment[]; totalUsd8: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className="allocation" data-testid="allocation">
      <div className="allocation-ring" style={{ width: SIZE, height: SIZE }}>
        <PieChart width={SIZE} height={SIZE}>
          <Pie
            data={segments}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={SIZE / 2 - 26}
            outerRadius={SIZE / 2 - 2}
            startAngle={90}
            endAngle={-270}
            stroke={COLOR.bgPrimary}
            strokeWidth={2}
            isAnimationActive={false}
          >
            {segments.map((s) => (
              <Cell key={s.category} fill={s.color} />
            ))}
          </Pie>
          <Tooltip
            isAnimationActive={false}
            content={({ active, payload }) => {
              const s = payload?.[0]?.payload as AllocationSegment | undefined;
              if (!active || !s) return null;
              return (
                <div className="chart-tooltip">
                  <div className="chart-tooltip-date">{s.label}</div>
                  <div className="chart-tooltip-value">{USD.format(s.value)}</div>
                  <div className="chart-tooltip-flow">{percent(s.value, total)}</div>
                </div>
              );
            }}
          />
        </PieChart>
        <div className="allocation-center" aria-hidden="true">
          <span className="allocation-center-label">Total</span>
          <span className="allocation-center-value">{fmtUsd(totalUsd8)}</span>
        </div>
      </div>
      <ul className="allocation-legend" aria-label="Allocation by category">
        {segments.map((s) => (
          <li key={s.category}>
            <span className="allocation-swatch" style={{ background: s.color }} aria-hidden="true" />
            <span className="allocation-label">{s.label}</span>
            <span className="allocation-pct">{percent(s.value, total)}</span>
            <span className="allocation-usd">{USD.format(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
