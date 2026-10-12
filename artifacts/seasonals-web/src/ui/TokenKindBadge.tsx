/**
 * Pendle の PT (元本) / YT (利回り) バッジ。色だけに頼らず形でも区別する:
 * PT = 塗り (--brand-pendle の地 + 白文字)、YT = 縁取り (枠 + 薄い地 + 本文色)。
 */
const LABEL = { pt: "Principal Token", yt: "Yield Token" } as const;

export function TokenKindBadge({ kind }: { kind: "pt" | "yt" }) {
  return (
    <span className={`token-kind token-kind-${kind}`} role="img" aria-label={LABEL[kind]} title={LABEL[kind]}>
      {kind.toUpperCase()}
    </span>
  );
}
