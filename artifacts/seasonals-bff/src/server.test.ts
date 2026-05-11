/**
 * BFF integration tests — Fastify inject() で各 endpoint を直接叩く
 *
 * test 範囲: status code、response shape、fixture との一致、status transition guard
 *
 * §32.2 整合性チェック「same source of truth」を担保する: 本テストの response shape は
 * Mobile artifact が `services/api.ts` で消費する shape と同一であることを fixture
 * 経由で確認する。
 */

import type { FastifyInstance } from "fastify";

import {
  fixtureUnifiedTimeEvents,
  fixturePositions,
  fixtureAgentPlans,
  fixtureApprovalTokens,
  fixtureUserPolicyDefault,
  fixtureWallets,
  fixtureProtocols,
} from "@workspace/lib/__fixtures__";
import { TIME_EVENT_CATEGORIES } from "@workspace/lib/types";

import { buildServer } from "./server";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildServer({ logger: false });
});

afterEach(async () => {
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// health
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("status=ok を返す", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// list endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /time-events", () => {
  // Phase 8.4: production cleanup — fixture は返さず空配列。wallet 接続済の
  // 接続済 wallet からの履歴は別途 /time-events/wallet?wallet=<addr> 経由。
  it("returns an empty array (Phase 8.4: no fixture in production)", async () => {
    const res = await app.inject({ method: "GET", url: "/time-events" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ category: string; id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });
});

describe("GET /positions", () => {
  // Phase 8.4: production cleanup — wallet 無指定なら []。
  // wallet 指定時は Helius DAS 経由で実 positions を返す path に行く。
  it("returns an empty array when no wallet query is provided", async () => {
    const res = await app.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<unknown>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });
});

describe("GET /wallets", () => {
  it("fixture の 3 件を返す", async () => {
    const res = await app.inject({ method: "GET", url: "/wallets" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(fixtureWallets.length);
  });
});

describe("GET /protocols", () => {
  it("fixture の protocols (Tier S/A 含む)", async () => {
    const res = await app.inject({ method: "GET", url: "/protocols" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ trust_level: string }>;
    const trustLevels = new Set(body.map((p) => p.trust_level));
    expect(trustLevels.has("S")).toBe(true);
    expect(trustLevels.has("A")).toBe(true);
  });
});

describe("GET /user-policy", () => {
  it("default policy (approval_mode=request_per_action, max_tx_amount=null)", async () => {
    const res = await app.inject({ method: "GET", url: "/user-policy" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as typeof fixtureUserPolicyDefault;
    expect(body.approval_mode).toBe("request_per_action");
    expect(body.max_tx_amount).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agent plans
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /agent-plans/:planId", () => {
  it("plan_002 (simulated) を返す", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent-plans/plan_002",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plan_id: "plan_002",
      status: "simulated",
    });
  });

  it("存在しない plan_id は 404 + agent_plan_not_found", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent-plans/plan_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "agent_plan_not_found" });
  });
});

describe("POST /agent-plans/:planId/approve", () => {
  it("simulated plan を approve すると status=approved を返す", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_002/approve",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plan_id: string; status: string };
    expect(body.plan_id).toBe("plan_002");
    expect(body.status).toBe("approved");
  });

  it("draft 状態の plan は 409 + invalid_status_transition", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_001/approve",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "invalid_status_transition",
      current: "draft",
    });
  });

  it("存在しない plan は 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_x/approve",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /agent-plans/:planId/reject", () => {
  it("status=rejected を返す", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-plans/plan_002/reject",
      payload: { reason: "user changed mind" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rejected" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// approval tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /approval-tokens/:tokenId", () => {
  it("active token を返す", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approval-tokens/tok_active_001",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token_id: string; consumed_at: string | null };
    expect(body.token_id).toBe("tok_active_001");
    expect(body.consumed_at).toBeNull();
  });

  it("存在しない token は 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approval-tokens/tok_x",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "approval_token_not_found" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// push tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /push-tokens", () => {
  it("有効な token は 200 + registered_at", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/push-tokens",
      payload: { token: "ExponentPushToken[abc]" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { registered_at: string };
    expect(typeof body.registered_at).toBe("string");
  });

  it("空 token は 400 + invalid_push_token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/push-tokens",
      payload: { token: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_push_token" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fixture との shape 整合
// ─────────────────────────────────────────────────────────────────────────────

describe("fixture との shape 一致", () => {
  it("/time-events returns empty array (Phase 8.4: no fixture in production)", async () => {
    const res = await app.inject({ method: "GET", url: "/time-events" });
    expect(res.json()).toEqual([]);
  });

  it("/approval-tokens/:id は fixture と一致", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approval-tokens/tok_active_001",
    });
    expect(res.json()).toEqual(fixtureApprovalTokens[0]);
  });
});
