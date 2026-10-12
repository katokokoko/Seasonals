/**
 * PlanView — 未署名プランの中身 (手順 / eth_call の結果 / 警告) と fork 実行の UI。
 * 詳細カードの ActionPreview と Menu の deposit / withdraw パネルで共有する。
 * 実行はローカル Anvil fork のみ (ユーザーの明示的な承認ボタン)。mainnet には送らない。
 */
import type { UseMutationResult } from "@tanstack/react-query";
import { ApiError, type ActionPlan, type ForkExecution } from "../services/api";
import { useEthStatus } from "../services/queries";
import { shortAddress } from "../ui/format";

export function TargetBadge({ plan }: { plan: ActionPlan }) {
  return <span className={`target-badge target-${plan.target}`}>{plan.target === "fork" ? "FORK" : "MAINNET · plan only"}</span>;
}

export function PlanView({ plan, exec }: { plan: ActionPlan; exec: UseMutationResult<ForkExecution, Error, void> }) {
  const status = useEthStatus();
  const forkReady = status.data?.executionTarget === "fork" && status.data.forkReachable;
  const ok = exec.data?.txs.every((t) => t.status === "success");
  return (
    <>
      <p className="small">{plan.summary}</p>
      <ol className="plan-steps">
        {plan.steps.map((s, i) => (
          <li key={i}>
            <span className="small">{s.description}</span>
            <span className="muted small mono">
              {s.kind === "approval" ? "approve" : "call"} → {shortAddress(s.to)} · {(s.data.length - 2) / 2} bytes
            </span>
          </li>
        ))}
      </ol>
      {plan.warnings && plan.warnings.length > 0 && (
        <ul className="plan-warnings small">
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <p className={`sim sim-${plan.simulation.ran ? (plan.simulation.ok ? "ok" : "fail") : "none"} small`}>
        {plan.simulation.ran ? (plan.simulation.ok ? "Check passed: " : "Check failed: ") : "Not checked: "}
        {plan.simulation.note}
        {plan.simulation.error ? ` (${plan.simulation.error})` : ""}
      </p>
      <p className="muted small">Unsigned plan for {shortAddress(plan.owner)}. Nothing has been signed or sent.</p>

      {exec.isSuccess ? (
        <div className={`sim ${ok ? "sim-ok" : "sim-fail"} small`} role="status">
          <strong>{ok ? "Executed on the local fork." : "Reverted on the local fork; the action did not complete."}</strong> No real funds moved.
          <ul className="plain-list">
            {exec.data.txs.map((t) => (
              <li key={t.hash} className="mono">
                {t.hash.slice(0, 12)}… · {t.status} · block {t.blockNumber}
              </li>
            ))}
          </ul>
        </div>
      ) : forkReady ? (
        <div className="fork-exec">
          <button type="button" className="btn btn-primary" onClick={() => exec.mutate()} disabled={exec.isPending}>
            {exec.isPending ? "Executing on fork…" : "Approve and execute on local fork"}
          </button>
          <span className="muted small">Runs on an Anvil fork of mainnet as {shortAddress(plan.owner)} (impersonated). Mainnet is never touched.</span>
          {exec.isError && (
            <span className="error small" role="alert">
              {exec.error instanceof ApiError ? exec.error.message : "Execution failed."}
            </span>
          )}
        </div>
      ) : (
        <p className="muted small">
          Signing with a browser wallet is not wired in yet. {status.data?.executionTarget === "fork" ? "Start the local fork to run this plan on a mainnet fork." : ""}
        </p>
      )}
    </>
  );
}
