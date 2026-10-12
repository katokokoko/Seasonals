/**
 * SolanaExecutePanel — Solana の deposit / withdraw を 1 件、金額入力 → oracle gate → wallet 署名 → 送信 → 着地確認まで。
 * Menu カード / Calendar の event action / Dashboard の Your Positions で共用する (Seeker ActionModal の web 版)。
 *
 * - 金額は lib の amount-utils (toSmallestUnit 経由、§4.5) で smallest unit にする。Number は使わない
 * - route は lib resolveSolanaRoute。解決しなければ CTA を出さない (fail-closed、Seeker 8.37)
 * - 署名できるのは接続中の wallet の address だけ。watch 中の address は読み取りのみ
 * - mainnet に実際に送る。送信は BFF /tx/submit (Helius)。Seasonals は秘密鍵を扱わない (CLAUDE.md §5)
 */
import { useId, useMemo, useState } from "react";
import { chainInfo } from "@workspace/lib/config/chains";
import type { SolanaActionInput } from "@workspace/lib/types";
import { toHumanReadable } from "@workspace/lib/utils/numeric";
import {
  depositMaxSmallest,
  resolveAmountUnit,
  validateAmountInput,
  validateDepositAgainstBalance,
} from "@workspace/lib/derive/amount-utils";
import { resolveOracleMint } from "@workspace/lib/derive/oracle-gate";
import { resolveSolanaRoute, UNSUPPORTED_MARKET_MESSAGE } from "@workspace/lib/derive/solana-action";
import { useConnectedAddress } from "../state/session";
import { useSolanaWalletBalance } from "../services/queries";
import { requestOpenWallet } from "../timeline/detailStore";
import { shortAddress } from "../ui/format";
import { buildSolanaTxs } from "./buildTx";
import { OracleGate } from "./OracleGate";
import { useSignAndSubmit, type SignState, type SubmittedTx } from "./useSignAndSubmit";
import "./solana.css";

function safeHuman(smallest: string | undefined, decimals: number): string {
  if (!smallest || !/^[0-9]+$/.test(smallest)) return "";
  try {
    return toHumanReadable(smallest, decimals);
  } catch {
    return "";
  }
}

/** share 建て withdraw の ≈underlying (bigint の比例計算、表示専用) */
function approxUnderlying(action: SolanaActionInput, editedSmallest: string | null): string | null {
  const total = action.amount;
  const under = action.metadata?.underlying_amount;
  const underDec = action.metadata?.underlying_decimals;
  if (!editedSmallest || !total || typeof under !== "string" || typeof underDec !== "number") return null;
  if (!/^[0-9]+$/.test(total) || !/^[0-9]+$/.test(under) || BigInt(total) === 0n) return null;
  return safeHuman(((BigInt(editedSmallest) * BigInt(under)) / BigInt(total)).toString(), underDec);
}

