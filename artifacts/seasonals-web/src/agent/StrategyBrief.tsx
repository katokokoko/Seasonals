/**
 * StrategyBrief — Agent の戦略を人が読める形で (英語)。数字は BFF が実データから決定的に組んだもの
 * (before → after、USD 加重 APY、Aqua sleeve、カレンダー上の次の予定)。ここでは表示だけ。
 */
import type { EthPortfolioLine, EthStrategyBrief } from "@workspace/lib/types";
import { formatPercentage } from "@workspace/lib/utils/numeric";
import { fmtAmount, fmtDate, fmtRatio, fmtUsd } from "../ui/format";

function Cell({ line }: { line: EthPortfolioLine | undefined }) {
  if (!line) return <td className="cell-num muted">—</td>;
  return (
    <td className="cell-num">
      <span className="small">{line.amounts.map((a) => fmtAmount(a)).join(" + ")}</span>
      <span className={`small ${line.usd === null ? "muted" : ""}`}>
        {line.usd === null ? "not priced" : `${line.approx ? "≈" : ""}${fmtUsd(line.usd)}`}
      </span>
    </td>
  );
}

export function StrategyBrief({ brief }: { brief: EthStrategyBrief }) {
  const keys = [...new Set([...brief.before.lines, ...brief.after.lines].map((l) => l.key))];
  const { before, after, delta } = brief.blendedApy;
  return (
    <div className="strategy-brief">
      <table className="data-table brief-table">
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col" className="cell-num">
              Before
            </th>
            <th scope="col" className="cell-num">
              After
            </th>
            <th scope="col" className="cell-num">
              APY
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const b = brief.before.lines.find((l) => l.key === k);
            const a = brief.after.lines.find((l) => l.key === k);
            const l = (a ?? b)!;
            return (
              <tr key={k}>
                <td>
                  {l.label}
                  {l.pending ? <span className="muted small"> · pending</span> : null}
                </td>
                <Cell line={b} />
                <Cell line={a} />
                <td className="cell-num">{l.apy === null ? <span className="muted">{l.apyLabel ?? "—"}</span> : fmtRatio(l.apy)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="cell-num">{brief.before.totalUsd === null ? "—" : fmtUsd(brief.before.totalUsd)}</td>
            <td className="cell-num">{brief.after.totalUsd === null ? "—" : fmtUsd(brief.after.totalUsd)}</td>
            <td />
          </tr>
          <tr>
            <th scope="row">Blended APY</th>
            <td className="cell-num">{before === null ? "—" : fmtRatio(before)}</td>
            <td className="cell-num">
              {after === null ? "—" : fmtRatio(after)}
              {delta !== null && (
                <span className={`small ${delta >= 0 ? "delta-up" : "delta-down"}`}> ({formatPercentage(delta, { signDisplay: "always" })} pts)</span>
              )}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
      {brief.blendedApy.excluded.length > 0 && <p className="muted small">Not counted in the blend (no rate): {brief.blendedApy.excluded.join(", ")}.</p>}
      {brief.aqua && (
        <p className="small">
          <strong>1inch Aqua LP sleeve:</strong> {fmtAmount(brief.aqua.usdc)} + {fmtAmount(brief.aqua.usde)} · ±{(brief.aqua.bandBps / 100).toFixed(2)}% band ·{" "}
          {brief.aqua.feeBps} bps fee · review on {fmtDate(new Date(brief.aqua.reviewAt))}
          <span className="muted"> · {brief.aqua.peg}</span>
        </p>
      )}
      {brief.horizon.length > 0 && (
        <div className="small">
          <strong>On your calendar after this</strong>
          <ul className="plain-list">
            {brief.horizon.map((h) => (
              <li key={`${h.at}|${h.label}`}>
                {fmtDate(new Date(h.at))}
                {h.approx ? " (≈)" : ""} — {h.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.unpriced.length > 0 && <p className="muted small">Not priced (excluded from totals): {brief.unpriced.join(", ")}.</p>}
      {brief.warnings.length > 0 && (
        <ul className="plan-warnings small">
          {brief.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
