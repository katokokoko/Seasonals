/**
 * SolanaPlanInbox — Agent (MCP) が作った Solana の plan (AgentPlan、§11.7) の承認 inbox (/agent)。
 *
 * 承認 = 実行 (ETH の ProposalInbox と同じ運用、2026-10-06 ユーザー決定):
 *   Approve & sign → POST /agent-plans/:id/approve (token) → /execute (token を消費、BFF が unsigned tx を組む。
 *   oracle gate / fair value の拒否は 409 = declined) → 接続 wallet で一括署名 → BFF /tx/submit → /tx/status
 *   → 結果を /signatures (broadcasted) か /failed (wallet で拒否 / 送信失敗) で報告。MCP の Agent は同じ plan を読む
 *   (same source of truth)。
 * - 署名できるのは plan の wallet (selected_action.wallet_id) が接続中の時だけ。Seasonals は秘密鍵を扱わない (CLAUDE.md §5)
 * - 金額は smallest unit string のまま受け、表示直前に toHumanReadable (§4.5)
 * - oracle は simulate 時点の要約だけ出す。実際の gate は BFF /execute が行い、拒否は declined として出る (§4.6)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { chainInfo } from "@workspace/lib/config/chains";
import { resolveAmountUnit } from "@workspace/lib/derive/amount-utils";
import { ORACLE_WARNING_HEADLINE, oracleWarningBody } from "@workspace/lib/derive/oracle-gate";
import {
  describeSimulationFailure,
  describeSimulationFee,
  describeSimulationOut,
  describeSimulationWarning,
} from "@workspace/lib/derive/simulation-display";
import { AgentPlanStatus, type AgentPlan, type OracleWarningKind } from "@workspace/lib/types";
import { toHumanReadable } from "@workspace/lib/utils/numeric";
import { api, ApiError } from "../services/api";
import { useSolanaAgentPlans } from "../services/queries";
import { useConnectedAddress } from "../state/session";
import { requestOpenWallet } from "../timeline/detailStore";
import { SignResult } from "../solana/SolanaExecutePanel";
import { useSignAndSubmit, type SignState } from "../solana/useSignAndSubmit";
import { fmtFullDate, shortAddress } from "../ui/format";

const STATUS_TEXT: Record<AgentPlanStatus, string> = {
  [AgentPlanStatus.Draft]: "Draft",
  [AgentPlanStatus.Simulated]: "Simulated — ready for approval",
  [AgentPlanStatus.PendingUser]: "Needs your approval",
  [AgentPlanStatus.Approved]: "Approved — sign to send",
  [AgentPlanStatus.Executing]: "Signing…",
  [AgentPlanStatus.Signed]: "Signed",
  [AgentPlanStatus.Broadcasted]: "Sent",
  [AgentPlanStatus.Failed]: "Failed",
  [AgentPlanStatus.Rejected]: "Rejected",
  [AgentPlanStatus.Expired]: "Expired",
};

/**
 * 署名まで進められる status。approved (Seeker 等で承認済み、または gate 拒否で token 未消費のまま) も含む:
 * BFF の /approve は人が承認した approved plan に token を再発行する (Seeker で承認 → web で署名)
 */
const APPROVABLE: ReadonlySet<string> = new Set([AgentPlanStatus.PendingUser, AgentPlanStatus.Simulated, AgentPlanStatus.Approved]);
const REJECTABLE: ReadonlySet<string> = new Set([AgentPlanStatus.PendingUser, AgentPlanStatus.Simulated, AgentPlanStatus.Approved]);

/** smallest unit → human。整数 string でなければそのまま (USD 8 decimals の string 等) */
function human(value: string | undefined, decimals: number): string {
  if (!value) return "";
  if (!/^[0-9]+$/.test(value)) return value;
  try {
    return toHumanReadable(value, decimals);
  } catch {
    return value;
  }
}

