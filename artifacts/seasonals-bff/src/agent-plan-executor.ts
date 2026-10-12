/**
 * agent-plan-executor — AgentPlan の selected_action を unsigned tx 群に組む (2026-10-06)
 *
 * `POST /agent-plans/:id/execute` 専用。market の解決は lib の `resolveSolanaRoute`
 * (Seeker / web と同じ 13 route、順序は lib test が固定) に任せ、tx は **人が使う
 * `/protocols/*` の tx builder route を `app.inject` で in-process に呼んで** 組む。
 *
 * 関数を直接 import せず route を叩く理由: §4.5 の境界検証、§4.6 の oracle fail-closed gate、
 * 8.72 の償還価値ガード、8.80 の残高 gate、Kamino の預入停止 / cap、Exponent の満期判定、
 * Meteora / Orca の position 解決は各 route handler (と handler が呼ぶ buildSwapEarnTx /
 * buildKaminoTx / buildKaminoVaultTx / buildSaveTx) に住んでいる。agent 経路だけ別実装に
 * すると 8.37 (B1) / 8.75 で 2 度起きた「agent 経路だけガードを素通り」の drift が再発する。
 * route を通せば人と Agent で判定が 1 か所になる (same source of truth)。
 *
 * 失敗 (4xx / 5xx) は builder の status と body をそのまま返す。呼び手 (execute) は
 * token を消費する前にこれを呼ぶので、oracle block / fair value block で単発 token は
 * 失われない (§29.3、8.37 B1 / 8.75 の順序)。
 */

import type { FastifyInstance } from "fastify";

import type {
  ActionSpec,
  AgentPlanUnsignedTransaction,
} from "@workspace/lib/types";
import type { SolanaRoute } from "@workspace/lib/derive/solana-action";

/** swap-earn は呼び手が slippage を明示する (Seeker / web と同じ 50bps) */
const SWAP_EARN_SLIPPAGE_BPS = 50;

/** route 1 本 → BFF の tx builder endpoint と body、応答の tx が入っている key */
export interface TxBuildRequest {
  url: string;
  payload: Record<string, string | number>;
  /** 応答の key の差 (web buildTx.ts と同じ吸収) */
  responseKey: "swapTransaction" | "transaction" | "transactions";
}

export function txBuildRequestFor(
  route: SolanaRoute,
  user: string,
  amount: string
): TxBuildRequest {
  switch (route.kind) {
    case "swap_earn_deposit":
      return {
        url: "/protocols/swap-earn/deposit-tx",
        payload: { user, shareMint: route.shareMint, amount, slippageBps: SWAP_EARN_SLIPPAGE_BPS },
        responseKey: "swapTransaction",
      };
    case "swap_earn_withdraw":
      return {
        url: "/protocols/swap-earn/withdraw-tx",
        payload: { user, shareMint: route.shareMint, amount, slippageBps: SWAP_EARN_SLIPPAGE_BPS },
        responseKey: "swapTransaction",
      };
    case "kamino_deposit":
      return { url: "/protocols/kamino/deposit-tx", payload: { user, reserve: route.reserve, amount }, responseKey: "transaction" };
    case "kamino_withdraw":
      return { url: "/protocols/kamino/withdraw-tx", payload: { user, reserve: route.reserve, amount }, responseKey: "transaction" };
    case "kamino_vault_deposit":
      return { url: "/protocols/kamino/vault-deposit-tx", payload: { user, vault: route.vault, amount }, responseKey: "transaction" };
    case "kamino_vault_withdraw":
      return { url: "/protocols/kamino/vault-withdraw-tx", payload: { user, vault: route.vault, amount }, responseKey: "transaction" };
    case "meteora_deposit":
      return { url: "/protocols/meteora/deposit-tx", payload: { user, poolKey: route.poolKey, amount }, responseKey: "transactions" };
    case "meteora_withdraw":
      return { url: "/protocols/meteora/withdraw-tx", payload: { user, position: route.position, amount }, responseKey: "transactions" };
    case "orca_deposit":
      return { url: "/protocols/orca/deposit-tx", payload: { user, poolKey: route.poolKey, amount }, responseKey: "transactions" };
    case "orca_withdraw":
      return { url: "/protocols/orca/withdraw-tx", payload: { user, position: route.position, amount }, responseKey: "transactions" };
    case "save_deposit":
      return { url: "/protocols/save/deposit-tx", payload: { user, reserve: route.reserve, amount }, responseKey: "transactions" };
    case "save_withdraw":
      return { url: "/protocols/save/withdraw-tx", payload: { user, ctokenMint: route.ctokenMint, amount }, responseKey: "transactions" };
    case "exponent_redeem":
      return { url: "/protocols/exponent/redeem-tx", payload: { user, ptMint: route.ptMint, amount }, responseKey: "transaction" };
  }
}

export type PlanTxBuildResult =
  | { ok: true; transactions: AgentPlanUnsignedTransaction[] }
  | { ok: false; statusCode: number; body: Record<string, unknown> };

function pickTxs(
  json: Record<string, unknown>,
  key: TxBuildRequest["responseKey"]
): string[] | null {
  const v = json[key];
  if (key === "transactions") {
    return Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === "string" && t.length > 0)
      ? (v as string[])
      : null;
  }
  return typeof v === "string" && v.length > 0 ? [v] : null;
}

/** "deposit SOL on jito" / 複数本なら "(1/2)" を付ける */
function labelFor(action: ActionSpec, index: number, total: number): string {
  const base = `${action.action_type}${action.asset ? ` ${action.asset}` : ""} on ${action.protocol}`;
  return total > 1 ? `${base} (${index + 1}/${total})` : base;
}

/**
 * route の tx builder を in-process で叩き、unsigned tx を index 順に返す。
 * `action.amount` は呼び手が §4.5 検証済みであること。
 */
export async function buildPlanTransactions(
  app: Pick<FastifyInstance, "inject">,
  route: SolanaRoute,
  action: ActionSpec & { amount: string }
): Promise<PlanTxBuildResult> {
  const req = txBuildRequestFor(route, action.wallet_id, action.amount);
  let statusCode: number;
  let json: Record<string, unknown>;
  try {
    const res = await app.inject({ method: "POST", url: req.url, payload: req.payload });
    statusCode = res.statusCode;
    json = (res.json() ?? {}) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      statusCode: 502,
      body: { error: "execute_tx_build_failed", message: (err as Error).message, route: route.kind },
    };
  }
  if (statusCode !== 200) {
    return { ok: false, statusCode, body: { ...json, route: route.kind } };
  }
  const txs = pickTxs(json, req.responseKey);
  if (!txs) {
    return {
      ok: false,
      statusCode: 502,
      body: { error: "execute_tx_build_failed", message: "Transaction builder returned no transactions", route: route.kind },
    };
  }
  return {
    ok: true,
    transactions: txs.map((tx_base64, index) => ({
      index,
      label: labelFor(action, index, txs.length),
      tx_base64,
    })),
  };
}
