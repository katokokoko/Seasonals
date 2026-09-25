/**
 * DashboardWorkspace — /dashboard (UI v2 §11)。
 * 表示するのは timeline から導出できる件数のみ。残高・ポジション評価額は
 * 接続されるまで出さない (架空値を出さない)。
 */
import { useNow } from "../ui/useNow";
import { deriveTimelineStatus } from "@workspace/lib/derive/timeline";
import { useTimeline } from "../services/queries";
import { WorkspaceShell, Notice } from "../shell/WorkspaceShell";
import { requestOpenWallet } from "../timeline/detailStore";
import { SourceStatusLine } from "../timeline/SourceStatusLine";
import "../agent/agent.css";

export default function DashboardWorkspace() {
  const t = useTimeline();
  const now = useNow(t.events);
  const count = (pred: (s: ReturnType<typeof deriveTimelineStatus>) => boolean) =>
    t.events.filter((e) => e.class !== "executed" && pred(deriveTimelineStatus(e, now))).length;
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
        <Notice title="Positions and balances are not connected yet">
          The dashboard will show position value and exposure once the position readers are wired in. Until then it shows only event counts.
        </Notice>
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
