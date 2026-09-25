/**
 * データ源ごとの状態を 1 行で示す (未接続・失敗を隠さない)。
 */
import type { SourceState } from "../services/queries";

export function SourceStatusLine({ sources }: { sources: SourceState[] }) {
  if (sources.length === 0) return null;
  return (
    <p className="source-line">
      {sources.map((s) => (
        <span key={s.key} className={`source source-${s.status}`} title={s.error}>
          <span className="source-dot" aria-hidden="true" />
          {s.label}: {s.status === "ok" ? `${s.count}` : s.status === "loading" ? "loading" : s.status === "unavailable" ? "not connected yet" : "error"}
        </span>
      ))}
    </p>
  );
}
