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
import type { CooldownSource, CooldownStateResponse } from "@workspace/lib/types";
import { SKR_STAKING_CLUSTER } from "@workspace/lib/config/skr-staking";
import {
  COOLDOWN_POLL_INTERVAL_MS,
  shouldAcceptCooldownResponse,
} from "@workspace/lib/derive/cooldown-client";

import * as api from "./api";
import { SKR_SOURCE, USE_ONCHAIN } from "./config";
import type { JupiterLendMarketDTO } from "./api";
// 8.78: oracle blocked 中の自動再チェック間隔 (純関数、oracle-gate.test で担保)
import { oracleRefetchInterval } from "@workspace/lib/derive/oracle-gate";

// ─────────────────────────────────────────────────────────────────────────────
// 鮮度 / 保持の定数 (API 効率化計画 Phase A-2 / §4.0)
//
// staleTime は BFF 側の cache TTL に揃える: BFF が同じ値を返す間に client が
// 撃ち直しても credit を使うだけなので、foreground 復帰 / mount の再取得を BFF の
// 更新周期まで間引く。oracle (10s)・SKR (0)・quote (5s)・autonomous (10s) は
// 安全 / 実行系なので対象外 (変えない)。
// ─────────────────────────────────────────────────────────────────────────────

/** wallet 系 (positions / earn-positions / wallet-time-events): BFF wallet snapshot と同じ 60s */
export const WALLET_QUERY_STALE_MS = 60_000;
/**
 * wallet 系の保持期間 (§4.0): 切断・切替で observer が居なくなっても 24h は cache に残し、
 * 再接続で即表示する。AsyncStorage 永続 (maxAge 24h、app/_layout.tsx) と揃える —
 * TanStack の persist は GC 済みの query を復元しないため、gcTime < maxAge だと永続が効かない
 */
export const WALLET_QUERY_GC_MS = 24 * 60 * 60_000;
/** menu-listings / jupiter-lend-markets / kamino-reserves: BFF の共有 cache と同じ 5 分 */
export const CATALOG_QUERY_STALE_MS = 5 * 60_000;
/** prices (表示用途。oracle gate は useOracleStatus の 10s で別): 2 分 */
export const PRICES_QUERY_STALE_MS = 2 * 60_000;

/** address がある時だけ wallet 系の長い gcTime を付ける (fixture / disabled key は既定のまま) */
function walletGc(address: string | null | undefined): { gcTime?: number } {
  return address ? { gcTime: WALLET_QUERY_GC_MS } : {};
}

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
  /** SKR cooldown (docs/skr-r0-implementation.md §3): scope (source / cluster / wallet) ごとに cache を分ける */
  skrStakingState: (source: CooldownSource, cluster: string, address: string) =>
    ["skr-staking", source, cluster, address] as const,
  /** Phase 8.6: Jupiter Lend Earn の 7 markets */
  jupiterLendMarkets: () => ["jupiter-lend-markets"] as const,
  /** Phase 8.14: underlying mint 別の oracle 判定 (§4.6) */
  oracleStatus: (mint: string) => ["oracle-status", mint] as const,
  /** Phase 8.57: symbol 群の実 USD 価格 */
  prices: (symbols: readonly string[]) => ["prices", symbols.join(",")] as const,
  /** Phase 8.58: wallet tx から復元した過去の評価額 */
  portfolioHistory: (address: string, days: number) =>
    ["portfolio-history", address, days] as const,
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

/**
 * fixture の time events (default variant / jest)。onchain build では BFF `/time-events` は
 * fixture しか返さず calendar にも使わないので取得しない (Phase A-1)
 */
export function useTimeEvents(): UseQueryResult<UnifiedTimeEvent[], Error> {
  return useQuery({
    queryKey: queryKeys.timeEvents(),
    queryFn: ({ signal }) => api.getTimeEvents(signal),
    enabled: !USE_ONCHAIN,
  });
}

/**
 * Phase 8.1: address が渡されれば BFF に query param として渡し、Helius DAS
 * 経由で実 mainnet 保有を取得する。呼び出し側 (HomeScreen 等) で onchain
 * variant 判定 + walletStore からの address を解決して渡す責務を持つ。
 * 未指定 (default variant or 未接続) は従来通り fixture/BFF fixture path。
 */
/**
 * 8.93: エラー時のみ 30 秒間隔で自動再試行する refetchInterval。
 * 正常時はポーリングしない (Helius 負荷を増やさない)。api.ts の "throw" 化と
 * セットで、一時的な BFF 断 (tsx watch 再起動等) からアプリ再起動なしで復帰する。
 * useOracleStatus の data-driven interval (8.78) と同型。
 */
export function errorRetryInterval(query: {
  state: { status: string };
}): number | false {
  return query.state.status === "error" ? 30_000 : false;
}

