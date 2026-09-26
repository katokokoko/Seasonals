/**
 * ActionPreview — 署名前の transaction preview (Ethereum v3 §11 D)。
 * BFF /eth/build-action が protocol ABI / Pendle Convert から組んだ unsigned plan を表示し、
 * mainnet に対する eth_call の結果 (送らずに確認) をそのまま見せる。
 * 実行はローカル Anvil fork のみ (FORK 表示、ユーザーの明示的な承認ボタン)。mainnet には送らない。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimelineAction, TimelineEvent } from "@workspace/lib/types";
import { api, ApiError } from "../services/api";
import { PlanView, TargetBadge } from "./PlanView";

export function ActionPreview({ event, action, onBack }: { event: TimelineEvent; action: TimelineAction; onBack: () => void }) {
  const owner = event.owner ?? "";
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["eth", "plan", event.id, action.actionType],
    queryFn: () => api.ethBuildAction(owner, event.id, action.actionType),
    enabled: Boolean(owner) && event.chain === "ethereum",
    retry: false,
    staleTime: 30_000,
  });
  const exec = useMutation({
    mutationFn: () => api.ethExecuteOnFork(owner, event.id, action.actionType),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eth", "events"] }),
  });

  return (
    <div className="action-preview" aria-live="polite">
      <div className="preview-head">
        <p className="overline">Transaction preview</p>
        {q.data && <TargetBadge plan={q.data} />}
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
        <PlanView plan={q.data} exec={exec} />
      )}
      <button type="button" className="btn" onClick={onBack} data-autofocus>
        Back
      </button>
    </div>
  );
}
