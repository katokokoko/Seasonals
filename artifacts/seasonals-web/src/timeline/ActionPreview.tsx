/**
 * ActionPreview — 署名前の transaction preview (Ethereum v3 §11 D)。
 * BFF /eth/build-action が protocol ABI / Pendle Convert から組んだ unsigned plan を表示し、
 * mainnet に対する eth_call の結果 (送らずに確認) をそのまま見せる。
 * 署名・送信はここでは行わない (結果を模擬しない、UI v2 §4)。
 */
import { useQuery } from "@tanstack/react-query";
import type { TimelineAction, TimelineEvent } from "@workspace/lib/types";
import { api, ApiError } from "../services/api";
import { shortAddress } from "../ui/format";

export function ActionPreview({ event, action, onBack }: { event: TimelineEvent; action: TimelineAction; onBack: () => void }) {
  const owner = event.owner ?? "";
  const q = useQuery({
    queryKey: ["eth", "plan", event.id, action.actionType],
    queryFn: () => api.ethBuildAction(owner, event.id, action.actionType),
    enabled: Boolean(owner) && event.chain === "ethereum",
    retry: false,
    staleTime: 30_000,
  });

  return (
    <div className="action-preview" aria-live="polite">
      <div className="preview-head">
        <p className="overline">Transaction preview</p>
        {q.data && <span className={`target-badge target-${q.data.target}`}>{q.data.target === "fork" ? "FORK" : "MAINNET · plan only"}</span>}
      </div>
      <h3>{action.label}</h3>
      {event.chain !== "ethereum" ? (
        <p className="muted small">Transaction building for this chain runs in the Seeker app.</p>
      ) : q.isPending ? (
        <p className="muted small" aria-busy="true">
          Building the transaction plan…
        </p>
      ) : q.isError ? (
        <p className="error small" role="alert">
          {q.error instanceof ApiError ? q.error.message : "Could not build the plan."}
        </p>
      ) : (
        <>
          <p className="small">{q.data.summary}</p>
          <ol className="plan-steps">
            {q.data.steps.map((s, i) => (
              <li key={i}>
                <span className="small">{s.description}</span>
                <span className="muted small mono">
                  {s.kind === "approval" ? "approve" : "call"} → {shortAddress(s.to)} · {(s.data.length - 2) / 2} bytes
                </span>
              </li>
            ))}
          </ol>
          <p className={`sim sim-${q.data.simulation.ran ? (q.data.simulation.ok ? "ok" : "fail") : "none"} small`}>
            {q.data.simulation.ran ? (q.data.simulation.ok ? "Check passed: " : "Check failed: ") : "Not checked: "}
            {q.data.simulation.note}
            {q.data.simulation.error ? ` (${q.data.simulation.error})` : ""}
          </p>
          <p className="muted small">
            Unsigned plan for {shortAddress(q.data.owner)}. Nothing has been signed or sent. Signing happens in your own wallet.
          </p>
        </>
      )}
      <button type="button" className="btn" onClick={onBack} data-autofocus>
        Back
      </button>
    </div>
  );
}
