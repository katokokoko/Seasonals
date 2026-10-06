/**
 * OracleGate — Web 版の WarningArea (spec §8.5 / §4.6、CLAUDE.md §5)。
 * Solana の署名 CTA は必ずこの component の `children` 経由で出す (warning を素通りさせない)。
 *
 * - blocked (両 stale / >5% 乖離 / 未取得): CTA を出さない。blocked の間は 15 秒おきに再確認
 * - warning (片側 stale / 2–5% 乖離): CTA 直上に強警告、出現から 1 秒は CTA をグレーアウト
 * - tier C (Pyth のみ): 通す。2 本目で照合していないことを控えめに 1 行出す (強警告にはしない)
 * - registry 外 (mint = null) / tier D (not_configured): gate 対象外として通す (BFF も同じ判定)
 * BFF の tx builder も同じ oracle を引いて 409 oracle_blocked で拒否する (二重の fail-closed)
 */
import { useEffect, useState, type ReactNode } from "react";
import { ORACLE_WARNING_HEADLINE, oracleBlockLabel, oracleWarningBody } from "@workspace/lib/derive/oracle-gate";
import { useOracleStatus } from "../services/queries";

export const CTA_GRAYOUT_MS = 1000;

export function OracleGate({ mint, children }: { mint: string | null; children: (ctaEnabled: boolean) => ReactNode }) {
  const q = useOracleStatus(mint);
  const data = mint ? q.data : undefined;
  const blocked = data?.status === "blocked";
  const warnings = blocked ? [] : (data?.warnings ?? []);
  const warningKey = warnings.map((w) => w.kind).join(",");
  const [graying, setGraying] = useState(false);
  useEffect(() => {
    if (!warningKey) {
      setGraying(false);
      return;
    }
    setGraying(true);
    const t = setTimeout(() => setGraying(false), CTA_GRAYOUT_MS);
    return () => clearTimeout(t);
  }, [warningKey]);

  const checking = Boolean(mint) && q.isPending;
  // oracle の取得自体に失敗した (BFF に届かない等) 時も止める。builder 側でも拒否される
  const unreachable = Boolean(mint) && q.isError;
  const enabled = !checking && !blocked && !unreachable && !graying;

  return (
    <div className="oracle-gate">
      {checking && (
        <p className="muted small" aria-busy="true">
          Checking the price oracle…
        </p>
      )}
      {blocked && (
        <div className="menu-warning small" role="alert">
          <strong>Blocked for safety: {oracleBlockLabel(data?.block_reason)}.</strong> Seasonals will not build this transaction until the price feeds
          recover. Rechecking every 15 s.
        </div>
      )}
      {unreachable && (
        <p className="menu-warning small" role="alert">
          The price oracle could not be checked, so signing is blocked.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="oracle-warnings" aria-label="Price oracle warnings">
          {warnings.map((w) => (
            <li key={w.kind} className="menu-warning small" role="alert">
              <strong>{ORACLE_WARNING_HEADLINE[w.kind]}.</strong> {oracleWarningBody(w)}.
            </li>
          ))}
        </ul>
      )}
      {data && data.tier === "C" && data.status !== "blocked" && (
        <p className="muted small">Single price source (Pyth). Not cross-checked against a second oracle.</p>
      )}
      {children(enabled)}
    </div>
  );
}
