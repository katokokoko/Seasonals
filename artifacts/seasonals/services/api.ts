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
  fixtureAutonomousStatus,
  fixtureAutonomousLog,
} from "@workspace/lib/__fixtures__";
import type { ProtocolMenuEntry } from "@workspace/lib/types";
import {
  AgentPlanStatus,
  type AgentPlan,
  type ApprovalToken,
  type AutonomousExecutionRecord,
  type AutonomousStatus,
  type EarnPositionsResponse,
  type OracleResult,
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

async function httpPatchJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BFF_BASE_URL}${path}`, {
    method: "PATCH",
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

// Phase 8.30: 自律管制盤の fixture (status / log / kill / resume / policy patch)
async function fxGetAutonomousStatus(): Promise<AutonomousStatus> {
  await nextTick();
  return cloned(fixtureAutonomousStatus);
}

async function fxGetAutonomousLog(): Promise<AutonomousExecutionRecord[]> {
  await nextTick();
  return cloned(fixtureAutonomousLog);
}

async function fxSetAutonomousKilled(killed: boolean): Promise<AutonomousStatus> {
  await nextTick();
  return { ...cloned(fixtureAutonomousStatus), killed };
}

async function fxPatchUserPolicy(
  patch: Partial<UserPolicy>
): Promise<UserPolicy> {
  await nextTick();
  return { ...cloned(fixtureUserPolicyDefault), ...patch };
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
  // Phase 8.15.x: swapEarn / save は意図的に省略 (undefined)。BFF 不達時は
  // MenuDrawer が client 側 mint 解決 (heldSwapEarnPositions 等) に fallback する。
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
 * Phase 8.9: Jupiter Lend withdraw tx (jlToken → underlying)。
 * Mobile 側で MWA で sign → BFF /tx/submit で broadcast。
 */
export async function getJupiterWithdrawTx(input: {
  user: string;
  jlMint: string;
  amount: string;
  slippageBps?: number;
}): Promise<JupiterDepositTxResponse> {
  const res = await fetch(`${BFF_BASE_URL}/protocols/jupiter-lend/withdraw-tx`, {
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
 * Phase 8.15: protocol 汎用 swap-earn deposit tx (underlying → share)。
 * shareMint で BFF が SWAP_EARN_MARKETS を解決するので、protocol ごとの分岐不要。
 * Jupiter Lend を含む全 swap-routable protocol がこの経路に統合される。
 */
export async function getSwapEarnDepositTx(input: {
  user: string;
  shareMint: string;
  amount: string;
  slippageBps?: number;
}): Promise<JupiterDepositTxResponse> {
  const res = await fetch(`${BFF_BASE_URL}/protocols/swap-earn/deposit-tx`, {
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
 * Phase 8.15: protocol 汎用 swap-earn withdraw tx (share → underlying)。
 */
export async function getSwapEarnWithdrawTx(input: {
  user: string;
  shareMint: string;
  amount: string;
  slippageBps?: number;
}): Promise<JupiterDepositTxResponse> {
  const res = await fetch(`${BFF_BASE_URL}/protocols/swap-earn/withdraw-tx`, {
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

/** Phase 8.15b: Kamino Lend の unsigned tx (base64)。swap でなく obligation deposit/withdraw。 */
export interface KaminoTxResponse {
  transaction: string;
  reserve: string;
  market: string;
  underlyingMint: string;
}

async function postKaminoTx<T>(
  path: string,
  input: Record<string, string>
): Promise<T> {
  const res = await fetch(`${BFF_BASE_URL}${path}`, {
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
  return (await res.json()) as T;
}

/** Phase 8.15b: Kamino deposit tx (underlying → reserve、amount = smallest-unit string)。 */
export function getKaminoDepositTx(input: {
  user: string;
  reserve: string;
  amount: string;
}): Promise<KaminoTxResponse> {
  return postKaminoTx<KaminoTxResponse>("/protocols/kamino/deposit-tx", input);
}

/** Phase 8.15b: Kamino withdraw tx。amount は **underlying smallest-unit** (BFF が underlying_decimals で変換 — 8.38 L9 訂正)。 */
export function getKaminoWithdrawTx(input: {
  user: string;
  reserve: string;
  amount: string;
}): Promise<KaminoTxResponse> {
  return postKaminoTx<KaminoTxResponse>("/protocols/kamino/withdraw-tx", input);
}

/** Phase 8.15d: Kamino Earn vault (kVault) の unsigned tx。 */
export interface KaminoVaultTxResponse {
  transaction: string;
  vault: string;
  underlyingMint: string;
}

/** kVault deposit tx (underlying → vault share、amount = underlying smallest-unit)。 */
export function getKaminoVaultDepositTx(input: {
  user: string;
  vault: string;
  amount: string;
}): Promise<KaminoVaultTxResponse> {
  return postKaminoTx<KaminoVaultTxResponse>(
    "/protocols/kamino/vault-deposit-tx",
    input
  );
}

/** kVault withdraw tx (share 建て、amount = 保有 share smallest-unit)。 */
export function getKaminoVaultWithdrawTx(input: {
  user: string;
  vault: string;
  amount: string;
}): Promise<KaminoVaultTxResponse> {
  return postKaminoTx<KaminoVaultTxResponse>(
    "/protocols/kamino/vault-withdraw-tx",
    input
  );
}

/** Phase 8.34: Exponent PT 満期 redeem (wrapper_merge) の unsigned v0 tx。 */
export interface ExponentRedeemTxResponse {
  transaction: string;
  ptMint: string;
  underlyingMint: string;
}

/** Exponent PT redeem tx (amount = PT smallest-unit string、満期後のみ 200)。 */
export function getExponentRedeemTx(input: {
  user: string;
  ptMint: string;
  amount: string;
}): Promise<ExponentRedeemTxResponse> {
  return postKaminoTx<ExponentRedeemTxResponse>(
    "/protocols/exponent/redeem-tx",
    input
  );
}

/**
 * Phase 8.17: Meteora DLMM LP。deposit の tx は position ephemeral の部分署名済み
 * (user 署名スロットのみ空 — MWA sign-only で保持される)。
 */
export interface MeteoraTxResponse {
  transactions: string[];
  position?: string;
  bps?: number;
  poolAddress: string;
}

/** Meteora single-sided deposit txns (amount = deposit token smallest-unit)。 */
export function getMeteoraDepositTxns(input: {
  user: string;
  poolKey: string;
  amount: string;
}): Promise<MeteoraTxResponse> {
  return postKaminoTx<MeteoraTxResponse>("/protocols/meteora/deposit-tx", input);
}

/** Meteora withdraw txns (amount = deposit token 建て smallest、BFF が bps 換算)。 */
export function getMeteoraWithdrawTxns(input: {
  user: string;
  position: string;
  amount: string;
}): Promise<MeteoraTxResponse> {
  return postKaminoTx<MeteoraTxResponse>("/protocols/meteora/withdraw-tx", input);
}

/**
 * Phase 8.18: Orca Whirlpools full-range LP (zap-in)。deposit は 2 tx:
 * [swap (user 単独), open+increase (position mint ephemeral の部分署名済み —
 * user 署名スロットのみ空、MWA sign-only で保持される)]。
 */
export interface OrcaTxResponse {
  transactions: string[];
  /** deposit 時のみ: position mint (NFT) pubkey */
  position?: string;
  bps?: number;
  poolAddress: string;
}

/** Orca zap-in deposit txns (amount = deposit token smallest-unit、半分 swap)。 */
export function getOrcaDepositTxns(input: {
  user: string;
  poolKey: string;
  amount: string;
}): Promise<OrcaTxResponse> {
  return postKaminoTx<OrcaTxResponse>("/protocols/orca/deposit-tx", input);
}

/** Orca withdraw txns (amount = deposit token 建て smallest、BFF が bps 換算)。 */
export function getOrcaWithdrawTxns(input: {
  user: string;
  position: string;
  amount: string;
}): Promise<OrcaTxResponse> {
  return postKaminoTx<OrcaTxResponse>("/protocols/orca/withdraw-tx", input);
}

/**
 * Phase 8.15c: Save (旧 Solend) の unsigned v0 tx 群 (base64[])。
 * 複数 tx は MWA 一括署名 → 順次 submit する (ATA 準備 + 本体等)。
 */
export interface SaveTxResponse {
  transactions: string[];
  reserve: string;
  ctokenMint: string;
  underlyingMint: string;
}

async function postSaveTx(
  path: string,
  input: Record<string, string>
): Promise<SaveTxResponse> {
  const res = await fetch(`${BFF_BASE_URL}${path}`, {
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
  return (await res.json()) as SaveTxResponse;
}

/** Save deposit txns (underlying → cToken、amount = underlying smallest-unit string)。 */
export function getSaveDepositTxns(input: {
  user: string;
  reserve: string;
  amount: string;
}): Promise<SaveTxResponse> {
  return postSaveTx("/protocols/save/deposit-tx", input);
}

/** Save withdraw (redeem) txns (cToken → underlying、amount = cToken smallest-unit string)。 */
export function getSaveWithdrawTxns(input: {
  user: string;
  ctokenMint: string;
  amount: string;
}): Promise<SaveTxResponse> {
  return postSaveTx("/protocols/save/withdraw-tx", input);
}

/**
 * Phase 8.14 §4.6: underlying mint の実 oracle 判定 (Pyth→Switchboard)。
 * ActionModal が deposit/withdraw review 時に引いて WarningArea 表示 / CTA gate に使う。
 * test 環境では network を呼ばず安全側の ok を返す (fixture path)。
 */
export async function getOracleStatus(mint: string): Promise<OracleResult> {
  if (IS_TEST_ENV) {
    return {
      asset_symbol: "TEST",
      status: "ok",
      primary: "pyth",
      price_usd: null,
      pyth: { available: true, price_usd: null, age_seconds: 0 },
      switchboard: { available: false, price_usd: null, age_seconds: null },
      divergence_pct: null,
      warnings: [],
      block_reason: null,
    };
  }
  return httpGetJson<OracleResult>(`/oracle/status?mint=${encodeURIComponent(mint)}`);
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

/**
 * Phase 8.30: 自律管制盤 — UserPolicy を PATCH で永続更新 (§6.4 editable フィールド)。
 * §4.5: max_tx_amount / min_tvl は USD string のまま渡す (呼び出し側で検証済み)。
 */
export async function patchUserPolicy(
  patch: Partial<UserPolicy>
): Promise<UserPolicy> {
  return tryHttpThenFixture(
    () => httpPatchJson<UserPolicy>("/user-policy", patch),
    () => fxPatchUserPolicy(patch),
    "/user-policy"
  );
}

/** Phase 8.30: 自律オプションの現在状態 (armed / daily_count / hard_caps)。 */
export async function getAutonomousStatus(): Promise<AutonomousStatus> {
  return tryHttpThenFixture(
    () => httpGetJson<AutonomousStatus>("/autonomous/status"),
    () => fxGetAutonomousStatus(),
    "/autonomous/status"
  );
}

/** Phase 8.30: 自律実行の監査ログ (newest-first)。 */
export async function getAutonomousLog(): Promise<AutonomousExecutionRecord[]> {
  return tryHttpThenFixture(
    () => httpGetJson<AutonomousExecutionRecord[]>("/autonomous/log"),
    () => fxGetAutonomousLog(),
    "/autonomous/log"
  );
}

/** Phase 8.30: kill switch — 自律実行を即時全停止。返り値は更新後 status。 */
export async function killAutonomous(): Promise<AutonomousStatus> {
  return tryHttpThenFixture(
    () => httpPostJson<AutonomousStatus>("/autonomous/kill"),
    () => fxSetAutonomousKilled(true),
    "/autonomous/kill"
  );
}

/** Phase 8.30: kill 解除 (resume)。返り値は更新後 status。 */
export async function resumeAutonomous(): Promise<AutonomousStatus> {
  return tryHttpThenFixture(
    () => httpPostJson<AutonomousStatus>("/autonomous/resume"),
    () => fxSetAutonomousKilled(false),
    "/autonomous/resume"
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
