/**
 * ProposalPanel — 「この日が来たら何をするか」の提案 (Ethereum v3 §7)。
 * rule-based (LLM key 無し) であることを明示。事実 / 前提 / 選択肢 / リスクを分けて表示。
 */
import { useQuery } from "@tanstack/react-query";
import type { TimelineEvent } from "@workspace/lib/types";
import { api, ApiError } from "../services/api";
import { fmtRatio } from "../ui/format";

const LIQ: Record<string, string> = { instant: "Instant", cooldown: "Cooldown", queue: "Queue", dated: "Dated" };

export function ProposalPanel({ event }: { event: TimelineEvent }) {
  const q = useQuery({
    queryKey: ["eth", "proposal", event.id],
    queryFn: () => api.ethProposal(event.owner!, event.id),
    enabled: Boolean(event.owner),
    retry: false,
    staleTime: 60_000,
  });
  if (q.isPending) return <p className="muted small">Preparing a proposal…</p>;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <p className="muted small">No proposal for this event.</p>;
    return <p className="error small">{q.error instanceof ApiError ? q.error.message : "Proposal unavailable."}</p>;
  }
  const p = q.data;
  return (
    <section className="proposal" aria-label="Proposal">
      <div className="preview-head">
        <p className="overline">Proposal</p>
        <span className="tag">rule-based</span>
      </div>
      <p className="small">
        <strong>{p.summary}</strong>
      </p>
      <details>
        <summary className="small">Facts and assumptions</summary>
        <ul className="small">
          {p.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
          {p.assumptions.map((a) => (
            <li key={a} className="muted">
              Assumption: {a}
            </li>
          ))}
        </ul>
      </details>
      <ol className="proposal-options">
        {p.options.map((o) => (
          <li key={o.id} className={o.id === p.recommendedOptionId ? "is-recommended" : undefined}>
            <div className="small">
              <strong>
                {o.id}. {o.label}
              </strong>
              {o.id === p.recommendedOptionId && <span className="tag">recommended</span>}
            </div>
            <div className="muted small">
              {o.currentYield === null ? "Yield: n/a" : `Current yield: ${fmtRatio(o.currentYield)}${o.yieldSource ? ` (${o.yieldSource})` : ""}`} · Liquidity:{" "}
              {LIQ[o.liquidityClass]}
              {o.durationDays !== null ? ` · ${o.durationDays} days` : ""}
            </div>
            {o.risks.length > 0 && <div className="muted small">Risks: {o.risks.join(" ")}</div>}
          </li>
        ))}
      </ol>
      <p className="small">Why: {p.reason}</p>
    </section>
  );
}
