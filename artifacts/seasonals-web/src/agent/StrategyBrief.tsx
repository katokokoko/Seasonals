/**
 * StrategyBrief — Agent の戦略を人が読める形で (英語)。数字は BFF が実データから決定的に組んだもの
 * (before → after、動かす資金 / 運用中の資金の USD 加重 APY、Aqua sleeve、カレンダー上の次の予定)。ここでは表示だけ。
 * wallet の idle 資産は APY の分母に入らない。量の変わらない line は表に出さず 1 行にまとめる
 */
import type { EthPortfolioLine, EthStrategyBrief } from "@workspace/lib/types";
import { formatPercentage, usd8ToBigInt, bigIntToUsd8 } from "@workspace/lib/utils/numeric";
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

const pct = (r: number | null) => (r === null ? "—" : fmtRatio(r));
function Delta({ d }: { d: number | null }) {
  if (d === null) return null;
  return <span className={`small ${d >= 0 ? "delta-up" : "delta-down"}`}> ({formatPercentage(d, { signDisplay: "always" })} pts)</span>;
}

/** 量が変わらない line は表から外して 1 行にまとめる */
function splitChanged(brief: EthStrategyBrief): { changed: string[]; unchanged: EthPortfolioLine[] } {
  const keys = [...new Set([...brief.before.lines, ...brief.after.lines].map((l) => l.key))];
  const changed: string[] = [];
  const unchanged: EthPortfolioLine[] = [];
  for (const k of keys) {
    const b = brief.before.lines.find((l) => l.key === k);
    const a = brief.after.lines.find((l) => l.key === k);
    const same = b && a && b.amounts.length === a.amounts.length && b.amounts.every((x, i) => x.value === a.amounts[i]!.value && x.symbol === a.amounts[i]!.symbol);
    if (same) unchanged.push(a);
    else changed.push(k);
  }
  return { changed, unchanged };
}

export function StrategyBrief({ brief }: { brief: EthStrategyBrief }) {
  const { changed, unchanged } = splitChanged(brief);
  const { moved, deployed } = brief.blendedApy;
  const unchangedUsd = bigIntToUsd8(unchanged.reduce((s, l) => s + (l.usd ? usd8ToBigInt(l.usd) : 0n), 0n));
  const movesNothing = usd8ToBigInt(moved.usd) === 0n;
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
          {changed.length === 0 && (
            <tr>
              <td className="muted" colSpan={4}>
                Nothing changes.
              </td>
            </tr>
          )}
          {changed.map((k) => {
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
            <th scope="row">{movesNothing ? "This rebalance moves nothing measurable" : `This rebalance moves ${fmtUsd(moved.usd)}`}</th>
            <td className="cell-num">{pct(moved.before)}</td>
            <td className="cell-num">
              {pct(moved.after)}
              <Delta d={moved.delta} />
            </td>
            <td />
          </tr>
          <tr>
            <th scope="row">Deployed capital (DeFi only)</th>
            <td className="cell-num">
              <span className="small">{fmtUsd(deployed.usdBefore)}</span>
              <span className="small">{pct(deployed.before)}</span>
            </td>
            <td className="cell-num">
              <span className="small">{fmtUsd(deployed.usdAfter)}</span>
              <span className="small">
                {pct(deployed.after)}
                <Delta d={deployed.delta} />
              </span>
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
      {unchanged.length > 0 && (
        <p className="muted small">
          Unchanged: {unchanged.map((l) => `${l.label} ${l.usd === null ? "not priced" : fmtUsd(l.usd)}`).join(" · ")} ({unchanged.length} position
          {unchanged.length === 1 ? "" : "s"}, {fmtUsd(unchangedUsd)}).
        </p>
      )}
      <p className="muted small">Idle wallet balances are not part of either blend.</p>
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
