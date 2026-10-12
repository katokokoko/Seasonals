/**
 * SolanaRoute → BFF の unsigned tx builder 1 本 → lib `BuiltTxs` (base64 tx の配列 + lastValidBlockHeight)。
 * Seeker ActionModal の各 runOnchainTx(...) 分岐と同じ endpoint / body (応答の key 差もここで吸収する)。
 * swap-earn は `lastValidBlockHeight` も返す (着地確認で expired を確定できる、lib tx-confirm)。他は null。
 */
import type { SolanaRoute } from "@workspace/lib/derive/solana-action";
import type { BuiltTxs } from "@workspace/lib/derive/tx-confirm";
import { api } from "../services/api";

export async function buildSolanaTxs(route: SolanaRoute, user: string, amount: string): Promise<BuiltTxs> {
  if (route.kind === "swap_earn_deposit" || route.kind === "swap_earn_withdraw") {
    const r =
      route.kind === "swap_earn_deposit"
        ? await api.solanaSwapEarnDepositTx({ user, shareMint: route.shareMint, amount })
        : await api.solanaSwapEarnWithdrawTx({ user, shareMint: route.shareMint, amount });
    return { txs: [r.swapTransaction], lastValidBlockHeight: r.lastValidBlockHeight };
  }
  return { txs: await buildOtherTxs(route, user, amount), lastValidBlockHeight: null };
}

async function buildOtherTxs(
  route: Exclude<SolanaRoute, { kind: "swap_earn_deposit" | "swap_earn_withdraw" }>,
  user: string,
  amount: string
): Promise<string[]> {
  switch (route.kind) {
    case "kamino_deposit":
      return [(await api.solanaKaminoDepositTx({ user, reserve: route.reserve, amount })).transaction];
    case "kamino_withdraw":
      return [(await api.solanaKaminoWithdrawTx({ user, reserve: route.reserve, amount })).transaction];
    case "kamino_vault_deposit":
      return [(await api.solanaKaminoVaultDepositTx({ user, vault: route.vault, amount })).transaction];
    case "kamino_vault_withdraw":
      return [(await api.solanaKaminoVaultWithdrawTx({ user, vault: route.vault, amount })).transaction];
    case "meteora_deposit":
      return (await api.solanaMeteoraDepositTxns({ user, poolKey: route.poolKey, amount })).transactions;
    case "meteora_withdraw":
      return (await api.solanaMeteoraWithdrawTxns({ user, position: route.position, amount })).transactions;
    case "orca_deposit":
      return (await api.solanaOrcaDepositTxns({ user, poolKey: route.poolKey, amount })).transactions;
    case "orca_withdraw":
      return (await api.solanaOrcaWithdrawTxns({ user, position: route.position, amount })).transactions;
    case "save_deposit":
      return (await api.solanaSaveDepositTxns({ user, reserve: route.reserve, amount })).transactions;
    case "save_withdraw":
      return (await api.solanaSaveWithdrawTxns({ user, ctokenMint: route.ctokenMint, amount })).transactions;
    case "exponent_redeem":
      return [(await api.solanaExponentRedeemTx({ user, ptMint: route.ptMint, amount })).transaction];
  }
}
