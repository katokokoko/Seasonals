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
 * - 2026-10-13: `lastValidBlockHeight` も返す。swap-earn (`SwapEarnTxResponse`) だけが持ち、
 *   ActionModal の着地確認 (lib `confirmSignatures`) が「期限切れ = もう取り込まれない」を
 *   確定するのに使う。他 builder は null (= 時間切れで unknown に落ちる)
 */
import type { SolanaRoute } from "@workspace/lib/derive/solana-action";
import type { BuiltTxs } from "@workspace/lib/derive/tx-confirm";

import * as api from "./api";

/** swap-earn builder に渡す slippage (旧 ActionModal 8.15 と同値) */
export const SWAP_EARN_SLIPPAGE_BPS = 50;

/**
 * builder 1 本分の結果 (base64 unsigned tx 群 + 着地確認用の期限)。
 * 型は lib `BuiltTxs` が canonical (web / agent plan execute と同じ形、CLAUDE.md §1)
 */
export type { BuiltTxs };

export async function buildSolanaTxs(
  route: SolanaRoute,
  user: string,
  amount: string
): Promise<BuiltTxs> {
  switch (route.kind) {
    case "swap_earn_deposit": {
      // 2026-10-13: funding deposit (USDC → jlJupUSD 等) だけ inputMint を載せる。
      // 省略 = underlying (旧 BFF / 従来の body と完全に同じ)
      const r = await api.getSwapEarnDepositTx({
        user,
        shareMint: route.shareMint,
        amount,
        slippageBps: SWAP_EARN_SLIPPAGE_BPS,
        ...(route.inputMint ? { inputMint: route.inputMint } : {}),
      });
      return { txs: [r.swapTransaction], lastValidBlockHeight: r.lastValidBlockHeight };
    }
    case "swap_earn_withdraw": {
      const r = await api.getSwapEarnWithdrawTx({
        user,
        shareMint: route.shareMint,
        amount,
        slippageBps: SWAP_EARN_SLIPPAGE_BPS,
      });
      return { txs: [r.swapTransaction], lastValidBlockHeight: r.lastValidBlockHeight };
    }
    case "kamino_deposit":
      return noExpiry([
        (await api.getKaminoDepositTx({ user, reserve: route.reserve, amount }))
          .transaction,
      ]);
    case "kamino_withdraw":
      return noExpiry([
        (await api.getKaminoWithdrawTx({ user, reserve: route.reserve, amount }))
          .transaction,
      ]);
    case "kamino_vault_deposit":
      return noExpiry([
        (await api.getKaminoVaultDepositTx({ user, vault: route.vault, amount }))
          .transaction,
      ]);
    case "kamino_vault_withdraw":
      return noExpiry([
        (await api.getKaminoVaultWithdrawTx({ user, vault: route.vault, amount }))
          .transaction,
      ]);
    case "meteora_deposit":
      return noExpiry(
        (
          await api.getMeteoraDepositTxns({ user, poolKey: route.poolKey, amount })
        ).transactions
      );
    case "meteora_withdraw":
      return noExpiry(
        (
          await api.getMeteoraWithdrawTxns({ user, position: route.position, amount })
        ).transactions
      );
    case "orca_deposit":
      return noExpiry(
        (
          await api.getOrcaDepositTxns({ user, poolKey: route.poolKey, amount })
        ).transactions
      );
    case "orca_withdraw":
      return noExpiry(
        (
          await api.getOrcaWithdrawTxns({ user, position: route.position, amount })
        ).transactions
      );
    case "save_deposit":
      return noExpiry(
        (
          await api.getSaveDepositTxns({ user, reserve: route.reserve, amount })
        ).transactions
      );
    case "save_withdraw":
      return noExpiry(
        (
          await api.getSaveWithdrawTxns({
            user,
            ctokenMint: route.ctokenMint,
            amount,
          })
        ).transactions
      );
    case "exponent_redeem":
      return noExpiry([
        (await api.getExponentRedeemTx({ user, ptMint: route.ptMint, amount }))
          .transaction,
      ]);
    default: {
      // 新しい route kind が lib に増えたら型で落とす (fail-closed)
      const unreachable: never = route;
      throw new Error(
        `unsupported_solana_route: ${(unreachable as { kind?: string }).kind ?? "unknown"}`
      );
    }
  }
}

/** `lastValidBlockHeight` を返さない builder 用 (期限は分からない → confirm は時間切れで判定) */
function noExpiry(txs: string[]): BuiltTxs {
  return { txs, lastValidBlockHeight: null };
}
