/**
 * BFF API client — Web の通信はすべてここを経由する (CLAUDE.md §5)。
 * `/api/*` は Vite dev proxy / 本番 reverse proxy で BFF へ転送される。
 * API key / RPC URL は BFF 側にしか無い。
 */
import type {
  ProtocolMenuEntry,
  TimelineEventsResponse,
  UnifiedTimeEventDTO,
} from "@workspace/lib/types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
    });
  } catch (e) {
    throw new ApiError(0, path, "Seasonals server is not reachable.");
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.message ?? body.error ?? msg;
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, path, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ status: string }>("/health"),
  solanaWalletEvents: (wallet: string) =>
    request<UnifiedTimeEventDTO[]>(`/time-events/wallet?wallet=${encodeURIComponent(wallet)}`),
  menuListings: () => request<ProtocolMenuEntry[]>("/menu-listings"),
  ethPublicEvents: () => request<TimelineEventsResponse>("/eth/public-events"),
  ethEvents: (address: string) => request<TimelineEventsResponse>(`/eth/events?address=${encodeURIComponent(address)}`),
  ethStatus: () => request<EthStatus>("/eth/status"),
};

/** /eth/status — 各 integration の設定有無のみ (値は返さない) */
export interface EthStatus {
  rpcConfigured: boolean;
  uniswapConfigured: boolean;
  llmConfigured: boolean;
  executionTarget: "fork" | "mainnet";
  forkReachable: boolean;
  chainId: number | null;
  latestBlock: string | null;
}
