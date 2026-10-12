/**
 * Menu の Solana カード内 deposit / withdraw (Seeker MenuDrawer → ActionModal と同じ入力)。
 * - deposit: pool の deposit_asset (無ければ asset) と pool_id で組む (handlePoolTap と同形)。
 *   market が funding token を受け付け (Jupiter Lend JupUSD は USDC)、接続 wallet が underlying を持たず
 *   funding token を持つなら、その token で払う funding deposit にする (lib chooseDepositFunding、mint で判定)
 * - withdraw: 接続 wallet がこの pool に持つ position の全量から (handleWithdrawPosition と同形)
 */
import { useMemo, useState } from "react";
import type { EarnPosition, ProtocolMenuEntry, ProtocolPool } from "@workspace/lib/types";
import { toHumanReadable } from "@workspace/lib/utils/numeric";
import {
  canWithdrawEarnPosition,
  depositAction,
  fundedDepositAction,
  normalizeSolanaProtocol,
  withdrawActionFromPosition,
} from "@workspace/lib/derive/solana-action";
import { findMarketByProtocolAsset, type SwapEarnMarket } from "@workspace/lib/config/swap-earn-markets";
import { chooseDepositFunding } from "@workspace/lib/derive/deposit-funding";
import { useSolanaWalletHoldings } from "../services/queries";
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
  const depositAsset = pool.deposit_asset ?? pool.asset;
  const market = fundableMarket(protocol.protocol_id, depositAsset);
  // funding を受け付ける market の時だけ wallet の保有を引く (cache は残高表示と共有)
  const { holdings, isLoading } = useSolanaWalletHoldings(action === "deposit" && market ? owner : null);
  if (action === "deposit") {
    if (market && isLoading) return <p className="muted small">Checking wallet balance…</p>;
    const choice = market && holdings ? chooseDepositFunding(market, holdings) : null;
    const funded = choice?.kind === "funding" ? choice.token : null;
    return (
      <SolanaExecutePanel
        key={funded ? `funded:${funded.mint}` : "underlying"}
        action={
          funded && market
            ? fundedDepositAction(protocol.protocol_id, funded.symbol, market.share_mint, pool.pool_id)
            : depositAction(protocol.protocol_id, depositAsset, pool.pool_id)
        }
        owner={owner}
        title={title}
        note={funded && market ? `Pay with ${funded.symbol}: you hold no ${market.underlying_symbol}, so Jupiter swaps your ${funded.symbol} in the same transaction.` : undefined}
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

/** funding token を受け付ける swap-earn market (無ければ undefined = underlying 払いのみ) */
export function fundableMarket(protocolId: string, depositAsset: string): SwapEarnMarket | undefined {
  const m = findMarketByProtocolAsset(normalizeSolanaProtocol(protocolId), depositAsset);
  return m?.funding?.length ? m : undefined;
}
