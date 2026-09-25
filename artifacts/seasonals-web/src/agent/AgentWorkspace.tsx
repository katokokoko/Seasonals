/**
 * AgentWorkspace — /agent (UI v2 §11)。
 * Agent は MCP Server 経由で UI と同じ event source を読む (CLAUDE.md §0)。
 * 未接続の機能は明示し、完成済みに見せない。
 */
import { WorkspaceShell, Notice } from "../shell/WorkspaceShell";
import "./agent.css";

export default function AgentWorkspace() {
  return (
    <WorkspaceShell title="Agent" subtitle="Your seasonal companion">
      <div className="agent-grid">
        <section className="panel-block">
          <h2>Humans read the calendar. Agents read the API.</h2>
          <p className="muted">
            The Seasonals MCP Server reads the same server the calendar uses. An agent (for example Claude Desktop) can list events and prepare
            actions, but it never signs or sends a transaction.
          </p>
          <pre className="code-block" aria-label="MCP client configuration">
            {`{
  "mcpServers": {
    "seasonals": {
      "command": "pnpm",
      "args": ["--filter", "@seasonals/mcp-server", "start"]
    }
  }
}`}
          </pre>
        </section>
        <section className="panel-block">
          <h2>Event proposals</h2>
          <Notice title="Not connected yet">
            Proposals for protocol events (what to do when a date arrives) are not wired into the web app yet. Nothing on this page is generated.
          </Notice>
        </section>
      </div>
    </WorkspaceShell>
  );
}
