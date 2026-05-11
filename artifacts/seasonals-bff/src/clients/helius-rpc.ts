/**
 * helius-rpc — Helius Mainnet JSON-RPC client (Phase 8.8)
 *
 * sendTransaction を Helius mainnet RPC 経由で投げる薄い wrapper。
 * Phantom の signAndSendTransactions が v0 versioned tx + address lookup tables を
 * 含む Jupiter swap で empty result を返す問題を回避するため、Mobile は MWA で
 * 署名のみ行い、broadcast は BFF → Helius RPC に委ねる。
 *
 * HELIUS_API_KEY env (Phase 8.1 で設定済) を使う。mainnet エンドポイント:
 *   https://mainnet.helius-rpc.com/?api-key=<key>
 */

const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";

function buildUrl(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY is not set");
  }
  return `${HELIUS_MAINNET_URL}/?api-key=${apiKey}`;
}

/**
 * base64-encoded signed transaction を Helius mainnet RPC で submit。
 * 成功すると base58 signature を返す。
 */
export async function sendTransactionViaHelius(
  signedTxBase64: string,
  opts: {
    skipPreflight?: boolean;
    maxRetries?: number;
  } = {}
): Promise<string> {
  const url = buildUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-submit",
      method: "sendTransaction",
      params: [
        signedTxBase64,
        {
          encoding: "base64",
          skipPreflight: opts.skipPreflight ?? false,
          maxRetries: opts.maxRetries ?? 3,
          preflightCommitment: "confirmed",
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Helius sendTransaction HTTP ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  const json = (await res.json()) as {
    result?: string;
    error?: { code: number; message: string; data?: unknown };
  };
  if (json.error) {
    throw new Error(
      `Helius sendTransaction RPC error ${json.error.code}: ${json.error.message}`
    );
  }
  if (!json.result || typeof json.result !== "string") {
    throw new Error("Helius sendTransaction: missing signature in result");
  }
  return json.result;
}