export function usePositions(
  address?: string | null
): UseQueryResult<Position[], Error> {
  const effectiveAddress = address ?? null;
  return useQuery({
    queryKey: queryKeys.positions(effectiveAddress),
    queryFn: ({ signal }) =>
      api.getPositions(effectiveAddress ?? undefined, signal),
    // §4.0: onchain build の未接続 (address 無し) は BFF `/positions` が常に [] なので
    // 撃たない。default variant / jest は従来どおり fixture を取得する
    enabled: Boolean(effectiveAddress) || !USE_ONCHAIN,
    staleTime: WALLET_QUERY_STALE_MS,
    ...walletGc(effectiveAddress),
    refetchInterval: errorRetryInterval, // 8.93
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
    queryFn: ({ signal }) =>
      address
        ? api.getEarnPositions(address, signal)
        : Promise.resolve({ jupiterLend: [], kaminoBestEffort: [] }),
    enabled: Boolean(address),
    staleTime: WALLET_QUERY_STALE_MS,
    ...walletGc(address),
    refetchInterval: errorRetryInterval, // 8.93
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
    queryFn: ({ signal }) => api.getOracleStatus(mint as string, signal),
    enabled: Boolean(mint),
    staleTime: 10_000,
    // 8.78: blocked の間だけ 15 秒間隔で再チェック。瞬断由来の block なら
    // シートを開いたままでも回復して CTA が戻る (従来は開き直すしかなかった)
    refetchInterval: (query) => oracleRefetchInterval(query.state.data),
  });
}

/**
 * §4.0: AsyncStorage 永続 cache (app/_layout.tsx) から復元した wallet time events は
 * JSON を経由するので `triggerAt` が ISO 文字列で戻る。型 (Date) どおりに戻してから渡す。
 * 取得直後の値 (既に Date) は同じ配列をそのまま返す (select の結果を作り直さない)
 */
export function reviveTriggerAt(events: UnifiedTimeEvent[]): UnifiedTimeEvent[] {
  if (events.every((e) => e.triggerAt instanceof Date)) return events;
  return events.map((e) =>
    e.triggerAt instanceof Date
      ? e
      : { ...e, triggerAt: new Date(e.triggerAt as unknown as string) }
  );
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
    queryFn: ({ signal }) =>
      address ? api.getWalletTimeEvents(address, signal) : Promise.resolve([]),
    select: reviveTriggerAt,
    enabled: Boolean(address),
    staleTime: WALLET_QUERY_STALE_MS,
    ...walletGc(address),
  });
}

/**
 * SKR staking cooldown (docs/skr-r0-implementation.md §3「鮮度とcache」)。
 *
 * - 表示中は 5 分 poll、foreground 復帰 / 手動 refresh / 通知 tap でも BFF を読む (staleTime 0)
 * - retry しない (失敗は即 stale 表示。境界 retry は useCooldownBoundaryRetry が別に持つ)
 * - 要求と違う scope の応答、slot が後退した応答、fresh を持っている時の unavailable / unsupported は
 *   cache を上書きせず error にする → 旧値を残したまま stale (取消済み・ready と解釈しない)
 * - SKR_SOURCE は build 時の env。live の失敗を demo / fixture に差し替えない
 */
export function useSkrStakingState(
  address: string | null
): UseQueryResult<CooldownStateResponse, Error> {
  const qc = useQueryClient();
  const source = SKR_SOURCE;
  const cluster = SKR_STAKING_CLUSTER;
  const queryKey = queryKeys.skrStakingState(source, cluster, address ?? "disabled");
  return useQuery({
    queryKey,
    queryFn: async () => {
      if (!address) throw new Error("wallet_required");
      const next = await api.getSkrStakingState(address, source);
      const prev = qc.getQueryData<CooldownStateResponse>(queryKey);
      const verdict = shouldAcceptCooldownResponse(prev, next, {
        source,
        cluster,
        wallet_address: address,
      });
      if (!verdict.ok) {
        throw new api.BffError(`skr_${verdict.reason}`, `skr_${verdict.reason}`);
      }
      return next;
    },
    enabled: Boolean(address),
    staleTime: 0,
    refetchInterval: COOLDOWN_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 0,
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
    queryFn: ({ signal }) => api.getJupiterLendMarkets(signal),
    staleTime: CATALOG_QUERY_STALE_MS,
    // 8.96: cold start の初回失敗が focus まで固まる取りこぼし (8.93 では
    // portfolio 系 4 hook のみ対象だった)。yield 表示がこの query 依存
    refetchInterval: errorRetryInterval,
  });
}

/**
 * Phase 8.57: oracle 由来の実 USD 価格 (native SOL 等、DAS に価格が無い asset 用)。
 * 価格は動くので短めの staleTime。取得失敗は空 map で degrade する。
 */
export function usePrices(
  symbols: readonly string[] = PRICED_SYMBOLS
): UseQueryResult<Record<string, string>, Error> {
  const key = [...symbols].sort();
  return useQuery({
    queryKey: queryKeys.prices(key),
    queryFn: ({ signal }) => api.getPrices(key, signal),
    staleTime: PRICES_QUERY_STALE_MS,
    refetchInterval: errorRetryInterval, // 8.93
  });
}