export function SolanaExecutePanel({
  action,
  owner,
  title,
  note,
  onClose,
}: {
  action: SolanaActionInput;
  /** 実行する address (fee payer)。接続中の Solana wallet と一致しないと署名できない */
  owner: string | null;
  title: string;
  /** action ごとの補足 (claim は fee も回収する、等) */
  note?: string;
  onClose: () => void;
}) {
  const id = useId();
  const connected = useConnectedAddress("solana");
  const isDeposit = action.action_type === "deposit";
  const unit = useMemo(() => resolveAmountUnit(action), [action]);
  const route = useMemo(() => resolveSolanaRoute(action), [action]);
  const oracleMint = useMemo(() => resolveOracleMint(action), [action]);
  const [amount, setAmount] = useState(() => (isDeposit ? "" : safeHuman(action.amount, unit.decimals)));
  const canSign = Boolean(owner) && owner === connected;
  const { balance } = useSolanaWalletBalance(isDeposit && canSign ? owner : null, action.asset);
  const sign = useSignAndSubmit(owner ?? "");

  const format = validateAmountInput(amount, unit.decimals);
  const limitError = (() => {
    if (!format.ok) return null;
    if (isDeposit) {
      const r = validateDepositAgainstBalance(format.smallest, balance, unit.unitSymbol, unit.decimals);
      return r.ok ? null : r.error;
    }
    // withdraw は保有量まで (BFF も拒否するが、署名画面を開く前に止める)
    if (action.amount && /^[0-9]+$/.test(action.amount) && BigInt(format.smallest) > BigInt(action.amount)) {
      return `More than you hold (${safeHuman(action.amount, unit.decimals)} ${unit.unitSymbol}).`;
    }
    return null;
  })();
  const valid = format.ok && !limitError;
  const max = isDeposit ? (balance ? depositMaxSmallest(balance, action.asset) : null) : (action.amount ?? null);
  const approx = !isDeposit && unit.unitSymbol !== action.asset ? approxUnderlying(action, format.ok ? format.smallest : null) : null;
  const locked = sign.busy || sign.state.phase === "success" || sign.state.phase === "submitted";
  const verb = isDeposit ? "Deposit" : "Withdraw";

  return (
    <div className="menu-action solana-action" aria-live="polite">
      <div className="preview-head">
        <p className="overline">{verb}</p>
        <span className="target-badge target-mainnet">SOLANA MAINNET</span>
      </div>
      <h3>{title}</h3>
      {note && <p className="muted small">{note}</p>}

      {!route ? (
        <p className="menu-warning small" role="alert">
          {UNSUPPORTED_MARKET_MESSAGE}. Nothing can be signed for it here.
        </p>
      ) : !canSign ? (
        <p className="muted small">
          {owner ? `Connect ${shortAddress(owner)} in a Solana wallet to sign.` : `Connect a Solana wallet to ${verb.toLowerCase()}.`}{" "}
          <button type="button" className="btn-link small" onClick={requestOpenWallet}>
            Connect wallet
          </button>
        </p>
      ) : (
        <form
          className="menu-action-form"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <label className="small" htmlFor={id}>
            Amount
          </label>
          <div className="input-row">
            <input
              id={id}
              className="input"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={locked}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
            />
            <span className="muted small unit">{unit.unitSymbol}</span>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={locked || !max || max === "0"}
              onClick={() => max && setAmount(safeHuman(max, unit.decimals))}
            >
              Max
            </button>
          </div>
          <p className="muted small">
            {isDeposit
              ? balance === null
                ? "Checking wallet balance…"
                : `Wallet balance: ${safeHuman(balance, unit.decimals) || "0"} ${unit.unitSymbol}`
              : `Holding: ${safeHuman(action.amount, unit.decimals)} ${unit.unitSymbol}`}
            {approx && ` · ≈ ${approx} ${action.asset}`}
          </p>
          {amount.trim() !== "" && !format.ok && (
            <p className="error small" role="alert">
              {format.error}
            </p>
          )}
          {limitError && (
            <p className="error small" role="alert">
              {limitError}
            </p>
          )}
          <OracleGate mint={oracleMint}>
            {(oracleOk) => (
              <div className="menu-action-buttons">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!oracleOk || !valid || locked}
                  onClick={() => format.ok && route && sign.run(() => buildSolanaTxs(route, owner!, format.smallest))}
                >
                  {sign.busy ? "Working…" : "Sign in wallet"}
                </button>
                <button type="button" className="btn" onClick={onClose} disabled={sign.busy}>
                  {sign.state.phase === "success" || sign.state.phase === "submitted" ? "Close" : "Cancel"}
                </button>
              </div>
            )}
          </OracleGate>
          <p className="muted small">
            This sends a real transaction on Solana mainnet. Review it in your wallet before approving. Seasonals never holds your keys.
          </p>
        </form>
      )}
      {(!route || !canSign) && (
        <div className="menu-action-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}
      <SignResult state={sign.state} />
    </div>
  );
}

const STATUS_LABEL: Record<SubmittedTx["status"], string> = {
  submitted: "Sent",
  pending: "Pending",
  processed: "Processed",
  confirmed: "Confirmed",
  finalized: "Finalized",
  failed: "Failed",
};

export function SignResult({ state }: { state: SignState }) {
  const { phase, total, txs, message } = state;
  if (phase === "idle") return null;
  const n = total || txs.length;
  const headline: Record<SignState["phase"], string | null> = {
    idle: null,
    building: "Building the transaction…",
    signing: `Approve ${n === 1 ? "the transaction" : `${n} transactions`} in your wallet…`,
    submitting: "Sending to Solana…",
    confirming: "Waiting for confirmation…",
    success: "Confirmed on Solana mainnet.",
    submitted: "Sent. Confirmation is taking longer than usual; check the explorer.",
    declined: null,
    cancelled: null,
    error: null,
  };
  const explorer = chainInfo("solana").explorer.tx;
  return (
    <div className="sign-result">
      {headline[phase] && (
        <p className={phase === "success" ? "sim-ok small" : "muted small"} aria-busy={phase !== "success" && phase !== "submitted" ? true : undefined}>
          {headline[phase]}
        </p>
      )}
      {phase === "declined" && (
        <p className="menu-warning small" role="alert">
          {message} Nothing was signed.
        </p>
      )}
      {phase === "cancelled" && <p className="muted small">{message}</p>}
      {phase === "error" && (
        <p className="error small" role="alert">
          {message}
        </p>
      )}
      {txs.length > 0 && (
        <ol className="sign-txs small" aria-label="Transactions">
          {txs.map((t) => (
            <li key={t.signature}>
              <span className={t.status === "failed" ? "sim-fail" : t.status === "confirmed" || t.status === "finalized" ? "sim-ok" : "muted"}>
                {STATUS_LABEL[t.status]}
              </span>{" "}
              <a className="mono" href={`${explorer}${t.signature}`} target="_blank" rel="noreferrer">
                {shortAddress(t.signature)}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
