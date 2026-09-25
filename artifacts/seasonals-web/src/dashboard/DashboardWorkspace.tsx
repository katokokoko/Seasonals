/**
 * DashboardWorkspace — /dashboard (UI v2 §11)。
 * 表示するのは timeline から導出できる件数のみ。残高・ポジション評価額は
 * 接続されるまで出さない (架空値を出さない)。
 */
import { useNow } from "../ui/useNow";
import { deriveTimelineStatus, displayStatus } from "@workspace/lib/derive/timeline";
import { useDetail } from "../timeline/detailStore";
import { StatusBadge } from "../timeline/StatusBadge";
import { statusText } from "../timeline/labels";
import { fmtAmount, fmtFullDate, fmtUsd } from "../ui/format";
import { useTimeline } from "../services/queries";
import { WorkspaceShell } from "../shell/WorkspaceShell";
import { requestOpenWallet } from "../timeline/detailStore";
import { SourceStatusLine } from "../timeline/SourceStatusLine";
import "../agent/agent.css";

export default function DashboardWorkspace() {
  const t = useTimeline();
  const now = useNow(t.events);
  const count = (pred: (s: ReturnType<typeof deriveTimelineStatus>) => boolean) =>
    t.events.filter((e) => e.class !== "executed" && pred(deriveTimelineStatus(e, now))).length;
  const open = useDetail((st) => st.open);
  const positions = t.events.filter((e) => e.owner && e.class === "protocol" && !e.settled && e.amount);
  const week = t.events.filter((e) => {
    if (!e.at || e.class === "executed") return false;
    const d = Date.parse(e.at) - now.getTime();
    return d >= 0 && d <= 7 * 86_400_000;
  }).length;

  return (
    <WorkspaceShell title="Dashboard" subtitle="Your seasonal snapshot">
      <div className="panel-block">
        {!t.hasWallet && (
          <p className="connect-note">
            Connect your wallet to include your own positions.{" "}
            <button type="button" className="btn-link" onClick={requestOpenWallet}>
              Connect wallet
            </button>
          </p>
        )}
        <div className="stat-row">
          <Stat label="Needs attention" value={count((s) => s === "overdue" || s === "due")} />
          <Stat label="Next 7 days" value={week} />
          <Stat label="Upcoming (all)" value={count((s) => s === "upcoming")} />
          <Stat label="Executed (history)" value={t.events.filter((e) => e.class === "executed").length} />
        </div>
        <section aria-labelledby="dated-positions">
          <h2 id="dated-positions" className="section-heading">
            Dated positions
          </h2>
          <p className="muted small">
            Positions that have a date attached (maturity, cooldown, withdrawal, auction), read from each protocol. Values appear only where the protocol
            reports them; nothing is estimated.
          </p>
          {positions.length === 0 ? (
            <p className="muted">No dated positions for the watched addresses.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Protocol</th>
                  <th scope="col">Position</th>
                  <th scope="col" className="cell-num">
                    Amount
                  </th>
                  <th scope="col" className="cell-num">
                    Value (USD)
                  </th>
                  <th scope="col">Date</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((e) => {
                  const st = deriveTimelineStatus(e, now);
                  return (
                    <tr key={e.id}>
                      <td>{e.protocolName}</td>
                      <td>
                        <button type="button" className="btn-link" onClick={(ev) => open({ kind: "event", eventId: e.id }, ev.currentTarget)}>
                          {e.asset ?? e.title}
                        </button>
                      </td>
                      <td className="cell-num">{e.amount ? fmtAmount(e.amount) : "—"}</td>
                      <td className="cell-num">{e.usd ? fmtUsd(e.usd) : "—"}</td>
                      <td>{e.at ? `${e.atApprox ? "≈ " : ""}${fmtFullDate(new Date(e.at))}` : "ETA unknown"}</td>
                      <td>
                        <StatusBadge status={displayStatus(e, st)} label={statusText(e, st)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted small">Portfolio value and exposure across positions without dates are not connected yet.</p>
        </section>
        <SourceStatusLine sources={t.sources} />
      </div>
    </WorkspaceShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
