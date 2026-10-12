/**
 * SolanaRoute → BFF の unsigned tx builder 1 本 → base64 tx の配列。
 * Seeker ActionModal の各 runOnchainTx(...) 分岐と同じ endpoint / body (応答の key 差もここで吸収する)。
 */
import type { SolanaRoute } from "@workspace/lib/derive/solana-action";
import { api } from "../services/api";

export async function buildSolanaTxs(route: SolanaRoute, user: string, amount: string): Promise<string[]> {
  switch (route.kind) {
    case "swap_earn_deposit":
      return [(await api.solanaSwapEarnDepositTx({ user, shareMint: route.shareMint, amount })).swapTransaction];
    case "swap_earn_withdraw":
      return [(await api.solanaSwapEarnWithdrawTx({ user, shareMint: route.shareMint, amount })).swapTransaction];
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
