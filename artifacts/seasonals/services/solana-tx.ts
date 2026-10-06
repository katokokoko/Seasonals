/**
 * solana-tx — SolanaRoute → BFF の unsigned tx builder 1 本 → base64 tx の配列。
 *
 * market の解決 (どの builder を呼ぶか) は `lib/derive/solana-action.ts` の
 * `resolveSolanaRoute` が canonical (web `seasonals-web/src/solana/buildTx.ts` と同じ switch)。
 * 本層は mobile `services/api.ts` の builder 名・応答 key の差 (`swapTransaction` /
 * `transaction` / `transactions`) を吸収するだけ (CLAUDE.md §1 same source of truth、§5)。
 *
 * - swap-earn は slippage を呼び手が渡す API なので 50 bps を明示する (旧 ActionModal と同値)
 * - amount は smallest-unit string のまま素通し (§4.5、変換しない)
 * - error は builder が投げたものをそのまま伝搬 (swap-earn は BffError、他は plain Error)
 */
import type { SolanaRoute } from "@workspace/lib/derive/solana-action";

import * as api from "./api";

/** swap-earn builder に渡す slippage (旧 ActionModal 8.15 と同値) */
export const SWAP_EARN_SLIPPAGE_BPS = 50;

export async function buildSolanaTxs(
  route: SolanaRoute,
  user: string,
  amount: string
): Promise<string[]> {
  switch (route.kind) {
    case "swap_earn_deposit":
      return [
        (
          await api.getSwapEarnDepositTx({
            user,
            shareMint: route.shareMint,
            amount,
            slippageBps: SWAP_EARN_SLIPPAGE_BPS,
          })
        ).swapTransaction,
      ];
    case "swap_earn_withdraw":
      return [
        (
          await api.getSwapEarnWithdrawTx({
            user,
            shareMint: route.shareMint,
            amount,
            slippageBps: SWAP_EARN_SLIPPAGE_BPS,
          })
        ).swapTransaction,
      ];
    case "kamino_deposit":
      return [
        (await api.getKaminoDepositTx({ user, reserve: route.reserve, amount }))
          .transaction,
      ];
    case "kamino_withdraw":
      return [
        (await api.getKaminoWithdrawTx({ user, reserve: route.reserve, amount }))
          .transaction,
      ];
    case "kamino_vault_deposit":
      return [
        (await api.getKaminoVaultDepositTx({ user, vault: route.vault, amount }))
          .transaction,
      ];
    case "kamino_vault_withdraw":
      return [
        (await api.getKaminoVaultWithdrawTx({ user, vault: route.vault, amount }))
          .transaction,
      ];
    case "meteora_deposit":
      return (
        await api.getMeteoraDepositTxns({ user, poolKey: route.poolKey, amount })
      ).transactions;
    case "meteora_withdraw":
      return (
        await api.getMeteoraWithdrawTxns({ user, position: route.position, amount })
      ).transactions;
    case "orca_deposit":
      return (
        await api.getOrcaDepositTxns({ user, poolKey: route.poolKey, amount })
      ).transactions;
    case "orca_withdraw":
      return (
        await api.getOrcaWithdrawTxns({ user, position: route.position, amount })
      ).transactions;
    case "save_deposit":
      return (
        await api.getSaveDepositTxns({ user, reserve: route.reserve, amount })
      ).transactions;
    case "save_withdraw":
      return (
        await api.getSaveWithdrawTxns({
          user,
          ctokenMint: route.ctokenMint,
          amount,
        })
      ).transactions;
    case "exponent_redeem":
      return [
        (await api.getExponentRedeemTx({ user, ptMint: route.ptMint, amount }))
          .transaction,
      ];
    default: {
      // 新しい route kind が lib に増えたら型で落とす (fail-closed)
      const unreachable: never = route;
      throw new Error(
        `unsupported_solana_route: ${(unreachable as { kind?: string }).kind ?? "unknown"}`
      );
    }
  }
}
