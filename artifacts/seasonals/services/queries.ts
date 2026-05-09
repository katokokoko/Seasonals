/**
 * Query hooks — server state を取得する唯一の口 (CLAUDE.md §5)
 *
 * 規約:
 * - components / screens から直接 services/api.ts を呼ばない。必ず本層の hook 経由
 * - queryKey は配列形式で `[domain, ...args]` 構成、cache invalidation がしやすい形に
 * - 型は `@workspace/lib/types` から import (Mobile 内ローカル定義禁止)
 *
 * @see CLAUDE.md §5 (server state は TanStack Query 経由)
 * @see CLAUDE.md §11 (Claude Code が新規ファイルを作る時のチェックリスト)
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type {
  AgentPlan,
  ApprovalToken,
  Position,
  Protocol,
  UnifiedTimeEvent,
  UserPolicy,
  Wallet,
} from "@workspace/lib/types";
import type { MenuListing } from "@workspace/lib/__fixtures__";

import * as api from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Query keys (cache invalidation 用、文字列直書きを避ける)
// ─────────────────────────────────────────────────────────────────────────────

export const queryKeys = {
  timeEvents: () => ["time-events"] as const,
  positions: () => ["positions"] as const,
  agentPlan: (planId: string) => ["agent-plan", planId] as const,
  agentPlans: () => ["agent-plans"] as const,
  approvalToken: (tokenId: string) => ["approval-token", tokenId] as const,
  userPolicy: () => ["user-policy"] as const,
  wallets: () => ["wallets"] as const,
  protocols: () => ["protocols"] as const,
  menuListings: () => ["menu-listings"] as const,
  kaminoReserves: () => ["kamino-reserves"] as const,
  jupiterQuote: (input: api.JupiterQuoteInput) =>
    [
      "jupiter-quote",
      input.input_mint,
      input.output_mint,
      input.amount,
      input.slippage_bps ?? 50,
    ] as const,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Query hooks
// ─────────────────────────────────────────────────────────────────────────────

export function useTimeEvents(): UseQueryResult<UnifiedTimeEvent[], Error> {
  return useQuery({
    queryKey: queryKeys.timeEvents(),
    queryFn: api.getTimeEvents,
  });
}

export function usePositions(): UseQueryResult<Position[], Error> {
  return useQuery({
    queryKey: queryKeys.positions(),
    queryFn: api.getPositions,
  });
}

/** AgentPlan の一覧を取得 (Plans tab で使用) */
export function useAgentPlans(): UseQueryResult<AgentPlan[], Error> {
  return useQuery({
    queryKey: queryKeys.agentPlans(),
    queryFn: api.getAgentPlans,
  });
}

/**
 * AgentPlan を plan_id で取得。planId 未確定 (null) の場合は disabled にして
 * 不要 fetch を抑制する。
 */
export function useAgentPlan(
  planId: string | null
): UseQueryResult<AgentPlan, Error> {
  return useQuery({
    queryKey: queryKeys.agentPlan(planId ?? ""),
    queryFn: () => {
      if (!planId) {
        // enabled=false で本来呼ばれないが、型上 planId: string が必須なため guard
        throw new Error("agent_plan_id_missing");
      }
      return api.getAgentPlan(planId);
    },
    enabled: planId !== null,
  });
}

/**
 * ApprovalToken を token_id で取得。tokenId 未確定 (null) は disabled。
 */
export function useApprovalToken(
  tokenId: string | null
): UseQueryResult<ApprovalToken, Error> {
  return useQuery({
    queryKey: queryKeys.approvalToken(tokenId ?? ""),
    queryFn: () => {
      if (!tokenId) {
        throw new Error("approval_token_id_missing");
      }
      return api.getApprovalToken(tokenId);
    },
    enabled: tokenId !== null,
  });
}

export function useUserPolicy(): UseQueryResult<UserPolicy, Error> {
  return useQuery({
    queryKey: queryKeys.userPolicy(),
    queryFn: api.getUserPolicy,
  });
}

export function useWallets(): UseQueryResult<Wallet[], Error> {
  return useQuery({
    queryKey: queryKeys.wallets(),
    queryFn: api.getWallets,
  });
}

export function useProtocols(): UseQueryResult<Protocol[], Error> {
  return useQuery({
    queryKey: queryKeys.protocols(),
    queryFn: api.getProtocols,
  });
}

/** Menu drawer の display catalog (TVL / APY / asset / icon_color を含む) */
export function useMenuListings(): UseQueryResult<MenuListing[], Error> {
  return useQuery({
    queryKey: queryKeys.menuListings(),
    queryFn: api.getMenuListings,
    staleTime: 60_000,
  });
}

// ─── Adapter-driven (Kamino / Jupiter) ───────────────────────────────────────

export function useKaminoReserves(): UseQueryResult<
  api.KaminoReserveSummary[],
  Error
> {
  return useQuery({
    queryKey: queryKeys.kaminoReserves(),
    queryFn: api.getKaminoReserves,
    // reserve metadata は短時間で大きく変わらないため staleTime を長めに
    staleTime: 60_000,
  });
}

/**
 * Jupiter quote を取得 (rotate / swap action の preview 用)。
 * input が null/undefined なら disabled (= 不要 fetch を抑制)。
 */
export function useJupiterQuote(
  input: api.JupiterQuoteInput | null
): UseQueryResult<api.JupiterQuoteResult, Error> {
  return useQuery({
    queryKey: input
      ? queryKeys.jupiterQuote(input)
      : ["jupiter-quote", "disabled"],
    queryFn: () => {
      if (!input) throw new Error("jupiter_quote_input_missing");
      return api.postJupiterQuote(input);
    },
    enabled: input !== null,
    // quote は時々刻々変わるので短め
    staleTime: 5_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation hooks — AgentPlan の approve / reject (§11.7 status 遷移)
//
// onSuccess で対応する agentPlan / 一覧系 cache を invalidate する。
// ─────────────────────────────────────────────────────────────────────────────

export function useApproveAgentPlan(): UseMutationResult<
  api.ApproveAgentPlanResult,
  Error,
  api.ApproveAgentPlanInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.postApproveAgentPlan,
    onSuccess: (result) => {
      // result は AgentPlan + 任意 tx。cache には tx を含めず plan の核のみ書き込む
      // (再 fetch 時に tx は再生成されるため、stale tx を保持しない)
      const { tx: _tx, ...plan } = result;
      qc.setQueryData(queryKeys.agentPlan(plan.plan_id), plan);
    },
  });
}

/** Expo Push Token を BFF に登録 (現状 mock no-op、§5 で実 endpoint に差替) */
export function useRegisterPushToken(): UseMutationResult<
  api.RegisterPushTokenResult,
  Error,
  api.RegisterPushTokenInput
> {
  return useMutation({
    mutationFn: api.postRegisterPushToken,
  });
}

export function useRejectAgentPlan(): UseMutationResult<
  AgentPlan,
  Error,
  api.RejectAgentPlanInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.postRejectAgentPlan,
    onSuccess: (plan) => {
      qc.setQueryData(queryKeys.agentPlan(plan.plan_id), plan);
    },
  });
}
