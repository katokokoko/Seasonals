/**
 * PortfolioPanel — Dashboard 上部の Portfolio (Seeker の PortfolioSummary 相当)。
 *
 * - 総額 / 入出金を除いた増減 / 資産推移グラフ / category 別 Allocation / 保有一覧
 * - 閲覧中の全 address (chain 混在) を USD で合算し、chip で 1 address に絞れる
 * - 値は BFF が復元・取得した実データのみ。取れなかった address は **合算から外した
 *   ことを明示**する (0 として混ぜない、UI v2 §11)
 * - 合算・集計は lib/derive/portfolio (bigint)。Number 化は描画直前だけ
 */
import { useState } from "react";
import {
  RANGE_KEYS,
  allocationByCategory,
  chartAreaState,
  flowMarkerIndices,
  hasHistory,
  historyChangeExFlows,
  historyCoverage,
  mergeHistorySeries,
  mergedHistoryToPoints,
  rangeExceedsCoverage,
  sumHoldingsUsd,
  type PortfolioScope,
  type RangeKey,
} from "@workspace/lib/derive/portfolio";
import { signedUsd8ToBigInt } from "@workspace/lib/utils/numeric";
import { usePortfolioHistories, usePortfolioHoldings, type PortfolioSourceResult } from "../../services/queries";
import type { ActiveAddress } from "../../state/session";
import { requestOpenWallet } from "../../timeline/detailStore";
import { ChainIcon } from "../../ui/ChainIcon";
import { fmtFullDate, fmtUsd, shortAddress } from "../../ui/format";
import { AllocationDonut } from "./AllocationDonut";
import { HistoryChart } from "./HistoryChart";
import { HoldingsTable } from "./HoldingsTable";
import "./portfolio.css";

const keyOf = (a: ActiveAddress) => `${a.chain}:${a.address}`;
const labelOf = (a: ActiveAddress) => `${a.chain === "ethereum" ? "Ethereum" : "Solana"} ${shortAddress(a.address)}`;

