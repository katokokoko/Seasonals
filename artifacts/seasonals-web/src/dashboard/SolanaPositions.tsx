/**
 * Your Positions (Solana) — /positions/earn の保有を 1 表にし、行から withdraw する (Seeker MenuDrawer の Your Positions)。
 * - 量・評価額は BFF が返した smallest unit / 8 桁 USD string をそのまま整形 (§4.5、Number で計算しない)
 * - Withdraw は route のある position (lib canWithdrawEarnPosition) かつ接続 wallet の address の時だけ
 * - 取れなかった address は隠さず名前を出す (0 と見せない)
 */
import { Fragment, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { PERENA_APP_URL, PERENA_LEGACY_USD_STAR_DECIMALS, PERENA_LEGACY_USD_STAR_MINT } from "@workspace/lib/config/perena";
import type { EarnPosition } from "@workspace/lib/types";
import { canWithdrawEarnPosition, withdrawActionFromPosition } from "@workspace/lib/derive/solana-action";
import { queryKeys, useSolanaEarnPositions, type SolanaPositionRow } from "../services/queries";
import { api } from "../services/api";
import { useActiveAddresses, useConnectedAddress } from "../state/session";
import { requestOpenWallet } from "../timeline/detailStore";
import { SolanaExecutePanel } from "../solana/SolanaExecutePanel";
import { fmtAmount, fmtFullDate, fmtRatio, fmtUsd, shortAddress } from "../ui/format";
import { ProtocolBadge } from "../ui/ProtocolBadge";
import "../solana/solana.css";

const rowKey = (r: SolanaPositionRow) => `${r.address}:${r.position.protocol_id}:${r.position.share_mint}`;

function earned(p: EarnPosition): { text: string; cls?: string } {
  if (p.accrued_yield_sign === "unknown") return { text: "—" };
  const v = fmtAmount({ value: p.accrued_yield_amount, decimals: p.underlying_decimals, symbol: p.asset_symbol });
  return p.accrued_yield_sign === "loss" ? { text: `−${v}`, cls: "negative" } : { text: `+${v}`, cls: "positive" };
}

function withdrawBlock(r: SolanaPositionRow, connected: string | null, now: Date): string | null {
  if (!canWithdrawEarnPosition(r.position, now)) {
    return r.position.maturity_at && new Date(r.position.maturity_at).getTime() > now.getTime()
      ? "Redeemable after maturity"
      : "Seasonals cannot build a withdrawal for this position yet";
  }
  if (connected !== r.address) return "Connect this wallet to withdraw";
  return null;
}

/**
 * 旧 USD* (Perena が 2026 に新 token へ移行した前の LP token) の保有。Seasonals では引き出せないので
 * Perena app へ案内する (ユーザー決定)。/positions は deposit 残高と同じ query を共有する
 */
function LegacyUsdStarNotice() {
  const sol = useActiveAddresses().filter((a) => a.chain === "solana");
  const results = useQueries({
    queries: sol.map((a) => ({ queryKey: queryKeys.solPositions(a.address), queryFn: () => api.solanaPositions(a.address), staleTime: 60_000, retry: 1 })),
  });
  const held = results.flatMap((r, i) =>
    (r.data ?? [])
      .filter((p) => (p.raw_state as { mint?: unknown } | undefined)?.mint === PERENA_LEGACY_USD_STAR_MINT && /^[1-9][0-9]*$/.test(p.current_amount))
      .map((p) => ({ address: sol[i]!.address, amount: p.current_amount }))
  );
  if (held.length === 0) return null;
  return (
    <p className="menu-warning small" role="note">
      {held.map((h) => `${shortAddress(h.address)} holds ${fmtAmount({ value: h.amount, decimals: PERENA_LEGACY_USD_STAR_DECIMALS, symbol: "legacy USD*" })}`).join(" · ")}. Perena moved USD* to
      a new token; withdraw or migrate legacy USD* in the{" "}
      <a href={PERENA_APP_URL} target="_blank" rel="noreferrer">
        Perena app ↗
      </a>
      .
    </p>
  );
}

export function SolanaPositions() {
  const { rows, failed, isLoading, hasAddress } = useSolanaEarnPositions();
  const connected = useConnectedAddress("solana");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const now = new Date();
  const multi = new Set(rows.map((r) => r.address)).size > 1;

  if (!hasAddress) {
    return (
      <p className="muted">
        <button type="button" className="btn-link" onClick={requestOpenWallet}>
          Connect or watch a Solana wallet
        </button>{" "}
        to see its positions.
      </p>
    );
  }
  return (
    <>
      <LegacyUsdStarNotice />
      {isLoading && rows.length === 0 ? (
        <p className="muted" aria-busy="true">
          Reading positions…
        </p>
      ) : rows.length === 0 ? (
        <p className="muted">No Solana positions for the watched addresses.</p>
      ) : (
        <table className="data-table solana-positions">
          <thead>
            <tr>
              <th scope="col">Protocol</th>
              <th scope="col">Market</th>
              {multi && <th scope="col">Address</th>}
              <th scope="col" className="cell-num">
                Amount
              </th>
              <th scope="col" className="cell-num">
                Value (USD)
              </th>
              <th scope="col" className="cell-num">
                APY
              </th>
              <th scope="col" className="cell-num">
                Earned
              </th>
              <th scope="col">Maturity</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = r.position;
              const k = rowKey(r);
              const block = withdrawBlock(r, connected, now);
              const e = earned(p);
              const usdKnown = !/^0(\.0+)?$/.test(p.underlying_usd);
              return (
                <Fragment key={k}>
                  <tr>
                    <td>
                      <span className="brand-inline">
                        <ProtocolBadge id={p.protocol_id} name={p.protocol_name} size={18} />
                        {p.protocol_name}
                      </span>
                    </td>
                    <td>{p.market_symbol}</td>
                    {multi && <td className="mono">{shortAddress(r.address)}</td>}
                    <td className="cell-num">{fmtAmount({ value: p.underlying_amount, decimals: p.underlying_decimals, symbol: p.asset_symbol })}</td>
                    <td className="cell-num">{usdKnown ? fmtUsd(p.underlying_usd) : "—"}</td>
                    <td className="cell-num">{p.supply_rate_bps === null ? "—" : fmtRatio(p.supply_rate_bps / 10_000)}</td>
                    <td className={`cell-num ${e.cls ?? ""}`}>{e.text}</td>
                    <td>{p.maturity_at ? fmtFullDate(new Date(p.maturity_at)) : "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-quiet"
                        disabled={Boolean(block)}
                        title={block ?? undefined}
                        aria-expanded={openKey === k}
                        onClick={() => setOpenKey(openKey === k ? null : k)}
                      >
                        Withdraw
                      </button>
                    </td>
                  </tr>
                  {openKey === k && !block && (
                    <tr className="solana-positions-panel">
                      <td colSpan={multi ? 9 : 8}>
                        <SolanaExecutePanel
                          action={withdrawActionFromPosition(p)}
                          owner={r.address}
                          title={`${p.protocol_name} ${p.market_symbol}`}
                          onClose={() => setOpenKey(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {failed.length > 0 && (
        <p className="small menu-warning" role="alert">
          Could not read positions for {failed.join(", ")}. They are left out here, not counted as zero.
        </p>
      )}
      <p className="muted small">Earned is in the underlying token and excludes price changes. “—” means the cost basis is unknown.</p>
    </>
  );
}
