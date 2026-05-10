/**
 * Seasonals BFF — REST server (CLAUDE.md §1 / §10 task #5)
 *
 * 現状 (最小 stub):
 *   全 endpoint が `@workspace/lib/__fixtures__` の値を verbatim で返す。
 *   Postgres / Helius / Pyth は別 task で段階的に追加 (本層は wire のみ)。
 *
 * 規約:
 *   - 型は `@workspace/lib/types` を import (canonical 化、§32.2 same source of truth)
 *   - amount は smallest unit string のままレスポンス (§4.5、parse しない)
 *   - Mobile artifact と URL path / response shape を 1:1 で固定
 *
 * 拡張ポイント:
 *   - oracle 連携 (§4.6) を入れる時は services/oracle.ts を新設
 *   - Postgres を入れる時は services/db.ts + repository pattern
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  fixtureUnifiedTimeEvents,
  fixturePositions,
  fixtureAgentPlans,
  fixtureApprovalTokens,
  fixtureUserPolicyDefault,
  fixtureWallets,
  fixtureProtocols,
  KNOWN_PROTOCOL_MINTS,
} from "@workspace/lib/__fixtures__";
import {
  AgentPlanStatus,
  type AgentPlan,
  type Position,
} from "@workspace/lib/types";
import { getRegistry } from "@workspace/lib/adapters";

import { fetchAssetsByOwner, type HeliusAsset } from "./clients/helius";

// ─────────────────────────────────────────────────────────────────────────────
// Solana 接続 (Devnet) — approve endpoint で memo tx を構築するため
// ─────────────────────────────────────────────────────────────────────────────

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

let cachedConnection: Connection | null = null;
function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(SOLANA_RPC_URL, "confirmed");
  }
  return cachedConnection;
}

/**
 * 指定 wallet (feePayer) を signer とする Memo Program transaction を構築。
 * memo に "Seasonals approve <plan_id> @<timestamp>" を書き込む。
 * 成功すると base64 serialized tx を返す。
 *
 * NOTE: 実 production では §11.7 simulate_action で構築した bundle (lending /
 * staking / etc. の実 instruction) をここに置換する。本実装は MWA round-trip
 * を end-to-end で検証するための stub。
 */
async function buildMemoTransaction(
  feePayer: string,
  planId: string
): Promise<string> {
  const conn = getConnection();
  const { blockhash } = await conn.getLatestBlockhash();
  const memoText = `Seasonals approve ${planId} @${new Date().toISOString()}`;
  const ix = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memoText, "utf-8"),
  });
  const tx = new Transaction({
    feePayer: new PublicKey(feePayer),
    recentBlockhash: blockhash,
  }).add(ix);
  // signer なしで serialize (mobile 側で MWA 経由で sign される)
  const serialized = tx.serialize({ requireAllSignatures: false });
  return Buffer.from(serialized).toString("base64");
}

/**
 * Phase 8.1: Helius DAS asset 配列を Position[] に正規化する。
 * - NFT / cNFT は skip (interface !== "FungibleToken")
 * - balance=0 はスキップ
 * - KNOWN_PROTOCOL_MINTS に hit すれば protocol_id / category / symbol を上書き
 * - 未知 mint は protocol_id="wallet_holding" + category=Other + metadata symbol
 * - 価格情報は token_info.price_info.price_per_token (float) を 8 decimals string に
 *
 * @see CLAUDE.md §11.3 Position、§4.5 数値表現規約 (string-only)
 */
function mapAssetsToPositions(
  assets: HeliusAsset[],
  walletAddress: string
): Position[] {
  const out: Position[] = [];
  const now = new Date().toISOString();
  for (const asset of assets) {
    if (asset.interface !== "FungibleToken") continue;
    const balance = asset.token_info?.balance;
    if (!balance || balance === "0") continue;

    const known = KNOWN_PROTOCOL_MINTS[asset.id];
    const decimals = known?.decimals ?? asset.token_info?.decimals ?? 0;
    const symbol =
      known?.asset_symbol ??
      asset.token_info?.symbol ??
      asset.content?.metadata?.symbol ??
      asset.id.slice(0, 4);
    const priceFloat = asset.token_info?.price_info?.price_per_token;
    const unitPriceUsd =
      typeof priceFloat === "number" && Number.isFinite(priceFloat)
        ? priceFloat.toFixed(8)
        : "0.00000000";

    out.push({
      position_id: `helius_${walletAddress}_${asset.id}`,
      wallet_id: walletAddress,
      protocol_id: known?.protocol_id ?? "wallet_holding",
      asset_symbol: symbol,
      principal_amount: balance,
      current_amount: balance,
      accrued_yield_amount: "0",
      unit_price_usd: unitPriceUsd,
      unit_price_sol: "0.00000000",
      deposited_at: now,
      maturity_at: null,
      unlock_at: null,
      health_factor: null,
      auto_roll_rule: null,
      risk_score: 0.5,
      raw_state: {
        mint: asset.id,
        source: "helius_das",
        decimals,
        helius_interface: asset.interface,
      },
    });
  }
  return out;
}

