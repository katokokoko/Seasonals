/**
 * SolanaEventAction — calendar の Solana event (claim の "Withdraw & claim" / 満期 PT の "Redeem") を実行する。
 * event.metadata から写した action params を lib withdrawActionFromParams で全量 withdraw にし
 * (Seeker syntheticPlanFromEventAction と同じ検証)、SolanaExecutePanel で署名 → 送信する。
 */
import type { TimelineAction, TimelineEvent } from "@workspace/lib/types";
import { withdrawActionFromParams } from "@workspace/lib/derive/solana-action";
import { SolanaExecutePanel } from "../solana/SolanaExecutePanel";

function noteFor(event: TimelineEvent): string | undefined {
  if (event.kind === "claim") return "Withdrawing the position also collects its unclaimed fees.";
  if (event.kind === "maturity") return "After maturity the PT redeems 1:1 for its underlying asset.";
  return undefined;
}

export function SolanaEventAction({ event, action, onBack }: { event: TimelineEvent; action: TimelineAction; onBack: () => void }) {
  const input = action.availability === "available" ? withdrawActionFromParams(action.params) : null;
  if (!input) {
    return (
      <div className="action-preview" aria-live="polite">
        <p className="overline">{action.label}</p>
        <p className="menu-warning small" role="alert">
          {action.reason ?? "Seasonals cannot build a transaction for this action yet."}
        </p>
        <button type="button" className="btn" onClick={onBack} data-autofocus>
          Back
        </button>
      </div>
    );
  }
  return (
    <div className="action-preview">
      <SolanaExecutePanel
        action={input}
        owner={event.owner ?? null}
        title={`${action.label}${event.asset ? ` · ${event.asset}` : ""}`}
        note={noteFor(event)}
        onClose={onBack}
      />
    </div>
  );
}