/** oracle registry にある asset (BFF `/prices` が返せるもの) */
export const PRICED_SYMBOLS = ["SOL", "USDC", "USDT", "JLP"] as const;

/**
 * Phase 8.58: wallet の tx から復元した過去の評価額。address が無い
 * (未接続 / default variant) 時は query 自体を disable する。
 */
export function usePortfolioHistory(
  address: string | null | undefined,
  days: number
): UseQueryResult<api.PortfolioHistoryDTO, Error> {
  return useQuery({
    queryKey: queryKeys.portfolioHistory(address ?? "", days),
    queryFn: ({ signal }) => api.getPortfolioHistory(address!, days, signal),
    enabled: Boolean(address),
    staleTime: 5 * 60_000,
    // 8.83: range (days) 切替時、新 key の取得中も旧 range のチャートを
    // 表示し続ける (疎な localSeries / brewing への flash を出さない)。
    // §4.0: ただし **同じ wallet の range 切替に限る**。keepPreviousData は wallet 切替でも
    // 前の key の値を出すので、別 wallet のチャートが新 wallet の取得中に見えていた
    placeholderData: (prev, prevQuery) =>
      address && prevQuery?.queryKey[1] === address ? prev : undefined,
    // 8.83: 永続キャッシュ (app/_layout.tsx の PersistQueryClientProvider) の
    // 対象なので、gcTime は maxAge (24h) より長くしておく — TanStack の
    // persist は gc された query を復元しないため
    gcTime: WALLET_QUERY_GC_MS,
    refetchInterval: errorRetryInterval, // 8.93
  });
}

/** AgentPlan の一覧を取得 (Plans tab で使用) */
export function useAgentPlans(): UseQueryResult<AgentPlan[], Error> {
  return useQuery({
    queryKey: queryKeys.agentPlans(),
    queryFn: ({ signal }) => api.getAgentPlans(signal),
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
    queryFn: ({ signal }) => {
      if (!planId) {
        // enabled=false で本来呼ばれないが、型上 planId: string が必須なため guard
        throw new Error("agent_plan_id_missing");
      }
      return api.getAgentPlan(planId, signal);
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
    queryFn: ({ signal }) => {
      if (!tokenId) {
        throw new Error("approval_token_id_missing");
      }
      return api.getApprovalToken(tokenId, signal);
    },
    enabled: tokenId !== null,
  });
}

export function useUserPolicy(): UseQueryResult<UserPolicy, Error> {
  return useQuery({
    queryKey: queryKeys.userPolicy(),
    queryFn: ({ signal }) => api.getUserPolicy(signal),
  });
}

export function useWallets(): UseQueryResult<Wallet[], Error> {
  return useQuery({
    queryKey: queryKeys.wallets(),
    queryFn: ({ signal }) => api.getWallets(signal),
  });
}

export function useProtocols(): UseQueryResult<Protocol[], Error> {
  return useQuery({
    queryKey: queryKeys.protocols(),
    queryFn: ({ signal }) => api.getProtocols(signal),
    // registry は build / deploy 単位でしか変わらない (Phase A-1)
    staleTime: Infinity,
  });
}

/** Menu drawer の display catalog (TVL / APY / asset / icon_color を含む) */
export function useMenuListings(): UseQueryResult<ProtocolMenuEntry[], Error> {
  return useQuery({
    queryKey: queryKeys.menuListings(),
    queryFn: ({ signal }) => api.getMenuListings(signal),
    staleTime: CATALOG_QUERY_STALE_MS,
    refetchInterval: errorRetryInterval, // 8.96: cold start 初回失敗の自己回復
  });
}

// ─── Adapter-driven (Kamino / Jupiter) ───────────────────────────────────────

/**
 * Kamino reserve metadata。`enabled: false` で取得しない (ActionModal は Kamino の
 * action を開いた時だけ必要 — 他 protocol の review で毎回撃たない、Phase A-1)
 */
export function useKaminoReserves(
  options: { enabled?: boolean } = {}
): UseQueryResult<api.KaminoReserveSummary[], Error> {
  return useQuery({
    queryKey: queryKeys.kaminoReserves(),
    queryFn: ({ signal }) => api.getKaminoReserves(signal),
    enabled: options.enabled ?? true,
    // reserve metadata は短時間で大きく変わらない: BFF の共有 cache と同じ 5 分
    staleTime: CATALOG_QUERY_STALE_MS,
    refetchInterval: errorRetryInterval, // 8.96: cold start 初回失敗の自己回復
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
      // result は AgentPlan + approval_token。cache には token を含めず plan の核のみ
      // 書き込む (短命の token を plan cache に残さない。表示は mutation の data から)
      const { approval_token: _token, ...plan } = result;
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
    queryFn: ({ signal }) => api.getAutonomousStatus(signal),
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
    queryFn: ({ signal }) => api.getAutonomousLog(signal),
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
