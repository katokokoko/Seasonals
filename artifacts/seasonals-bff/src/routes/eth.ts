/**
 * /eth/* routes (docs/web/WORKLOG.md Stage B)。読み取りのみ。
 * - GET /eth/status          integration の設定有無 (値は返さない)
 * - GET /eth/public-events   wallet 非依存の公開イベント
 * - GET /eth/events?address= address 別 + 公開イベント
 */
import type { FastifyInstance } from "fastify";
import { isEvmAddress } from "@workspace/lib/config/chains";
import { ethereumRpcUrl, executionTarget, forkRpcUrl, getEthClient, sanitizeError, undiciFetch } from "../ethereum/client";
import { getPublicEvents, getUserEvents } from "../ethereum/events";
import { buildActionPlan, PlanError } from "../ethereum/plans";
import { buildProposal } from "../ethereum/proposals";

async function forkReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    const res = await undiciFetch()(forkRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export async function registerEthRoutes(parent: FastifyInstance): Promise<void> {
  // /eth/* は独立 scope: 想定外の例外でも key / RPC URL を含む生エラーを log / response に出さない
  await parent.register(async (app) => {
    app.setErrorHandler((err, _req, reply) => {
      const message = sanitizeError(err);
      app.log.warn({ err: message }, "eth route error");
      const status = (err as { statusCode?: number } | null)?.statusCode;
      reply.code(status && status < 500 ? status : 502).send({ error: "upstream_error", message });
    });
    await ethRoutes(app);
  });
}

async function ethRoutes(app: FastifyInstance): Promise<void> {
  app.get("/eth/status", async () => {
    const client = getEthClient();
    let latestBlock: string | null = null;
    let chainId: number | null = null;
    if (client) {
      try {
        [latestBlock, chainId] = await Promise.all([client.getBlockNumber().then((b) => b.toString()), client.getChainId()]);
      } catch (e) {
        app.log.warn({ err: sanitizeError(e) }, "eth status read failed");
      }
    }
    return {
      rpcConfigured: ethereumRpcUrl() !== null,
      uniswapConfigured: Boolean(process.env.UNISWAP_API_KEY?.trim()),
      llmConfigured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      executionTarget: executionTarget(),
      forkReachable: await forkReachable(),
      chainId,
      latestBlock,
    };
  });

  app.get("/eth/public-events", async () => getPublicEvents());

  app.get<{ Querystring: { address?: string } }>("/eth/events", async (req, reply) => {
    const address = req.query.address?.trim() ?? "";
    if (!isEvmAddress(address)) {
      return reply.code(400).send({ error: "invalid_address", message: "address must be a 0x-prefixed 20-byte hex string" });
    }
    const [pub, user] = await Promise.all([getPublicEvents(), getUserEvents(address)]);
    return { events: [...user.events, ...pub.events.filter((e) => !user.events.some((u) => u.id === e.id))], sources: [...user.sources, ...pub.sources] };
  });

  app.get<{ Querystring: { address?: string; eventId?: string } }>("/eth/proposal", async (req, reply) => {
    const address = req.query.address?.trim() ?? "";
    if (!isEvmAddress(address) || !req.query.eventId) return reply.code(400).send({ error: "invalid_argument" });
    try {
      const p = await buildProposal(address, req.query.eventId);
      if (!p) return reply.code(404).send({ error: "no_proposal", message: "No proposal for this event." });
      return p;
    } catch (e) {
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /** unsigned plan のみ。署名・broadcast はしない (v3 §9) */
  app.post<{ Body: { owner?: string; eventId?: string; actionType?: string } }>("/eth/build-action", async (req, reply) => {
    const { owner = "", eventId = "", actionType = "" } = req.body ?? {};
    if (!isEvmAddress(owner) || !eventId || !actionType) return reply.code(400).send({ error: "invalid_argument" });
    try {
      return await buildActionPlan({ owner, eventId, actionType });
    } catch (e) {
      if (e instanceof PlanError) {
        const code = e.code === "event_not_found" ? 404 : e.code === "rpc_unavailable" || e.code === "upstream_error" ? 502 : 409;
        return reply.code(code).send({ error: e.code, message: e.message });
      }
      app.log.warn({ err: sanitizeError(e) }, "build-action failed");
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });
}
