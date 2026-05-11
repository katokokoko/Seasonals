/**
 * API client — Mobile から BFF / MCP Server へ通信する唯一のエントリ (CLAUDE.md §5)
 *
 * 二系統の実装を持つ:
 *   - **HTTP path** (production / dev): `BFF_BASE_URL` 経由で fetch
 *   - **fixture path** (test 環境のみ): `IS_TEST_ENV` で switch、`@workspace/lib/__fixtures__`
 *     から in-memory で値を返す。Mobile 既存テストの作り直しを避けるための互換 path。
 *
 * 規約 (CLAUDE.md §5 / §32.2):
 * - 型は `@workspace/lib/types` から import (Mobile 内ローカル定義禁止)
 * - 金融値の string は `numeric.ts` 経由でしか変換しない (本層は素通し)
 * - components から直接 fetch を呼ばない (TanStack Query 経由でのみ呼ぶ)
 *
 * 移行戦略:
 * - 本ファイルは Mobile↔BFF wire の同型を保つ shim 層に過ぎない。Postgres / Helius
 *   等の永続化は BFF 側で完結し、Mobile は変わらず本層しか見ない。
 *
 * @see ./config.ts (BFF_BASE_URL / IS_TEST_ENV の解決)
 * @see artifacts/seasonals-bff/src/server.ts (BFF 側の対応 endpoint)
 */

import {
  fixtureUnifiedTimeEvents,
  fixturePositions,
  fixtureAgentPlans,
  fixtureApprovalTokens,
  fixtureUserPolicyDefault,
  fixtureWallets,
  fixtureProtocols,
  fixtureMenuListings,
} from "@workspace/lib/__fixtures__";
import type { ProtocolMenuEntry } from "@workspace/lib/types";
import {
  AgentPlanStatus,
  type AgentPlan,
  type ApprovalToken,
  type EarnPositionsResponse,
  type Position,
  type Protocol,
  type UnifiedTimeEvent,
  type UnifiedTimeEventDTO,
  type UserPolicy,
  type Wallet,
} from "@workspace/lib/types";

import {
  BFF_BASE_URL,
  IS_TEST_ENV,
  SHOULD_FALLBACK_TO_FIXTURES,
} from "./config";
import { useDevFallbackLog } from "../stores/devFallbackLog";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cloned<T>(value: T): T {
  // Hermes (RN の JS engine) には structuredClone が無いため JSON 経由で deep clone。
  // fixture は plain JSON 互換 (Date / Map / Set 等の特殊オブジェクト無し) なので問題なし。
  return JSON.parse(JSON.stringify(value)) as T;
}

/** BFF からの error response shape (`{ error: string, ... }`) を Error に変換 */
async function bffError(res: Response, fallbackPath: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string") detail = body.error;
  } catch {
    detail = await res.text().catch(() => "");
  }
  const message = detail || `bff_${res.status}: ${fallbackPath}`;
  return new Error(message);
}

