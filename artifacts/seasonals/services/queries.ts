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
  AutonomousExecutionRecord,
  AutonomousStatus,
  EarnPositionsResponse,
  OracleResult,
  Position,
  Protocol,
  UnifiedTimeEvent,
  UserPolicy,
  Wallet,
} from "@workspace/lib/types";
import type { ProtocolMenuEntry } from "@workspace/lib/types";

import * as api from "./api";
import type { JupiterLendMarketDTO } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Query keys (cache invalidation 用、文字列直書きを避ける)
// ─────────────────────────────────────────────────────────────────────────────

export const queryKeys = {
  timeEvents: () => ["time-events"] as const,
  /** Phase 8.1: address があれば address 別 cache (onchain variant、wallet 切替で再 fetch) */
  positions: (address?: string | null) =>
    address ? (["positions", address] as const) : (["positions"] as const),
  /** Phase 8.2: earn positions (Jupiter Lend + Kamino)、address 必須 */
  earnPositions: (address: string) => ["earn-positions", address] as const,
  /** Phase 8.3: wallet tx 履歴から派生する time events、address 必須 */
  walletTimeEvents: (address: string) =>
    ["wallet-time-events", address] as const,
  /** Phase 8.6: Jupiter Lend Earn の 7 markets */
  jupiterLendMarkets: () => ["jupiter-lend-markets"] as const,
  /** Phase 8.14: underlying mint 別の oracle 判定 (§4.6) */
  oracleStatus: (mint: string) => ["oracle-status", mint] as const,
  agentPlan: (planId: string) => ["agent-plan", planId] as const,
  agentPlans: () => ["agent-plans"] as const,
  approvalToken: (tokenId: string) => ["approval-token", tokenId] as const,
  userPolicy: () => ["user-policy"] as const,
  /** Phase 8.30: 自律オプションの状態 / 監査ログ */
  autonomousStatus: () => ["autonomous-status"] as const,
  autonomousLog: () => ["autonomous-log"] as const,
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

/**
 * Phase 8.1: address が渡されれば BFF に query param として渡し、Helius DAS
 * 経由で実 mainnet 保有を取得する。呼び出し側 (HomeScreen 等) で onchain
 * variant 判定 + walletStore からの address を解決して渡す責務を持つ。
 * 未指定 (default variant or 未接続) は従来通り fixture/BFF fixture path。
 */
export function usePositions(
  address?: string | null
): UseQueryResult<Position[], Error> {
  const effectiveAddress = address ?? null;
  return useQuery({
    queryKey: queryKeys.positions(effectiveAddress),
    queryFn: () => api.getPositions(effectiveAddress ?? undefined),
  });
}

/**
 * Phase 8.2: address が渡された時のみ Jupiter Lend / Kamino best-effort の
 * earn positions を取得 (default variant / 未接続 ではクエリ自体 disable)。
 */
export function useEarnPositions(
  address: string | null
): UseQueryResult<EarnPositionsResponse, Error> {
  return useQuery({
    queryKey: queryKeys.earnPositions(address ?? "disabled"),
    queryFn: () =>
      address
        ? api.getEarnPositions(address)
        : Promise.resolve({ jupiterLend: [], kaminoBestEffort: [] }),
    enabled: Boolean(address),
  });
}

/**
 * Phase 8.14 §4.6: deposit/withdraw する underlying mint の oracle 判定を取得。
 * ActionModal が review 時に引いて WarningArea 表示 / CTA gate に使う。
 * 価格は変動するため staleTime は短く (10s)。mint=null では無効。
 */
export function useOracleStatus(
  mint: string | null
): UseQueryResult<OracleResult, Error> {
  return useQuery({
    queryKey: queryKeys.oracleStatus(mint ?? "disabled"),
    queryFn: () => api.getOracleStatus(mint as string),
    enabled: Boolean(mint),
    staleTime: 10_000,
  });
}

/**
 * Phase 8.3: address が渡された時のみ wallet tx 履歴から派生する time events
 * を取得 (deposit / withdraw を calendar に表示する用途)。
 */
export function useWalletTimeEvents(
  address: string | null
): UseQueryResult<UnifiedTimeEvent[], Error> {
  return useQuery({
    queryKey: queryKeys.walletTimeEvents(address ?? "disabled"),
    queryFn: () =>
      address ? api.getWalletTimeEvents(address) : Promise.resolve([]),
    enabled: Boolean(address),
  });
}

/**
 * Phase 8.6: Jupiter Lend Earn の 7 markets を取得。MenuDrawer の Jupiter
 * drill-down で fixture pools を上書きする用。
 */
export function useJupiterLendMarkets(): UseQueryResult<
  JupiterLendMarketDTO[],
  Error
> {
  return useQuery({
    queryKey: queryKeys.jupiterLendMarkets(),
    queryFn: api.getJupiterLendMarkets,
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
export function useMenuListings(): UseQueryResult<ProtocolMenuEntry[], Error> {
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.30: 自律管制盤 (status / log / kill-resume / policy 編集)
// ─────────────────────────────────────────────────────────────────────────────

/** 自律オプションの現在状態 (armed / daily_count / hard_caps)。頻繁に変わらないので短め staleTime。 */
export function useAutonomousStatus(): UseQueryResult<AutonomousStatus, Error> {
  return useQuery({
    queryKey: queryKeys.autonomousStatus(),
    queryFn: api.getAutonomousStatus,
    staleTime: 10_000,
  });
}

/** 自律実行の監査ログ (newest-first)。 */
export function useAutonomousLog(): UseQueryResult<
  AutonomousExecutionRecord[],
  Error
> {
  return useQuery({
    queryKey: queryKeys.autonomousLog(),
    queryFn: api.getAutonomousLog,
    staleTime: 10_000,
  });
}

/** kill switch — 停止後の status を cache に反映。 */
export function useKillAutonomous(): UseMutationResult<
  AutonomousStatus,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.killAutonomous(),
    onSuccess: (status) => {
      qc.setQueryData(queryKeys.autonomousStatus(), status);
    },
  });
}

/** kill 解除 (resume) — status を cache に反映。 */
export function useResumeAutonomous(): UseMutationResult<
  AutonomousStatus,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.resumeAutonomous(),
    onSuccess: (status) => {
      qc.setQueryData(queryKeys.autonomousStatus(), status);
    },
  });
}

/**
 * UserPolicy を PATCH で永続更新 (§6.4)。成功で userPolicy cache を更新し、
 * approval_mode 変更が status の enabled 判定に効くため autonomousStatus も invalidate。
 */
export function usePatchUserPolicy(): UseMutationResult<
  UserPolicy,
  Error,
  Partial<UserPolicy>
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserPolicy>) => api.patchUserPolicy(patch),
    onSuccess: (policy) => {
      qc.setQueryData(queryKeys.userPolicy(), policy);
      qc.invalidateQueries({ queryKey: queryKeys.autonomousStatus() });
    },
  });
}
