/**
 * Ethereum mainnet read client (viem) — docs/web/WORKLOG.md Stage B
 *
 * - RPC URL は server 側 env からのみ組み立てる: ETHEREUM_RPC_URL > INFURA_API_KEY
 * - viem のエラー文言は request URL (= API key) を含むことがあるため、
 *   log / HTTP response に出す前に必ず `sanitizeError()` を通す
 * - HTTP は undici を明示利用 (solend-sdk が global fetch を差し替える既知問題、
 *   CLAUDE.md §10 / orca-tx.ts と同じ対策)
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

export function undiciFetch(): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("undici") as { fetch: typeof fetch }).fetch;
}

/** env から RPC URL を得る。未設定なら null (Ethereum 読み取りは「未接続」扱い) */
export function ethereumRpcUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ETHEREUM_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = env.INFURA_API_KEY?.trim();
  return key ? `https://mainnet.infura.io/v3/${key}` : null;
}

/** 秘密値として扱う env 値 (sanitize 対象) */
function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.INFURA_API_KEY, env.ETHEREUM_RPC_URL, env.UNISWAP_API_KEY, env.ANTHROPIC_API_KEY]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v && v.length >= 8));
}

/**
 * エラーを外に出せる短い文字列にする。URL / key を必ず除去する。
 */
export function sanitizeError(err: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null;
  let msg =
    typeof e?.shortMessage === "string"
      ? e.shortMessage
      : typeof e?.message === "string"
        ? e.message
        : String(err);
  for (const s of secretValues(env)) msg = msg.split(s).join("<redacted>");
  msg = msg.replace(/https?:\/\/[^\s"')]+/g, "<url>");
  return msg.split("\n")[0]!.slice(0, 240);
}

let cached: { url: string; client: PublicClient } | null = null;

export function getEthClient(): PublicClient | null {
  const url = ethereumRpcUrl();
  if (!url) return null;
  if (cached?.url === url) return cached.client;
  const client = createPublicClient({
    chain: mainnet,
    transport: http(url, { fetchFn: undiciFetch(), timeout: 20_000, retryCount: 2, retryDelay: 400 }),
    batch: { multicall: true },
  }) as PublicClient;
  cached = { url, client };
  return client;
}

/** fork (Anvil) client — EXECUTION_TARGET=fork の実行デモ用 */
export function forkRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ETH_FORK_RPC_URL?.trim() || "http://127.0.0.1:8545";
}

export function executionTarget(env: NodeJS.ProcessEnv = process.env): "fork" | "mainnet" {
  return env.ETH_EXECUTION_TARGET === "mainnet" ? "mainnet" : "fork";
}

/** JSON over HTTP (undici)。timeout 付き。失敗は sanitize 済み Error */
export async function getJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await undiciFetch()(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return (await res.json()) as T;
  } catch (e) {
    throw new Error(sanitizeError(e));
  } finally {
    clearTimeout(t);
  }
}