async function httpGetJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BFF_BASE_URL}${path}`);
  if (!res.ok) throw await bffError(res, path);
  return (await res.json()) as T;
}

async function httpPostJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BFF_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await bffError(res, path);
  return (await res.json()) as T;
}

/**
 * test / dev / production の path 切替:
 *   - test (`IS_TEST_ENV`): fixture path のみ。HTTP は呼ばない (jest 環境で network 失敗を防ぐ)
 *   - local device APK (`BFF_BASE_URL` が localhost 系): HTTP を試行 → 失敗時に fixture へ fallback
 *     (Seeker から Mac の BFF に届かない場合でも UI が空にならないため)
 *   - production real BFF URL: HTTP のみ。失敗は error として propagate
 */
async function tryHttpThenFixture<T>(
  http: () => Promise<T>,
  fixture: () => Promise<T>,
  route?: string
): Promise<T> {
  if (IS_TEST_ENV) return fixture();
  try {
    return await http();
  } catch (err) {
    if (
      (typeof __DEV__ !== "undefined" && __DEV__) ||
      SHOULD_FALLBACK_TO_FIXTURES
    ) {
      // Phase 5B.3: console.warn は LogBox が persistent toast を出すため使わず、
      // store に最終 fallback を記録するのみ (Settings DEVELOPER row が表示)。
      useDevFallbackLog
        .getState()
        .record(route ?? "(unknown)", (err as Error).message);
      return fixture();
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fixture path (test 環境専用)
//
// IS_TEST_ENV が true の場合のみ呼ばれる。production bundle では Metro の
// dead-code elimination で参照されず、fixture import も tree-shake される想定。
// ─────────────────────────────────────────────────────────────────────────────

async function fxGetTimeEvents(): Promise<UnifiedTimeEvent[]> {
  await nextTick();
  // Phase 8.4: production cleanup — test 環境では従来通り fixture、production
  // (APK で BFF が落ちた fallback path 等) では空配列を返す。fixture event 8 種は
  // golden test (DropletMarker / queries) のために残しているだけで UI 表示は禁止。
  if (!IS_TEST_ENV) return [];
  return cloned(fixtureUnifiedTimeEvents);
}

async function fxGetPositions(): Promise<Position[]> {
  await nextTick();
  // Phase 8.4: production cleanup — test 環境のみ fixture、production は []。
  if (!IS_TEST_ENV) return [];
  return cloned(fixturePositions);
}

async function fxGetAgentPlan(planId: string): Promise<AgentPlan> {
  await nextTick();
  const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
  if (!found) throw new Error(`agent_plan_not_found: ${planId}`);
  return cloned(found);
}

async function fxGetAgentPlans(): Promise<AgentPlan[]> {
  await nextTick();
  return cloned(fixtureAgentPlans);
}

async function fxGetApprovalToken(tokenId: string): Promise<ApprovalToken> {
  await nextTick();
  const found = fixtureApprovalTokens.find((t) => t.token_id === tokenId);
  if (!found) throw new Error(`approval_token_not_found: ${tokenId}`);
  return cloned(found);
}

async function fxGetUserPolicy(): Promise<UserPolicy> {
  await nextTick();
  return cloned(fixtureUserPolicyDefault);
}

async function fxGetWallets(): Promise<Wallet[]> {
  await nextTick();
  return cloned(fixtureWallets);
}

async function fxGetProtocols(): Promise<Protocol[]> {
  await nextTick();
  return cloned(fixtureProtocols);
}

async function fxGetMenuListings(): Promise<ProtocolMenuEntry[]> {
  await nextTick();
  return cloned(fixtureMenuListings);
}

async function fxApproveAgentPlan(planId: string): Promise<AgentPlan> {
  await nextTick();
  const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
  if (!found) throw new Error(`agent_plan_not_found: ${planId}`);
  if (
    found.status !== AgentPlanStatus.Simulated &&
    found.status !== AgentPlanStatus.PendingUser
  ) {
    throw new Error(
      `invalid_status_transition: cannot approve from ${found.status}`
    );
  }
  return cloned({
    ...found,
    status: AgentPlanStatus.Approved,
    updated_at: new Date().toISOString(),
  });
}

async function fxRejectAgentPlan(planId: string): Promise<AgentPlan> {
  await nextTick();
  const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
  if (!found) throw new Error(`agent_plan_not_found: ${planId}`);
  return cloned({
    ...found,
    status: AgentPlanStatus.Rejected,
    updated_at: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public fetchers — IS_TEST_ENV で path 切替
// ─────────────────────────────────────────────────────────────────────────────

export async function getTimeEvents(): Promise<UnifiedTimeEvent[]> {
  return tryHttpThenFixture(
    () => httpGetJson<UnifiedTimeEvent[]>("/time-events"),
    () => fxGetTimeEvents(),
    "/time-events"
  );
}

/**
 * Phase 8.1: walletAddress 指定で BFF が Helius DAS 経由の実 position を返す。
 * 未指定なら従来通り fixture / BFF fixture 経由。
 */
export async function getPositions(
  walletAddress?: string
): Promise<Position[]> {
  const path = walletAddress
    ? `/positions?wallet=${encodeURIComponent(walletAddress)}`
    : "/positions";
  return tryHttpThenFixture(
    () => httpGetJson<Position[]>(path),
    () => fxGetPositions(),
    path
  );
}

/**
 * Phase 8.2: 接続済 wallet の earn positions (Jupiter Lend + Kamino best-effort)。
 * MenuDrawer "Your Positions" section が消費。fixture 未提供なので未接続 / fetch
 * 失敗時は空オブジェクトを返す。
 */
export async function getEarnPositions(
  walletAddress: string
): Promise<EarnPositionsResponse> {
  const path = `/positions/earn?wallet=${encodeURIComponent(walletAddress)}`;
  const empty: EarnPositionsResponse = {
    jupiterLend: [],
    kaminoBestEffort: [],
  };
  return tryHttpThenFixture(
    () => httpGetJson<EarnPositionsResponse>(path),
    async () => empty,
    path
  );
}

/**
 * Phase 8.5: Jupiter Lend に deposit する swap tx を BFF 経由で取得。
 * BFF が Jupiter Swap API を call して serialized versioned tx を返す。
 * Mobile 側で Transaction.from で deserialize → MWA で sign + send。
 */
/**
 * Phase 8.6: Jupiter Lend Earn の 7 markets を BFF 経由で取得。
 * MenuDrawer drill-down で fixture pools の代わりに表示する。
 */
export interface JupiterLendMarketDTO {
  jlMint: string;
  jlSymbol: string;
  jlDecimals: number;
  underlyingMint: string;
  underlyingSymbol: string;
  underlyingDecimals: number;
  underlyingPriceUsd: number;
  supplyRateBps: number;
  rewardsRateBps: number;
  totalRateBps: number;
  tvlUnderlying: string;
}

export async function getJupiterLendMarkets(): Promise<JupiterLendMarketDTO[]> {
  return tryHttpThenFixture(
    () => httpGetJson<JupiterLendMarketDTO[]>("/protocols/jupiter-lend/markets"),
    async () => [],
    "/protocols/jupiter-lend/markets"
  );
}

/**
 * Phase 8.8: MWA で署名済の raw tx (base64) を BFF 経由で mainnet broadcast。
 * Phantom の signAndSend が empty result を返す問題を回避するための
 * sign-only + Helius RPC submit path。
 */
export async function submitSignedTx(
  signedTxBase64: string,
  opts: { skipPreflight?: boolean } = {}
): Promise<{ signature: string }> {
  const res = await fetch(`${BFF_BASE_URL}/tx/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTx: signedTxBase64, ...opts }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(
      body.message ?? body.error ?? `HTTP ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as { signature: string };
}

export interface JupiterDepositTxResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  outAmount: string;
  outputMint: string;
  quote: unknown;
}

export async function getJupiterDepositTx(input: {
  user: string;
  inputMint: string;
  amount: string;
  slippageBps?: number;
}): Promise<JupiterDepositTxResponse> {
  const res = await fetch(`${BFF_BASE_URL}/protocols/jupiter-lend/deposit-tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(
      body.message ?? body.error ?? `HTTP ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as JupiterDepositTxResponse;
}

/**
 * Phase 8.3: 接続済 wallet の tx 履歴から派生する time events を取得。
 * BFF /time-events/wallet が UnifiedTimeEventDTO[] (triggerAt string) で返すので、
 * Mobile 側で Date に復元してから返す。fixture 未提供、未接続 / 失敗時は空配列。
 */
export async function getWalletTimeEvents(
  walletAddress: string
): Promise<UnifiedTimeEvent[]> {
  const path = `/time-events/wallet?wallet=${encodeURIComponent(walletAddress)}`;
  const dtos = await tryHttpThenFixture<UnifiedTimeEventDTO[]>(
    () => httpGetJson<UnifiedTimeEventDTO[]>(path),
    async () => [],
    path
  );
  return dtos.map((d) => ({
    ...d,
    triggerAt: new Date(d.triggerAt),
  }));
}

export async function getAgentPlan(planId: string): Promise<AgentPlan> {
  return tryHttpThenFixture(
    () =>
      httpGetJson<AgentPlan>(`/agent-plans/${encodeURIComponent(planId)}`),
    () => fxGetAgentPlan(planId),
    `/agent-plans/${planId}`
  );
}

export async function getAgentPlans(): Promise<AgentPlan[]> {
  return tryHttpThenFixture(
    () => httpGetJson<AgentPlan[]>("/agent-plans"),
    () => fxGetAgentPlans(),
    "/agent-plans"
  );
}

export async function getApprovalToken(
  tokenId: string
): Promise<ApprovalToken> {
  return tryHttpThenFixture(
    () =>
      httpGetJson<ApprovalToken>(
        `/approval-tokens/${encodeURIComponent(tokenId)}`
      ),
    () => fxGetApprovalToken(tokenId),
    `/approval-tokens/${tokenId}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter-driven endpoints (CLAUDE.md §13 / §26)
// ─────────────────────────────────────────────────────────────────────────────

export interface KaminoReserveSummary {
  reserve_id: string;
  name: string;
  asset_symbol: string;
  lend_apy: number;
  borrow_apy: number;
  utilization: number;
  tvl_usd: string;
}

export async function getKaminoReserves(): Promise<KaminoReserveSummary[]> {
  return tryHttpThenFixture(
    async () => {
      const result = await httpGetJson<{ reserves: KaminoReserveSummary[] }>(
        "/protocols/kamino/reserves"
      );
      return result.reserves;
    },
    async () => {
      const { kaminoAdapter } = await import("@workspace/lib/adapters");
      return kaminoAdapter.fetchReserves({
        wallet_address: "stub",
        chain: "solana:devnet",
      });
    },
    "/protocols/kamino/reserves"
  );
}

export interface JupiterQuoteInput {
  input_mint: string;
  output_mint: string;
  amount: string;
  slippage_bps?: number;
}

export interface JupiterQuoteResult {
  input_mint: string;
  output_mint: string;
  in_amount: string;
  out_amount: string;
  min_out_amount: string;
  slippage_bps: number;
  route: Array<{
    input_mint: string;
    output_mint: string;
    amm_key: string;
    percent: number;
  }>;
  quoted_at: string;
}

export async function postJupiterQuote(
  input: JupiterQuoteInput
): Promise<JupiterQuoteResult> {
  return tryHttpThenFixture(
    () =>
      httpPostJson<JupiterQuoteResult>("/protocols/jupiter/quote", input),
    async () => {
      const { jupiterAdapter } = await import("@workspace/lib/adapters");
      return jupiterAdapter.quote({
        input_mint: input.input_mint,
        output_mint: input.output_mint,
        amount: input.amount,
        slippage_bps: input.slippage_bps ?? 50,
      });
    },
    "/protocols/jupiter/quote"
  );
}

export async function getUserPolicy(): Promise<UserPolicy> {
  return tryHttpThenFixture(
    () => httpGetJson<UserPolicy>("/user-policy"),
    () => fxGetUserPolicy(),
    "/user-policy"
  );
}

export async function getWallets(): Promise<Wallet[]> {
  return tryHttpThenFixture(
    () => httpGetJson<Wallet[]>("/wallets"),
    () => fxGetWallets(),
    "/wallets"
  );
}

export async function getProtocols(): Promise<Protocol[]> {
  return tryHttpThenFixture(
    () => httpGetJson<Protocol[]>("/protocols"),
    () => fxGetProtocols(),
    "/protocols"
  );
}

export async function getMenuListings(): Promise<ProtocolMenuEntry[]> {
  return tryHttpThenFixture(
    () => httpGetJson<ProtocolMenuEntry[]>("/menu-listings"),
    () => fxGetMenuListings(),
    "/menu-listings"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export interface ApproveAgentPlanInput {
  plan_id: string;
  /**
   * 任意。指定があれば BFF 側で Solana Devnet の memo tx (feePayer = この address)
   * を構築し、戻り値の `tx` field に base64 で返す。Mobile はそれを MWA で署名 +
   * broadcast する。
   */
  fee_payer?: string;
}

/** approve mutation の戻り値: AgentPlan + 署名対象 tx (任意) */
export type ApproveAgentPlanResult = AgentPlan & {
  /** base64 serialized Solana transaction (signer 未付加) */
  tx?: string;
};

export interface RejectAgentPlanInput {
  plan_id: string;
  reason?: string;
}

export interface RegisterPushTokenInput {
  /** Expo Push Token (ExponentPushToken[xxx]) */
  token: string;
  /** Mobile / Server で衝突しない device id */
  device_id?: string;
}

export interface RegisterPushTokenResult {
  registered_at: string;
}

export async function postApproveAgentPlan(
  input: ApproveAgentPlanInput
): Promise<ApproveAgentPlanResult> {
  return tryHttpThenFixture(
    () =>
      httpPostJson<ApproveAgentPlanResult>(
        `/agent-plans/${encodeURIComponent(input.plan_id)}/approve`,
        // body に fee_payer を載せる (BFF が memo tx を返す trigger)
        input.fee_payer ? { fee_payer: input.fee_payer } : undefined
      ),
    () => fxApproveAgentPlan(input.plan_id),
    `/agent-plans/${input.plan_id}/approve`
  );
}

export async function postRejectAgentPlan(
  input: RejectAgentPlanInput
): Promise<AgentPlan> {
  return tryHttpThenFixture(
    () =>
      httpPostJson<AgentPlan>(
        `/agent-plans/${encodeURIComponent(input.plan_id)}/reject`,
        { reason: input.reason }
      ),
    () => fxRejectAgentPlan(input.plan_id),
    `/agent-plans/${input.plan_id}/reject`
  );
}

export async function postRegisterPushToken(
  input: RegisterPushTokenInput
): Promise<RegisterPushTokenResult> {
  const fixture = async (): Promise<RegisterPushTokenResult> => {
    await nextTick();
    if (!input.token || typeof input.token !== "string") {
      throw new Error("invalid_push_token");
    }
    return { registered_at: new Date().toISOString() };
  };
  return tryHttpThenFixture(
    () => httpPostJson<RegisterPushTokenResult>("/push-tokens", input),
    fixture,
    "/push-tokens"
  );
}