export function PortfolioPanel() {
  const [range, setRange] = useState<RangeKey>("1M");
  const [scope, setScope] = useState<PortfolioScope>("total");
  const [picked, setPicked] = useState<string>("all");

  const histories = usePortfolioHistories(range);
  const holdingsQ = usePortfolioHoldings();
  const addresses = histories.map((h) => h.address);
  const selectedKey = picked !== "all" && addresses.some((a) => keyOf(a) === picked) ? picked : "all";
  const inSelection = <T,>(r: PortfolioSourceResult<T>) => selectedKey === "all" || keyOf(r.address) === selectedKey;

  const hist = histories.filter(inSelection);
  const hold = holdingsQ.filter(inSelection);
  // 合算は ≤ 6 系列 × ~90 点の bigint 加算なので render ごとに計算してよい
  const merged = mergeHistorySeries(hist.flatMap((h) => (h.data ? [h.data] : [])));
  const holdings = hold.flatMap((h) => h.data?.holdings ?? []);

  const points = mergedHistoryToPoints(merged.points, scope);
  const showChart = hasHistory(points);
  const coverage = historyCoverage(points, range);
  const change = showChart ? historyChangeExFlows(merged.points, scope) : null;
  const total = sumHoldingsUsd(holdings, scope);
  const segments = allocationByCategory(holdings, scope);
  const holdingsLoading = hold.some((h) => h.isPending);
  const area = chartAreaState({
    hasPositions: addresses.length > 0,
    showChart,
    historyFetching: hist.some((h) => h.isFetching),
  });
  // 取れなかった address は合算から外し、理由を 1 行ずつ出す (同じ理由の history /
  // holdings はまとめる)
  const failures = new Map<string, { address: ActiveAddress; error: string; what: string[] }>();
  for (const [what, list] of [["history", hist], ["holdings", hold]] as const) {
    for (const r of list) {
      if (!r.error) continue;
      const k = `${keyOf(r.address)}|${r.error}`;
      const f = failures.get(k) ?? { address: r.address, error: r.error, what: [] };
      f.what.push(what);
      failures.set(k, f);
    }
  }
  // 1 件も取れていないのに $0.00 と出すのは架空値。取れた分があれば合算を出す
  const holdingsLoaded = hold.some((h) => h.data !== undefined);
  const holdingsFailed = hold.length > 0 && hold.every((h) => h.error);

  if (addresses.length === 0) {
    return (
      <p className="connect-note">
        Connect or watch a wallet to see its value over time and allocation.{" "}
        <button type="button" className="btn-link" onClick={requestOpenWallet}>
          Connect wallet
        </button>
      </p>
    );
  }

  return (
    <div className="portfolio">
      <div className="portfolio-head">
        <div className="portfolio-total">
          <span className="stat-label">{scope === "total" ? "Total value" : "Deposited value"}</span>
          <span className="portfolio-total-value" data-testid="portfolio-total">
            {holdingsLoaded ? fmtUsd(total) : holdingsLoading ? "…" : "—"}
          </span>
          {change !== null && <ChangeLine usd8={change} range={range} />}
        </div>
        <div className="portfolio-controls">
          <div className="segmented" role="group" aria-label="Scope">
            <button type="button" aria-pressed={scope === "total"} onClick={() => setScope("total")}>
              Total
            </button>
            <button type="button" aria-pressed={scope === "deposited"} onClick={() => setScope("deposited")}>
              Deposited
            </button>
          </div>
          <div className="segmented" role="group" aria-label="Range">
            {RANGE_KEYS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                className={rangeExceedsCoverage(r, coverage) ? "is-dim" : undefined}
                title={rangeExceedsCoverage(r, coverage) ? "Longer than the history that can be reconstructed" : undefined}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {addresses.length > 1 && (
        <div className="address-chips" role="group" aria-label="Addresses">
          <button type="button" className="address-chip" aria-pressed={selectedKey === "all"} onClick={() => setPicked("all")}>
            All addresses
          </button>
          {addresses.map((a) => (
            <button key={keyOf(a)} type="button" className="address-chip" aria-pressed={selectedKey === keyOf(a)} onClick={() => setPicked(keyOf(a))}>
              <ChainIcon chain={a.chain} size={14} />
              <span className="mono">{shortAddress(a.address)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="portfolio-grid">
        <section className="portfolio-card" aria-labelledby="portfolio-history">
          <h3 id="portfolio-history" className="portfolio-card-title">
            Value over time
          </h3>
          {area === "chart" ? (
            <HistoryChart points={points} />
          ) : area === "brewing" ? (
            <div className="chart-placeholder is-brewing" role="status">
              Brewing your chart… reconstructing balances from on-chain history.
            </div>
          ) : (
            <div className="chart-placeholder" role="status">
              {hist.length > 0 && hist.every((h) => h.error)
                ? "History could not be loaded for the selected addresses."
                : "Not enough history to draw a line yet. The current value is shown above."}
            </div>
          )}
          <HistoryNotes merged={merged} coverage={coverage} showChart={showChart} points={points} />
        </section>

        <section className="portfolio-card" aria-labelledby="portfolio-allocation">
          <h3 id="portfolio-allocation" className="portfolio-card-title">
            Allocation
          </h3>
          {segments.length > 0 ? (
            <AllocationDonut segments={segments} totalUsd8={total} />
          ) : (
            <p className="muted small">
              {holdingsFailed
                ? "Holdings could not be loaded for the selected addresses."
                : holdingsLoading
                  ? "Loading holdings…"
                  : scope === "deposited"
                    ? "Nothing deposited in a protocol."
                    : "No priced holdings for the selected addresses."}
            </p>
          )}
        </section>
      </div>

      {failures.size > 0 && (
        <ul className="portfolio-failures" aria-label="Not included">
          {[...failures.entries()].map(([k, f]) => (
            <li key={k} className="error small">
              Not included — {labelOf(f.address)} ({f.what.join(" and ")}): {f.error}
            </li>
          ))}
        </ul>
      )}

      {holdings.length > 0 && (
        <section aria-labelledby="portfolio-holdings">
          <h3 id="portfolio-holdings" className="portfolio-card-title">
            Holdings
          </h3>
          <HoldingsTable holdings={scope === "deposited" ? holdings.filter((h) => h.deposited) : holdings} showAddress={selectedKey === "all" && addresses.length > 1} />
        </section>
      )}
    </div>
  );
}

function ChangeLine({ usd8, range }: { usd8: string; range: RangeKey }) {
  const v = signedUsd8ToBigInt(usd8);
  const sign = v > 0n ? "+" : v < 0n ? "−" : "±";
  const abs = usd8.startsWith("-") ? usd8.slice(1) : usd8;
  return (
    <span className={`portfolio-change${v > 0n ? " is-up" : v < 0n ? " is-down" : ""}`} data-testid="portfolio-change">
      {sign}
      {fmtUsd(abs)} <span className="muted">in {range}, excluding deposits and withdrawals</span>
    </span>
  );
}

function HistoryNotes({
  merged,
  coverage,
  showChart,
  points,
}: {
  merged: ReturnType<typeof mergeHistorySeries>;
  coverage: ReturnType<typeof historyCoverage>;
  showChart: boolean;
  points: ReturnType<typeof mergedHistoryToPoints>;
}) {
  const hasMarkers = flowMarkerIndices(points).length > 0;
  const notes: string[] = [];
  if (showChart && coverage.partial && coverage.from) {
    notes.push(
      merged.truncated
        ? `History from ${fmtFullDate(coverage.from)} — the earliest date every selected address can be reconstructed.`
        : `History from ${fmtFullDate(coverage.from)} — no balance before that.`
    );
  }
  if (merged.approximated_symbols.length > 0) {
    notes.push(`Estimated: ${merged.approximated_symbols.join(", ")} (past price or rebasing balance approximated).`);
  }
  if (merged.excluded_from_history.length > 0) {
    notes.push(`${merged.excluded_from_history.join(", ")}: current value only, not part of this line.`);
  }
  if (!showChart && notes.length === 0) return null;
  return (
    <div className="chart-notes">
      {showChart && hasMarkers && (
        <p className="chart-legend small muted">
          <span className="flow-dot is-in" aria-hidden="true" /> Deposit <span className="flow-dot is-out" aria-hidden="true" /> Withdrawal
        </p>
      )}
      {notes.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
    </div>
  );
}
