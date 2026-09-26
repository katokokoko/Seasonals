/**
 * ProposalInbox — Agent (MCP) が提出したリバランス案の承認待ち一覧 (/agent)。
 * 「Approve and execute on local fork」の 1 タップで BFF が fork 上で順に実行する。
 * 送るのは表示した bundleHash だけ (違うものは BFF が拒否)。mainnet には送らない。
 * chat で承認された案もここに同じ状態で出る (same source of truth)。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { EthAgentProposal, EthProposalStep } from "@workspace/lib/types";
import { api, ApiError } from "../services/api";
import { useAgentProposals, useEthStatus } from "../services/queries";
import { requestOpenWallet } from "../timeline/detailStore";
import { Notice } from "../shell/WorkspaceShell";
import { fmtFullDate } from "../ui/format";

function stepText(s: EthProposalStep): string {
  switch (s.kind) {
    case "menu":
      return `${s.action === "deposit" ? "Deposit" : "Withdraw"} ${s.amount}${s.token ? ` ${s.token}` : ""} · ${s.productId}`;
    case "uniswap_swap":
      return `Swap ${s.amount} ${s.tokenIn} → ${s.tokenOut} on Uniswap`;
    case "event_action":
      return `${s.actionType} · ${s.eventId}`;
  }
}

const STATUS_TEXT: Record<EthAgentProposal["status"], string> = {
  pending: "Waiting for your approval",
  executing: "Running on the local fork…",
  executed: "Executed on the local fork",
  failed: "Failed on the local fork",
  rejected: "Rejected",
  expired: "Expired",
};

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "Request failed.";
}

export function ProposalCard({ proposal: p }: { proposal: EthAgentProposal }) {
  const qc = useQueryClient();
  const status = useEthStatus();
  const forkReady = status.data?.executionTarget === "fork" && status.data.forkReachable;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["eth", "agent-proposals"] });
    qc.invalidateQueries({ queryKey: ["eth", "events"] });
    qc.invalidateQueries({ queryKey: ["eth", "holdings"] });
    qc.invalidateQueries({ queryKey: ["portfolio"] });
  };
  const exec = useMutation({ mutationFn: () => api.ethExecuteAgentProposal(p.id, p.bundleHash), onSettled: refresh });
  const reject = useMutation({ mutationFn: () => api.ethRejectAgentProposal(p.id), onSettled: refresh });
  const busy = exec.isPending || reject.isPending || p.status === "executing";
  const results = p.execution?.steps ?? [];

  return (
    <section className="proposal proposal-card" aria-label={`Agent proposal: ${p.title}`}>
      <div className="preview-head">
        <span className="overline">Agent proposal</span>
        <span className="tag">{STATUS_TEXT[p.status]}</span>
      </div>
      <p>
        <strong>{p.title}</strong>
      </p>
      <p className="small">{p.rationale}</p>
      <ol className="plan-steps">
        {p.steps.map((s, i) => {
          const slot = p.previews[i];
          const r = results[i];
          return (
            <li key={i}>
              <span className="small">{stepText(s)}</span>
              {slot?.ok ? (
                <>
                  <span className="muted small">{slot.preview.summary}</span>
                  {slot.preview.warnings.map((w) => (
                    <span key={w} className="small hf-warn">
                      {w}
                    </span>
                  ))}
                </>
              ) : slot ? (
                <span className="muted small">{slot.note}</span>
              ) : null}
              {r && (
                <span className={`sim ${r.ok ? "sim-ok" : "sim-fail"} small`}>
                  {r.ok ? "Done: " : "Failed: "}
                  {r.error ?? r.summary}
                  {r.txs.length > 0 && (
                    <ul className="plain-list">
                      {r.txs.map((t) => (
                        <li key={t.hash + t.description} className="mono">
                          {t.hash.slice(0, 12)}… · {t.status} · block {t.blockNumber}
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="muted small mono">
        {p.bundleHash.slice(0, 14)}… · proposed {fmtFullDate(new Date(p.createdAt))}
        {p.execution ? ` · approved via ${p.execution.via}` : ` · expires ${fmtFullDate(new Date(p.expiresAt))}`}
      </p>
      {p.status === "pending" &&
        (forkReady ? (
          <div className="fork-exec">
            <button type="button" className="btn btn-primary" onClick={() => exec.mutate()} disabled={busy}>
              {exec.isPending ? "Executing on fork…" : "Approve and execute on local fork"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => reject.mutate()} disabled={busy}>
              Reject
            </button>
            <span className="muted small">Runs every step in order on an Anvil fork of mainnet (impersonated). Mainnet is never touched.</span>
          </div>
        ) : (
          <p className="muted small">
            Signing with a browser wallet is not wired in yet.{" "}
            {status.data?.executionTarget === "fork" ? "Start the local fork to run this proposal on a mainnet fork." : ""}
          </p>
        ))}
      {(exec.isError || reject.isError) && (
        <span className="error small" role="alert">
          {errorMessage(exec.error ?? reject.error)}
        </span>
      )}
    </section>
  );
}

export function ProposalInbox() {
  const data = useAgentProposals();
  if (!data.hasAddress) {
    return (
      <Notice title="No wallet yet">
        Watch or connect an Ethereum address to receive proposals from your Agent.{" "}
        <button type="button" className="btn-link" onClick={requestOpenWallet}>
          Connect wallet
        </button>
      </Notice>
    );
  }
  if (data.isLoading && data.proposals.length === 0) return <p className="muted">Loading proposals…</p>;
  if (data.error && data.proposals.length === 0) return <p className="error small">{data.error}</p>;
  if (data.proposals.length === 0) {
    return <p className="muted">No proposals yet. Ask Claude (via the Seasonals MCP Server) to design a rebalance; it will appear here for your approval.</p>;
  }
  return (
    <div className="proposal-inbox">
      {data.proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
    </div>
  );
}
