/**
 * AgentWorkspace — /agent (UI v2 §11, Ethereum v3 §7 / §9)。
 * - 期日が来た / 近い event の提案 (rule-based、BFF /eth/proposal) を並べる
 * - Agent は MCP Server 経由で同じ event source を読む (list_events / get_proposal / build_action)
 */
import { deriveTimelineStatus } from "@workspace/lib/derive/timeline";
import { useTimeline } from "../services/queries";
import { WorkspaceShell, Notice } from "../shell/WorkspaceShell";
import { requestOpenWallet, useDetail } from "../timeline/detailStore";
import { ProposalPanel } from "../timeline/ProposalPanel";
import { StatusBadge } from "../timeline/StatusBadge";
import { statusText } from "../timeline/labels";
import { displayStatus } from "@workspace/lib/derive/timeline";
import { fmtFullDate } from "../ui/format";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { useNow } from "../ui/useNow";
import { AquaPanel } from "./AquaPanel";
import { ProposalInbox } from "./ProposalInbox";
import "./agent.css";

const WEEK = 7 * 86_400_000;

export default function AgentWorkspace() {
  const t = useTimeline();
  const now = useNow(t.events);
  const open = useDetail((s) => s.open);
  const candidates = t.events
    .filter((e) => e.chain === "ethereum" && e.owner && e.class === "protocol" && e.actions.length > 0)
    .filter((e) => {
      const s = deriveTimelineStatus(e, now);
      if (s === "due" || s === "overdue") return true;
      return s === "upcoming" && e.at !== null && Date.parse(e.at) - now.getTime() <= WEEK;
    })
    .slice(0, 6);

  return (
    <WorkspaceShell title="Agent" subtitle="Your seasonal companion">
      <div className="agent-grid">
        <section className="panel-block">
          <h2>Proposals from your Agent</h2>
          <p className="muted small">
            Rebalances your Agent designed over MCP. Nothing runs until you approve here (one tap) or say yes in the chat; either way it executes only on
            the local fork.
          </p>
          <ProposalInbox />
          <h2>What to do when these dates arrive</h2>
          <p className="muted small">
            Proposals are rule-based from on-chain and protocol data (no LLM is configured on this server). They never contain calldata; a transaction
            plan is built separately and always needs your signature.
          </p>
          {!t.hasWallet ? (
            <Notice title="No wallet yet">
              Watch or connect an Ethereum address to see proposals.{" "}
              <button type="button" className="btn-link" onClick={requestOpenWallet}>
                Connect wallet
              </button>
            </Notice>
          ) : t.isLoading ? (
            <p className="muted">Loading events…</p>
          ) : candidates.length === 0 ? (
            <p className="muted">Nothing is due in the next 7 days for the watched addresses.</p>
          ) : (
            <ul className="agent-list">
              {candidates.map((e) => {
                const s = deriveTimelineStatus(e, now);
                return (
                  <li key={e.id} className="agent-item">
                    <div className="agent-item-head">
                      <button type="button" className="btn-link" onClick={(ev) => open({ kind: "event", eventId: e.id }, ev.currentTarget)}>
                        {e.title}
                      </button>
                      <StatusBadge status={displayStatus(e, s)} label={statusText(e, s)} />
                    </div>
                    <p className="muted small brand-inline">
                      <ProtocolBadge id={e.protocol} name={e.protocolName} size={16} />
                      {e.protocolName} · {e.at ? fmtFullDate(new Date(e.at)) : "ETA unknown"}
                    </p>
                    <ProposalPanel event={e} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="panel-block">
          <h2>Humans read the calendar. Agents read the API.</h2>
          <p className="muted small">
            The Seasonals MCP Server serves the same events and menu: <code>list_events</code>, <code>get_proposal</code>, <code>build_action</code>,{" "}
            <code>ship_lp_strategy</code>, <code>list_yield_menu</code>, <code>get_holdings</code>, <code>preview_rebalance_step</code>,{" "}
            <code>propose_rebalance</code>, <code>wait_for_rebalance_decision</code>, <code>execute_rebalance</code> (unsigned plans; execution only
            after your approval, only on the fork) and the <code>seasonals://calendar/&#123;address&#125;</code> iCal feed. It never signs or sends a
            transaction.
          </p>
          <h2 className="brand-heading" style={brandStyle("aqua")}>
            <ProtocolBadge id="aqua" name="1inch Aqua" size={24} />
            LP sleeve (1inch Aqua)
          </h2>
          <AquaPanel />
          <h2>MCP client</h2>
          <pre className="code-block" aria-label="MCP client configuration">
            {`{
  "mcpServers": {
    "seasonals": {
      "command": "npx",
      "args": ["tsx", "artifacts/seasonals-mcp-server/src/index.ts"],
      "env": { "BFF_URL": "http://127.0.0.1:3030" }
    }
  }
}`}
          </pre>
        </section>
      </div>
    </WorkspaceShell>
  );
}
