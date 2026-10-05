/**
 * Menu の Solana カード内 deposit / withdraw (Seeker MenuDrawer → ActionModal と同じ入力)。
 * - deposit: pool の deposit_asset (無ければ asset) と pool_id で組む (handlePoolTap と同形)
 * - withdraw: 接続 wallet がこの pool に持つ position の全量から (handleWithdrawPosition と同形)
 */
import { useMemo, useState } from "react";
import type { EarnPosition, ProtocolMenuEntry, ProtocolPool } from "@workspace/lib/types";
import { toHumanReadable } from "@workspace/lib/utils/numeric";
import { canWithdrawEarnPosition, depositAction, withdrawActionFromPosition } from "@workspace/lib/derive/solana-action";
import { SolanaExecutePanel } from "../solana/SolanaExecutePanel";
import type { MenuAction } from "./MenuActionPanel";

export function SolanaActionPanel({
  protocol,
  pool,
  action,
  owner,
  positions,
  onClose,
}: {
  protocol: ProtocolMenuEntry;
  pool: ProtocolPool;
  action: MenuAction;
  /** 接続中の Solana address (無ければ panel が接続を案内する) */
  owner: string | null;
  /** 接続 wallet がこの pool に持つ position */
  positions: EarnPosition[];
  onClose: () => void;
}) {
  const withdrawable = useMemo(() => positions.filter((p) => canWithdrawEarnPosition(p)), [positions]);
  const [picked, setPicked] = useState(0);
  const title = `${protocol.display_name} ${pool.name}`;
  if (action === "deposit") {
    return (
      <SolanaExecutePanel
        action={depositAction(protocol.protocol_id, pool.deposit_asset ?? pool.asset, pool.pool_id)}
        owner={owner}
        title={title}
        onClose={onClose}
      />
    );
  }
  const position = withdrawable[picked] ?? withdrawable[0];
  if (!position) {
    return <p className="muted small">Nothing withdrawable from this pool at the connected wallet.</p>;
  }
  return (
    <div className="solana-withdraw">
      {withdrawable.length > 1 && (
        <label className="small">
          Position
          <select className="select" value={picked} onChange={(e) => setPicked(Number(e.target.value))}>
            {withdrawable.map((p, i) => (
              <option key={p.share_mint} value={i}>
                {p.market_symbol} · {toHumanReadable(p.underlying_amount, p.underlying_decimals)} {p.asset_symbol}
              </option>
            ))}
          </select>
        </label>
      )}
      <SolanaExecutePanel key={position.share_mint} action={withdrawActionFromPosition(position)} owner={owner} title={title} onClose={onClose} />
    </div>
  );
}
