/**
 * Aave V4 context (Ethereum v3 §3: Aave は時間イベントを持たないので calendar には載せない)。
 * AaveKit の実データのみ。取れない値は "—"。
 */
import { useQueries } from "@tanstack/react-query";
import { api, ApiError } from "../services/api";
import { useActiveAddresses } from "../state/session";
import { fmtRatio, fmtUsd, shortAddress } from "../ui/format";

export function AaveContext() {
  const addrs = useActiveAddresses().filter((a) => a.chain === "ethereum");
  const qs = useQueries({
    queries: addrs.map((a) => ({ queryKey: ["eth", "aave", a.address.toLowerCase()], queryFn: () => api.ethAave(a.address), staleTime: 120_000, retry: 1 })),
  });
  if (addrs.length === 0) return <p className="muted small">Watch an Ethereum address to see its Aave V4 positions.</p>;
  const rows = qs.flatMap((q, i) => (q.data?.positions ?? []).map((p) => ({ owner: addrs[i]!.address, p })));
  const loading = qs.some((q) => q.isPending);
  const failed = qs.filter((q) => q.isError);
  return (
    <>
      {rows.length === 0 ? (
        <p className="muted small">{loading ? "Loading Aave positions…" : "No Aave V4 positions for the watched addresses."}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Spoke</th>
              <th scope="col" className="cell-num">
                Supplied (USD)
              </th>
              <th scope="col" className="cell-num">
                Debt (USD)
              </th>
              <th scope="col" className="cell-num">
                Health factor
              </th>
              <th scope="col" className="cell-num">
                Net APY
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ owner, p }) => {
              const hf = p.healthFactor ? Number(p.healthFactor) : null;
              return (
                <tr key={`${owner}:${p.spokeAddress}`}>
                  <td className="mono">{shortAddress(owner)}</td>
                  <td>{p.spokeName}</td>
                  <td className="cell-num">{p.totalSuppliedUsd ? fmtUsd(p.totalSuppliedUsd) : "—"}</td>
                  <td className="cell-num">{p.totalDebtUsd ? fmtUsd(p.totalDebtUsd) : "—"}</td>
                  <td className={`cell-num${hf !== null && hf < 1.5 ? " hf-warn" : ""}`}>{hf !== null ? hf.toFixed(2) : "—"}</td>
                  <td className="cell-num">{p.netApy !== null ? fmtRatio(p.netApy) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {failed.length > 0 && (
        <p className="error small">
          Aave data could not be loaded for {failed.length} address(es): {failed[0]!.error instanceof ApiError ? failed[0]!.error.message : "error"}
        </p>
      )}
      <p className="muted small">Source: AaveKit (api.aave.com). Aave positions have no dates, so they are context here and never appear on the calendar.</p>
    </>
  );
}
