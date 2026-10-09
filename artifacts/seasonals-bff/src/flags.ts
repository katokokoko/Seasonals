/**
 * flags — 公開 BFF (Fly.io `api.seasonals.cafe`) の env 解釈を 1 か所に集める
 * (docs/external-release-api-handling.md §3.3 / §3.4、CLAUDE.md §4 fail-closed)。
 *
 * すべて純関数で `env` を注入できる (既定は process.env)。テストは env object を
 * 直接渡し、process.env を汚さない。パターンは `ethereum/client.ts` の
 * `executionTarget(env)` と同じ。
 *
 * ## fail-closed の意味
 * 安全側に倒すフラグは「知らない値 = 安全側」。例: `SOLANA_EXECUTION_TARGET=mainet`
 * (typo) は mainnet ではなく disabled として扱う。逆に危険側を開くフラグ
 * (`EXPO_PUSH_ENABLED`) は厳密に `"true"` の時だけ有効。
 *
 * | env                       | 既定              | 意味 |
 * |---------------------------|-------------------|------|
 * | SOLANA_EXECUTION_TARGET   | `mainnet`         | `disabled` (または未知の値) で tx を組む / 送る route を 409 にする (plans-only サーバ) |
 * | CORS_ALLOWED_ORIGINS      | 未設定 = any      | カンマ区切りの origin 許可リスト。web は Pages Function 経由の same-origin なので保険 |
 * | RATE_LIMIT_MAX            | 300               | IP あたり 1 分の上限。`0` 以下で無効 |
 * | ADMIN_TOKEN               | 未設定            | 単一 tenant の管理 route (policy 編集 / kill switch) の共有トークン |
 * | BFF_PROXY_SECRET          | 未設定            | Pages Function → BFF の共有鍵。一致した時だけ `x-seasonals-client-ip` を信じる |
 * | EXPO_PUSH_ENABLED         | off               | `"true"` で push token 登録を受け付ける |
 * | GIT_SHA                   | 未設定            | `/health.version` に出す build の commit |
 * | NODE_ENV=production       | -                 | `assertProductionEnvSafe` が秘密鍵経路の env を拒否する |
 */

/** Solana の実行 (tx build / broadcast) を許すか。未知の値は disabled (fail-closed) */
export type SolanaExecutionTarget = "mainnet" | "disabled";

export function solanaExecutionTarget(
  env: NodeJS.ProcessEnv = process.env
): SolanaExecutionTarget {
  const raw = env.SOLANA_EXECUTION_TARGET?.trim() ?? "";
  if (raw === "" || raw === "mainnet") return "mainnet";
  // `disabled` と、typo を含む知らない値はすべて disabled
  return "disabled";
}

/**
 * @fastify/cors の `origin` に渡す値。未設定 / 空は `true` (any origin、従来どおり。
 * dev の emulator / LAN IP を通すため)。設定時は exact match の許可リスト。
 */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): true | string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (raw === undefined) return true;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : true;
}

export const DEFAULT_RATE_LIMIT_MAX = 300;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * IP 単位の global rate limit。`RATE_LIMIT_MAX=0` (または負) で null = 無効。
 * 数値として読めない値は既定 300 (limit を外す方向には倒さない)。
 * request 数は小整数なので Number で扱ってよい (CLAUDE.md §3 適用外)。
 */
export function rateLimitConfig(
  env: NodeJS.ProcessEnv = process.env
): { max: number; timeWindowMs: number } | null {
  const raw = env.RATE_LIMIT_MAX?.trim() ?? "";
  let max = DEFAULT_RATE_LIMIT_MAX;
  if (raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) max = Math.floor(n);
  }
  if (max <= 0) return null;
  return { max, timeWindowMs: RATE_LIMIT_WINDOW_MS };
}

function trimmedOrNull(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** 管理 route の共有トークン。未設定は null (dev は開放、production は閉じる — public-guards.ts) */
export function adminToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimmedOrNull(env.ADMIN_TOKEN);
}

/** Cloudflare Pages Function → BFF の共有鍵。未設定なら proxy header を一切信じない */
export function proxySecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimmedOrNull(env.BFF_PROXY_SECRET);
}

/** build の commit (Dockerfile の ARG GIT_SHA)。`/health.version` 用 */
export function gitSha(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimmedOrNull(env.GIT_SHA);
}

/** Expo push token の登録を受け付けるか (FCM 未設定の配布物では off のまま) */
export function pushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXPO_PUSH_ENABLED?.trim() === "true";
}

/**
 * production (公開 BFF) で起動してはいけない env の組み合わせを拒否する
 * (docs/external-release-api-handling.md §1.3: BFF が秘密鍵を持つ経路は公開 BFF に置かない)。
 *
 * - `AUTONOMOUS_DELEGATE_SECRET` が設定されている (BFF が keypair を持つ唯一の経路)
 * - `FEATURE_APPROVAL_MODE_AUTO=true` (自律実行の feature flag)
 * - `AUTONOMOUS_LOOP_MS` が 0 より大きい (または数値として読めない) — scheduler の起動
 *
 * error message には変数 **名** だけを入れる。値 (秘密鍵) は絶対にログへ出さない。
 * NODE_ENV が production 以外では何もしない (dev / test の自律デモを壊さない)。
 */
export function assertProductionEnvSafe(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const offending: string[] = [];
  if ((env.AUTONOMOUS_DELEGATE_SECRET?.trim() ?? "") !== "") {
    offending.push("AUTONOMOUS_DELEGATE_SECRET");
  }
  if (env.FEATURE_APPROVAL_MODE_AUTO?.trim().toLowerCase() === "true") {
    offending.push("FEATURE_APPROVAL_MODE_AUTO");
  }
  const loop = env.AUTONOMOUS_LOOP_MS?.trim() ?? "";
  if (loop !== "") {
    const n = Number(loop);
    // 読めない値は「起動するかもしれない」ので拒否側 (fail-closed)
    if (!Number.isFinite(n) || n > 0) offending.push("AUTONOMOUS_LOOP_MS");
  }
  if (offending.length > 0) {
    throw new Error(
      `Refusing to start in production: unset ${offending.join(", ")} ` +
        "(autonomous signing must not run on a public BFF)."
    );
  }
}