function actionLabel(t: string): string {
  const s = t.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : "Request failed.";
}

/** /failed に送る理由 (BFF の failure_reason。MCP の Agent が読む) */
function failureReason(s: SignState): string {
  if (s.phase === "cancelled") return "user_cancelled";
  const code = s.code ?? (s.txs.length > 0 ? "submit_failed" : "sign_failed");
  const sent = s.txs.length > 0 ? ` (sent ${s.txs.length} of ${s.total || s.txs.length}: ${s.txs.map((t) => t.signature).join(",")})` : "";
  return `${code}: ${s.message ?? "failed"}${sent}`;
}

/**
 * simulate 結果の見積り部分 (受け取り量 / 最低受け取り量 / 手数料 / 見積り不能の理由 / oracle 以外の注意)。
 * 文言は Seeker の承認画面と共有 (lib/derive/simulation-display)。新形式は受け取り token の単位、
 * estimate_kind の無い旧形式だけ入力 asset の単位 (legacy) で出す。
 */
function SimulationEstimate({ sim, legacy }: { sim: NonNullable<AgentPlan["simulation_result"]>; legacy: { decimals: number; unitSymbol: string } }) {
  const out = describeSimulationOut(sim, legacy);
  // 旧形式の fee は mock adapter の lamports を入力 asset 建てと取り違えた値なので出さない (以前から非表示)
  const fee = sim.estimate_kind !== undefined ? describeSimulationFee(sim, legacy) : null;
  const failure = sim.failure_reason ? describeSimulationFailure(sim.failure_reason) : null;
  // 新形式で見積り不能の時は out も同じ理由の文になる。理由は hf-warn の 1 行だけで出す
  const showOut = out !== null && out !== failure;
  const minOut =
    sim.estimate_kind === "quote" && sim.min_out
      ? `${human(sim.min_out, sim.estimated_out_decimals ?? legacy.decimals)} ${sim.estimated_out_symbol ?? legacy.unitSymbol}`
      : null;
  return (
    <>
      {showOut && (
        <li>
          <span className="small">Estimated out: {out}</span>
        </li>
      )}
      {minOut && (
        <li>
          <span className="muted small">Minimum out: {minOut}</span>
        </li>
      )}
      {fee && (
        <li>
          <span className="muted small">Estimated fee: {fee}</span>
        </li>
      )}
      {failure && (
        <li>
          <span className="small hf-warn">{failure}</span>
        </li>
      )}
      {(sim.warnings ?? []).map((w) => (
        <li key={w}>
          <span className="small hf-warn">{describeSimulationWarning(w)}</span>
        </li>
      ))}
    </>
  );
}

function OracleSummary({ oracle }: { oracle: NonNullable<AgentPlan["simulation_result"]>["oracle"] }) {
  if (!oracle) return null;
  const parts = [
    `Price at simulation: ${oracle.primary}, ${Math.floor(oracle.primary_age_seconds)}s old`,
    oracle.primary !== "pyth" ? "using secondary source" : null,
    oracle.divergence_pct !== undefined ? `sources differ by ${oracle.divergence_pct.toFixed(1)}%` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="muted small">{parts.join(" · ")}</span>
      {oracle.warnings.map((w) =>
        w in ORACLE_WARNING_HEADLINE ? (
          <span key={w} className="small hf-warn">
            {ORACLE_WARNING_HEADLINE[w as OracleWarningKind]}:{" "}
            {oracleWarningBody({ kind: w as OracleWarningKind, ...(oracle.divergence_pct !== undefined ? { divergencePct: oracle.divergence_pct } : {}) })}
          </span>
        ) : (
          <span key={w} className="small hf-warn">
            {w}
          </span>
        )
      )}
    </>
  );
}

