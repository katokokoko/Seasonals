/**
 * public-guards — 公開 BFF の入口で使う小さな guard 群
 * (docs/external-release-api-handling.md §3.3、CLAUDE.md §4 fail-closed)。
 *
 * - wallet の base58 検証 (不正値で Helius credit を燃やさない)
 * - plans-only サーバの 409 body (Ethereum 側 `ethereum/execute.ts` と同じ文言)
 * - rate limit の key (どの header を信じるか)
 * - 単一 tenant の管理 route の共有トークン照合
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { isSolanaAddress } from "@workspace/lib/config/chains";

/** Solana wallet address (base58 32..44 文字、前後空白は許容) か */
export function isWalletAddress(v: unknown): v is string {
  return typeof v === "string" && isSolanaAddress(v.trim());
}

/**
 * `SOLANA_EXECUTION_TARGET=disabled` の時に tx を組む / 送る route が返す body (HTTP 409)。
 * 文言は Ethereum の plans-only (`ethereum/execute.ts` assertForkEndpoint) と揃える。
 */
export const EXECUTION_DISABLED = {
  error: "action_not_available",
  message: "Execution is disabled: this server is configured for plans only.",
} as const;

export const PROXY_KEY_HEADER = "x-seasonals-proxy-key";
export const PROXY_CLIENT_IP_HEADER = "x-seasonals-client-ip";
export const ADMIN_TOKEN_HEADER = "x-seasonals-admin-token";

/** 共有鍵の照合。長さ違いは即 false、同じ長さなら constant-time (timing で鍵を推測させない) */
function safeEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function headerString(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * rate limit の key = 実 client の IP。
 *
 * 1. Cloudflare Pages Function proxy: `x-seasonals-proxy-key` が BFF_PROXY_SECRET と
 *    一致した時だけ、proxy が付けた `x-seasonals-client-ip` を信じる (web 経由の全員が
 *    proxy の 1 IP に潰れないように)
 * 2. Fly の edge が付ける `fly-client-ip` (APK からの直アクセス)
 * 3. socket の `req.ip`
 *
 * Fastify の `trustProxy` は有効にしない / `x-forwarded-for` は読まない
 * (client が自由に偽装でき、limit を回避できるため)。
 */
export function rateLimitKey(req: FastifyRequest, secret: string | null): string {
  if (secret !== null && safeEqual(req.headers[PROXY_KEY_HEADER], secret)) {
    const clientIp = headerString(req, PROXY_CLIENT_IP_HEADER);
    if (clientIp) return clientIp;
  }
  const flyIp = headerString(req, "fly-client-ip");
  if (flyIp) return flyIp;
  return req.ip;
}

/**
 * 管理 route (PATCH /user-policy、/autonomous/kill|resume) の認可。
 *
 * - token 設定時: `x-seasonals-admin-token` を constant-time で照合 (長さ違いは即 false)
 * - token 未設定: dev / test は開放 (従来どおり)。**production では閉じる** —
 *   ADMIN_TOKEN を置き忘れた公開 BFF で誰でも policy を書き換えられないように (fail-closed)
 */
export function isAdminAuthorized(
  req: FastifyRequest,
  token: string | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (token === null) return env.NODE_ENV !== "production";
  return safeEqual(req.headers[ADMIN_TOKEN_HEADER], token);
}
