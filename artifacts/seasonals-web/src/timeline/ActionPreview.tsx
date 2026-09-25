/**
 * ActionPreview — 署名前の transaction preview (Ethereum v3 §11 D)。
 * Stage A では BFF の build_action 経路が未実装なので、その旨を明示する
 * (結果を模擬しない、UI v2 §4)。
 */
import type { TimelineAction, TimelineEvent } from "@workspace/lib/types";

export function ActionPreview({ action, onBack }: { event: TimelineEvent; action: TimelineAction; onBack: () => void }) {
  return (
    <div className="action-preview">
      <p className="overline">Transaction preview</p>
      <h3>{action.label}</h3>
      <p className="muted small">Transaction building is not connected yet. Nothing was sent.</p>
      <button type="button" className="btn" onClick={onBack} data-autofocus>
        Back
      </button>
    </div>
  );
}
