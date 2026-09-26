/**
 * 保有一覧 (Seeker の Wallet holdings 相当)。donut の table view を兼ねる。
 * 値は BFF の holdings (現在残高 × 現在単価) のみ。単価が不明な asset は BFF が載せない。
 */
import { LABEL_BY_CATEGORY } from "@workspace/lib/derive/portfolio";
import type { PortfolioHolding } from "@workspace/lib/types";
import { compareUsd8 } from "@workspace/lib/utils/numeric";
import { ChainIcon } from "../../ui/ChainIcon";
import { fmtAmount, fmtUsd, shortAddress } from "../../ui/format";
import { ProtocolBadge } from "../../ui/ProtocolBadge";

/** wallet 直置き (protocol に預けていない) は protocol ロゴではなく chain を出す */
const isWallet = (h: PortfolioHolding) => h.protocol_id.startsWith("wallet_") || h.protocol_id === "ethereum";

export function HoldingsTable({ holdings, showAddress }: { holdings: PortfolioHolding[]; showAddress: boolean }) {
  const rows = [...holdings].sort((a, b) => compareUsd8(b.usd, a.usd));
  return (
    <table className="data-table holdings-table">
      <thead>
        <tr>
          <th scope="col">Asset</th>
          <th scope="col">Category</th>
          {showAddress && <th scope="col">Address</th>}
          <th scope="col" className="cell-num">
            Amount
          </th>
          <th scope="col" className="cell-num">
            Value (USD)
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={`${h.chain}:${h.address}:${h.protocol_id}:${h.symbol}`}>
            <td>
              <span className="brand-inline">
                {isWallet(h) ? <ChainIcon chain={h.chain} size={18} /> : <ProtocolBadge id={h.protocol_id} name={h.symbol} size={18} />}
                {h.symbol}
                {!h.in_history && (
                  <span className="tag" title="Only the current value is known, so it is not part of the history line.">
                    Current only
                  </span>
                )}
              </span>
            </td>
            <td>{LABEL_BY_CATEGORY[h.category]}</td>
            {showAddress && <td className="mono">{shortAddress(h.address)}</td>}
            <td className="cell-num">{h.amount ? fmtAmount(h.amount) : "—"}</td>
            <td className="cell-num">{fmtUsd(h.usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