export function SolanaPlanCard({ plan: p }: { plan: AgentPlan }) {
  const qc = useQueryClient();
  const action = p.selected_action!;
  const walletId = action.wallet_id;
  const connected = useConnectedAddress("solana");
  const canSign = connected === walletId;
  const unit = useMemo(() => resolveAmountUnit(action), [action]);
  const sim = p.simulation_result;
  const rationale = p.candidate_actions.find((c) => c.protocol === action.protocol && c.action_spec.action_type === action.action_type)?.rationale;
  const explorer = chainInfo("solana").explorer.tx;

  const sign = useSignAndSubmit(walletId);
  const executionId = useRef<string | null>(null);
  const reported = useRef<string | null>(null);
  const [approvedHere, setApprovedHere] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["sol", "agent-plans"] });
  const reject = useMutation({ mutationFn: () => api.rejectAgentPlan(p.plan_id), onSettled: refresh });
  const report = useMutation({
    mutationFn: (r: { executionId: string } & ({ signatures: string[] } | { reason: string })) =>
      "signatures" in r
        ? api.reportAgentPlanSignatures(p.plan_id, r.executionId, r.signatures)
        : api.reportAgentPlanFailed(p.plan_id, r.executionId, r.reason),
    onSettled: refresh,
  });
  const approve = useMutation({ mutationFn: () => api.approveAgentPlan(p.plan_id) });

  // 署名・送信が終わったら結果を BFF に報告する (/execute が通った = execution_id がある時だけ。1 回きり)
  useEffect(() => {
    const id = executionId.current;
    const s = sign.state;
    if (!id || reported.current === id) return;
    if (s.phase === "success" || s.phase === "submitted") {
      reported.current = id;
      report.mutate({ executionId: id, signatures: s.txs.map((t) => t.signature) });
    } else if (s.phase === "cancelled" || s.phase === "error" || s.phase === "declined") {
      reported.current = id;
      report.mutate({ executionId: id, reason: failureReason(s) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sign.state]);

  const approveAndSign = async () => {
    setApproveError(null);
    executionId.current = null;
    let tokenId: string;
    try {
      tokenId = (await approve.mutateAsync()).approval_token.token_id;
    } catch (e) {
      setApproveError(errorMessage(e));
      refresh();
      return;
    }
    setApprovedHere(true);
    refresh();
    await sign.run(async () => {
      const r = await api.executeAgentPlan(p.plan_id, tokenId);
      executionId.current = r.execution_id;
      return [...r.unsigned_transactions].sort((a, b) => a.index - b.index).map((t) => t.tx_base64);
    });
  };

  const running = approve.isPending || sign.busy || report.isPending;
  const declined = sign.state.phase === "declined";
  const showSignResult = sign.state.phase !== "idle" && !declined && p.status !== AgentPlanStatus.Broadcasted;
  const signatures = p.execution?.signatures ?? [];

  return (
    <section className="proposal proposal-card" aria-label={`Agent plan: ${actionLabel(action.action_type)} ${action.protocol}`}>
      <div className="preview-head">
        <span className="overline">Agent plan · Solana mainnet</span>
        <span className="tag">{STATUS_TEXT[p.status]}</span>
      </div>
      <h3 className="brief-name">
        {actionLabel(action.action_type)}
        {action.amount ? ` ${human(action.amount, unit.decimals)} ${unit.unitSymbol}` : action.asset ? ` ${action.asset}` : ""}
      </h3>
      <p className="muted small">
        {action.protocol}
        {action.to_protocol ? ` → ${action.to_protocol}` : ""}
        {action.asset ? ` · ${action.asset}` : ""} · wallet {shortAddress(walletId)}
      </p>
      {rationale && <p className="small">{rationale}</p>}
      {sim && (
        <ul className="plan-steps plain-list">
          <SimulationEstimate sim={sim} legacy={{ decimals: unit.decimals, unitSymbol: unit.unitSymbol }} />
          {sim.oracle && (
            <li>
              <OracleSummary oracle={sim.oracle} />
            </li>
          )}
        </ul>
      )}
      <p className="muted small mono">
        {sim ? `${sim.bundle_hash.slice(0, 14)}… · ` : ""}proposed {fmtFullDate(new Date(p.created_at))}
        {p.execution
          ? ` · sent via ${p.execution.via} ${fmtFullDate(new Date(p.execution.submitted_at))}`
          : p.expires_at
            ? ` · expires ${fmtFullDate(new Date(p.expires_at))}`
            : ""}
      </p>
      {signatures.length > 0 && (
        <ol className="sign-txs small" aria-label="Transactions">
          {signatures.map((sig) => (
            <li key={sig}>
              <a className="mono" href={`${explorer}${sig}`} target="_blank" rel="noreferrer">
                {shortAddress(sig)}
              </a>
            </li>
          ))}
        </ol>
      )}
      {p.status === AgentPlanStatus.Failed && p.failure_reason && <p className="error small">Reason: {p.failure_reason}</p>}

      {APPROVABLE.has(p.status) && !canSign && (
        <p className="muted small">
          This plan is for {shortAddress(walletId)}. Connect that wallet to sign it.{" "}
          <button type="button" className="btn-link small" onClick={requestOpenWallet}>
            Connect wallet
          </button>
        </p>
      )}
      {p.status === AgentPlanStatus.Approved && !approvedHere && canSign && !declined && (
        <p className="muted small">Approved on another device. Signing here sends it from this wallet.</p>
      )}
      {p.status === AgentPlanStatus.Executing && !running && sign.state.phase === "idle" && (
        <p className="muted small">Being signed in another tab or device.</p>
      )}
      {REJECTABLE.has(p.status) && (
        <div className="fork-exec">
          {APPROVABLE.has(p.status) && canSign && (
            <button type="button" className="btn btn-primary" onClick={() => void approveAndSign()} disabled={running || reject.isPending}>
              {running ? "Working…" : p.status === AgentPlanStatus.Approved ? "Sign & send" : "Approve & sign"}
            </button>
          )}
          <button type="button" className="btn btn-quiet" onClick={() => reject.mutate()} disabled={running || reject.isPending}>
            Reject
          </button>
          {APPROVABLE.has(p.status) && canSign && (
            <span className="muted small">Approving builds the transaction and opens your wallet. It sends a real transaction on Solana mainnet.</span>
          )}
        </div>
      )}
      {declined && (
        <p className="small hf-warn" role="alert">
          Declined by safety gate: {sign.state.message} Nothing was signed. Try again later, reject, or ask your Agent to re-simulate.
        </p>
      )}
      {showSignResult && <SignResult state={sign.state} />}
      {(approveError || reject.isError || report.isError) && (
        <span className="error small" role="alert">
          {approveError ?? (reject.isError ? errorMessage(reject.error) : `Could not report the result to Seasonals: ${errorMessage(report.error)}`)}
        </span>
      )}
    </section>
  );
}

export function SolanaPlanInbox() {
  const data = useSolanaAgentPlans();
  if (data.wallets.length === 0) {
    return (
      <p className="muted small">
        Connect a Solana wallet to approve and sign plans from your Agent.{" "}
        <button type="button" className="btn-link small" onClick={requestOpenWallet}>
          Connect wallet
        </button>
      </p>
    );
  }
  const plans = data.plans.filter((p) => p.selected_action !== null);
  if (data.isLoading && plans.length === 0) return <p className="muted">Loading plans…</p>;
  if (data.error && plans.length === 0) return <p className="error small">{data.error}</p>;
  if (plans.length === 0) {
    return <p className="muted">No Solana plans yet. Ask Claude (via the Seasonals MCP Server) to simulate an action; it will appear here for your approval.</p>;
  }
  return (
    <div className="proposal-inbox">
      {plans.map((p) => (
        <SolanaPlanCard key={p.plan_id} plan={p} />
      ))}
    </div>
  );
}
