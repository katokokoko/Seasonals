/**
 * /admin/* routes — 運用者向けの読み取り (B1: Helius 使用量の計測)
 *
 * - GET /admin/helius-usage  上流へ出た Helius request の件数 / 概算 credit / 429 回数 /
 *   limiter の最大待ち行列 / cache stats (src/usage.ts の usageSnapshot)
 *
 * 認可は PATCH /user-policy と同じ `isAdminAuthorized` (public-guards.ts):
 * ADMIN_TOKEN 設定時は `x-seasonals-admin-token` 必須、未設定なら dev / test のみ開放
 * (production では閉じる、fail-closed)。不許可は 403 `admin_token_required`。
 *
 * 応答は件数のみで、URL (api-key) / wallet / request body は含まない。
 */
import type { FastifyInstance } from "fastify";
import { adminToken } from "../flags";
import { isAdminAuthorized } from "../public-guards";
import { usageSnapshot, type UsageSnapshot } from "../usage";

export const HELIUS_USAGE_PATH = "/admin/helius-usage";

export interface AdminRouteDeps {
  /** 既定: flags.adminToken() (env ADMIN_TOKEN) */
  adminToken?: () => string | null;
  /** 既定: process.env (isAdminAuthorized の NODE_ENV 判定に使う) */
  env?: () => NodeJS.ProcessEnv;
  snapshot?: () => UsageSnapshot;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps = {}): Promise<void> {
  const token = deps.adminToken ?? (() => adminToken());
  const env = deps.env ?? (() => process.env);
  const snapshot = deps.snapshot ?? usageSnapshot;

  app.get(HELIUS_USAGE_PATH, async (req, reply) => {
    if (!isAdminAuthorized(req, token(), env())) {
      reply.code(403);
      return { error: "admin_token_required" };
    }
    reply.header("cache-control", "no-store");
    return snapshot();
  });
}