export interface ServerOptions {
  /** Fastify logger config (test では false にして noise を抑制) */
  logger?: boolean;
}

/**
 * Fastify instance を作成。テストは `fastify.inject()` で本関数の戻り値を使う。
 * 本番は src/index.ts が `app.listen({ port })` で実起動する。
 */
export async function buildServer(
  opts: ServerOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, {
    // dev は any origin で OK (Mobile emulator は IP/host 多様)
    origin: true,
  });

  // ── health ────────────────────────────────────────────────────────────
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  // ── time events / positions / wallets / protocols / user policy ──────
  app.get("/time-events", async () => fixtureUnifiedTimeEvents);

  /**
   * Phase 8.1: /positions?wallet=<base58 address> で Helius DAS から
   * 実 mainnet 保有を取得。wallet 未指定なら従来通り fixture を返す。
   */
  app.get<{ Querystring: { wallet?: string } }>(
    "/positions",
    async (req, reply) => {
      const wallet = req.query?.wallet?.trim();
      if (!wallet) return fixturePositions;

      // 簡易 base58 validation (44 chars max、空白なし)。詳細は @solana/web3.js
      // PublicKey の方が確実だが BFF deps を増やしたくないので長さで guard。
      if (wallet.length < 32 || wallet.length > 44 || /\s/.test(wallet)) {
        reply.code(400);
        return { error: "invalid_wallet_address", wallet };
      }

      try {
        const assets = await fetchAssetsByOwner(wallet);
        return mapAssetsToPositions(assets, wallet);
      } catch (err) {
        req.log.error(
          { err: (err as Error).message, wallet },
          "helius fetch failed"
        );
        reply.code(502);
        return {
          error: "helius_fetch_failed",
          message: (err as Error).message,
        };
      }
    }
  );

  app.get("/wallets", async () => fixtureWallets);
  app.get("/protocols", async () => fixtureProtocols);
  app.get("/user-policy", async () => fixtureUserPolicyDefault);

  // ── agent plans (list + read + approve/reject) ───────────────────────
  app.get("/agent-plans", async () => fixtureAgentPlans);

  app.get<{ Params: { planId: string } }>(
    "/agent-plans/:planId",
    async (req, reply) => {
      const { planId } = req.params;
      const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      return found;
    }
  );

  app.post<{
    Params: { planId: string };
    Body: { fee_payer?: string };
  }>("/agent-plans/:planId/approve", async (req, reply) => {
    const { planId } = req.params;
    const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
    if (!found) {
      reply.code(404);
      return { error: "agent_plan_not_found", plan_id: planId };
    }
    if (
      found.status !== AgentPlanStatus.Simulated &&
      found.status !== AgentPlanStatus.PendingUser
    ) {
      reply.code(409);
      return {
        error: "invalid_status_transition",
        current: found.status,
        target: AgentPlanStatus.Approved,
      };
    }
    const next: AgentPlan & { tx?: string } = {
      ...found,
      status: AgentPlanStatus.Approved,
      updated_at: new Date().toISOString(),
    };
    // fee_payer が渡された場合、Devnet RPC から blockhash 取得 + memo tx を構築。
    // fee_payer 不在 / Devnet RPC 失敗時は plan のみ返す (mobile 側で sign skip)。
    const feePayer = req.body?.fee_payer;
    if (feePayer && typeof feePayer === "string" && feePayer.length > 0) {
      try {
        next.tx = await buildMemoTransaction(feePayer, planId);
      } catch (err) {
        // Devnet RPC が落ちている等。tx field を欠落させるだけで approve 自体は成功扱い
        req.log.warn(
          { err: (err as Error).message },
          "memo tx build failed"
        );
      }
    }
    return next;
  });

  app.post<{ Params: { planId: string }; Body: { reason?: string } }>(
    "/agent-plans/:planId/reject",
    async (req, reply) => {
      const { planId } = req.params;
      const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      const next: AgentPlan = {
        ...found,
        status: AgentPlanStatus.Rejected,
        updated_at: new Date().toISOString(),
      };
      return next;
    }
  );

  // ── adapter-driven endpoints (CLAUDE.md §13 / §26) ───────────────────

  /** Kamino reserves 一覧 (UI の "explore lending" で使う候補) */
  app.get("/protocols/kamino/reserves", async () => {
    const registry = getRegistry();
    const adapter = registry.getLending("kamino");
    if (!adapter) return { reserves: [] };
    return {
      reserves: await adapter.fetchReserves({
        wallet_address: "stub",
        chain: "solana:devnet",
      }),
    };
  });

  /** Jupiter quote (input → output の swap route preview) */
  app.post<{
    Body: {
      input_mint: string;
      output_mint: string;
      amount: string;
      slippage_bps?: number;
    };
  }>("/protocols/jupiter/quote", async (req, reply) => {
    const { input_mint, output_mint, amount, slippage_bps } = req.body ?? {};
    if (!input_mint || !output_mint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["input_mint", "output_mint", "amount"],
      };
    }
    const registry = getRegistry();
    const adapter = registry.getSwap("jupiter");
    if (!adapter) {
      reply.code(404);
      return { error: "swap_adapter_not_registered", protocol_id: "jupiter" };
    }
    return await adapter.quote({
      input_mint,
      output_mint,
      amount,
      slippage_bps: slippage_bps ?? 50,
    });
  });

  /**
   * AgentPlan の simulate 経路 (CLAUDE.md §11.7、ApprovalToken 発行前段階)。
   * adapter から estimated_out / fee / route を取得して SimulationResult として返す。
   */
  app.post<{ Params: { planId: string } }>(
    "/agent-plans/:planId/simulate",
    async (req, reply) => {
      const { planId } = req.params;
      const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      const action = found.selected_action;
      if (!action) {
        reply.code(400);
        return { error: "selected_action_required" };
      }

      const registry = getRegistry();
      const lendingAdapter = registry.getLending(action.protocol);
      const swapAdapter = action.to_protocol
        ? registry.getSwap(action.to_protocol)
        : undefined;

      const ctx = {
        wallet_address: "stub",
        chain: "solana:devnet" as const,
      };

      // protocol が lending adapter を持つなら simulate
      let estimated_out = "0";
      let estimated_fee = "0";
      let slippage_bps: number | undefined;
      const meta: Record<string, unknown> = {};

      if (lendingAdapter) {
        const sim = await lendingAdapter.simulate(ctx, action);
        estimated_out = sim.estimated_out;
        estimated_fee = sim.estimated_fee;
        slippage_bps = sim.slippage_bps;
        Object.assign(meta, sim.metadata ?? {});
      }
      // rotate (to_protocol あり) で swap adapter があれば quote 取得して route を載せる
      if (swapAdapter && action.to_protocol === "jupiter") {
        // input/output mints は本来 protocol 固有の解決が必要。stub では USDC ↔ SOL。
        const quote = await swapAdapter.quote({
          input_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          output_mint: "So11111111111111111111111111111111111111112",
          amount: action.amount ?? "1000000",
          slippage_bps: slippage_bps ?? 50,
        });
        Object.assign(meta, { jupiter_quote: quote });
      }

      const sim = {
        simulation_id: `sim_${planId}_${Date.now()}`,
        estimated_out,
        estimated_fee,
        slippage_bps,
        bundle_hash: `0x${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}…`,
        oracle: {
          primary: "pyth" as const,
          primary_age_seconds: Math.floor(Math.random() * 10),
          divergence_pct: 0.3,
          warnings: [] as string[],
        },
        metadata: meta,
      };
      return { plan_id: planId, simulation: sim };
    }
  );

  // ── approval tokens ──────────────────────────────────────────────────
  app.get<{ Params: { tokenId: string } }>(
    "/approval-tokens/:tokenId",
    async (req, reply) => {
      const { tokenId } = req.params;
      const found = fixtureApprovalTokens.find((t) => t.token_id === tokenId);
      if (!found) {
        reply.code(404);
        return { error: "approval_token_not_found", token_id: tokenId };
      }
      return found;
    }
  );

  // ── push tokens (no-op mock; 本実装は §17 / §25 で Redis + Postgres) ───
  app.post<{ Body: { token: string; device_id?: string } }>(
    "/push-tokens",
    async (req, reply) => {
      const body = req.body ?? {};
      if (!body.token || typeof body.token !== "string") {
        reply.code(400);
        return { error: "invalid_push_token" };
      }
      return { registered_at: new Date().toISOString() };
    }
  );

  return app;
}
