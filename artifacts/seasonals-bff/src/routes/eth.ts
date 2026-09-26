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
import { advanceFork, executeMenuOnFork, executeOnFork, mineFork } from "../ethereum/execute";
import { buildMenuPlan, pendleTradeContext, type MenuPlanInput } from "../ethereum/menu-actions";
import { pendleOracleReady } from "../ethereum/pendle-guard";
import { ensureIndexing, indexProgress } from "../ethereum/cca";
import { UniswapError, buildUniswapSwapPlan, executeUniswapSwapOnFork, uniswapPreview } from "../ethereum/uniswap";
import { getEthMenu } from "../ethereum/menu";
import { getMenuHoldings } from "../ethereum/holdings";
import { getAavePositions } from "../ethereum/aave";
import { buildAquaShipPlan, fillAquaOnFork, shipAquaOnFork, type AquaShipInput } from "../ethereum/aqua";
import { checkPeg, getChainlinkPrice, PRICE_ASSETS, type PriceAsset } from "../ethereum/pricing";
import { assertTokenAmount, InvalidAmountError } from "@workspace/lib/utils/numeric";

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
  /** CCA indexer の進捗 (10k block 分割の getLogs、進捗は .data に保存) */
  app.get("/eth/cca/status", async () => {
    ensureIndexing();
    return indexProgress();
  });

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

  /** Chainlink 価格 (表示用)。取れない資産は null */
  app.get<{ Querystring: { assets?: string } }>("/eth/prices", async (req) => {
    const names = (req.query.assets ?? "USDC,USDe,ETH").split(",").filter((x): x is PriceAsset => x in PRICE_ASSETS);
    const prices = await Promise.all(names.map((n) => getChainlinkPrice(n)));
    return Object.fromEntries(names.map((n, i) => [n, prices[i]]));
  });

  /** fail-closed peg guard (価格依存の実行前チェック) */
  app.get<{ Querystring: { base?: string; quote?: string; bandBps?: string } }>("/eth/peg", async (req, reply) => {
    const base = req.query.base as PriceAsset;
    const quote = req.query.quote as PriceAsset;
    const band = Number.parseInt(req.query.bandBps ?? "50", 10);
    if (!(base in PRICE_ASSETS) || !(quote in PRICE_ASSETS) || !Number.isInteger(band) || band <= 0 || band > 1000) {
      return reply.code(400).send({ error: "invalid_argument" });
    }
    return checkPeg(base, quote, band);
  });

  /** Aave V4 の position (context のみ、calendar event は作らない) */
  app.get<{ Querystring: { address?: string } }>("/eth/aave", async (req, reply) => {
    const address = req.query.address?.trim() ?? "";
    if (!isEvmAddress(address)) return reply.code(400).send({ error: "invalid_address" });
    try {
      return { positions: await getAavePositions(address) };
    } catch (e) {
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /** Explore の Ethereum 商品 (利率は label + 出所付き、取れなければ null) */
  app.get("/eth/menu", async () => getEthMenu());

  /** Menu 商品ごとの保有量 (on-chain 残高が正、失敗した source は failed[]) */
  app.get<{ Querystring: { address?: string } }>("/eth/holdings", async (req, reply) => {
    const address = req.query.address?.trim() ?? "";
    if (!isEvmAddress(address)) {
      return reply.code(400).send({ error: "invalid_address", message: "address must be a 0x-prefixed 20-byte hex string" });
    }
    return getMenuHoldings(address);
  });

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

  /** PlanError → HTTP (入力の誤りは 400、状態が合わないのは 409、上流 / RPC は 502) */
  const planErrorStatus = (code: PlanError["code"]) =>
    code === "invalid_amount"
      ? 400
      : code === "event_not_found"
        ? 404
        : code === "rpc_unavailable" || code === "upstream_error" || code === "oracle_unavailable"
          ? 502
          : 409;

  function menuInput(body: Partial<MenuPlanInput> | undefined): MenuPlanInput | null {
    const { owner = "", productId = "", action, amount = "", token } = body ?? {};
    if (!isEvmAddress(owner) || !productId || (action !== "deposit" && action !== "withdraw") || typeof amount !== "string" || !amount) return null;
    return { owner, productId, action, amount, ...(typeof token === "string" ? { token } : {}) };
  }

  /** Pendle 売買パネル用: 払う / 受け取るトークンと残高、満期 (on-chain で読む) */
  app.get<{ Querystring: { address?: string; productId?: string; action?: string } }>("/eth/menu/context", async (req, reply) => {
    const { address = "", productId = "", action } = req.query;
    if (!isEvmAddress(address) || !productId || (action !== "deposit" && action !== "withdraw")) return reply.code(400).send({ error: "invalid_argument" });
    const client = getEthClient();
    if (!client) return reply.code(502).send({ error: "rpc_unavailable", message: "Ethereum RPC is not configured." });
    try {
      const ctx = await pendleTradeContext(client as never, address as `0x${string}`, productId, action);
      return {
        oracleReady: await pendleOracleReady(client as never, ctx.market.address),
        matured: ctx.matured,
        maturity: ctx.market.expiry,
        token: { value: ctx.token.balance.toString(), decimals: ctx.token.decimals, symbol: ctx.token.symbol },
        pyToken: { value: ctx.pyToken.balance.toString(), decimals: ctx.pyToken.decimals, symbol: ctx.pyToken.symbol },
      };
    } catch (e) {
      if (e instanceof PlanError) return reply.code(planErrorStatus(e.code)).send({ error: e.code, message: e.message });
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /** Menu の deposit / withdraw: 未署名プランのみ (送信しない) */
  app.post<{ Body: Partial<MenuPlanInput> }>("/eth/menu/plan", async (req, reply) => {
    const input = menuInput(req.body);
    if (!input) return reply.code(400).send({ error: "invalid_argument" });
    try {
      return await buildMenuPlan(input);
    } catch (e) {
      if (e instanceof PlanError) return reply.code(planErrorStatus(e.code)).send({ error: e.code, message: e.message });
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /** Menu の deposit / withdraw を fork で実行 (人が UI で承認した時だけ、mainnet には送らない) */
  app.post<{ Body: Partial<MenuPlanInput> & { approvedBy?: string } }>("/eth/menu/execute", async (req, reply) => {
    const input = menuInput(req.body);
    if (!input) return reply.code(400).send({ error: "invalid_argument" });
    if (req.body?.approvedBy !== "user") return reply.code(403).send({ error: "approval_required", message: "Execution requires the user's approval in the app." });
    try {
      return await executeMenuOnFork(input);
    } catch (e) {
      if (e instanceof PlanError) return reply.code(planErrorStatus(e.code)).send({ error: e.code, message: e.message });
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /**
   * fork 実行 (人が UI で承認した request のみ)。ETH_EXECUTION_TARGET=fork かつ送信先が
   * Anvil mainnet fork の時だけ。mainnet への送信経路は無い
   */
  app.post<{ Body: { owner?: string; eventId?: string; actionType?: string; approvedBy?: string } }>("/eth/execute", async (req, reply) => {
    const { owner = "", eventId = "", actionType = "", approvedBy } = req.body ?? {};
    if (!isEvmAddress(owner) || !eventId || !actionType) return reply.code(400).send({ error: "invalid_argument" });
    if (approvedBy !== "user") return reply.code(403).send({ error: "approval_required", message: "Execution requires the user's approval in the app." });
    try {
      return await executeOnFork({ owner, eventId, actionType });
    } catch (e) {
      if (e instanceof PlanError) {
        const code = e.code === "event_not_found" ? 404 : e.code === "rpc_unavailable" || e.code === "upstream_error" ? 502 : 409;
        return reply.code(code).send({ error: e.code, message: e.message });
      }
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /** fork 専用: 時間を進める (demo の lifecycle 再生用) */
  app.post<{ Body: { seconds?: number } }>("/eth/fork/advance", async (req, reply) => {
    try {
      return await advanceFork(Number(req.body?.seconds));
    } catch (e) {
      if (e instanceof PlanError) return reply.code(e.code === "rpc_unavailable" ? 502 : 409).send({ error: e.code, message: e.message });
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /** fork 専用: block を進める (CCA の end / claim block を再生する) */
  app.post<{ Body: { blocks?: number } }>("/eth/fork/mine", async (req, reply) => {
    try {
      return await mineFork(Number(req.body?.blocks));
    } catch (e) {
      if (e instanceof PlanError) return reply.code(e.code === "rpc_unavailable" ? 502 : 409).send({ error: e.code, message: e.message });
      return reply.code(502).send({ error: "upstream_error", message: sanitizeError(e) });
    }
  });

  /** Uniswap Trading API: quote + 承認要否の preview のみ (server 側 key、実行経路なし) */
  app.post<{ Body: { swapper?: string; tokenIn?: string; tokenOut?: string; amount?: string } }>("/eth/uniswap/quote", async (req, reply) => {
    const { swapper = "", tokenIn = "", tokenOut = "", amount } = req.body ?? {};
    if (!isEvmAddress(swapper) || !isEvmAddress(tokenIn) || !isEvmAddress(tokenOut)) return reply.code(400).send({ error: "invalid_argument" });
    try {
      assertTokenAmount(amount); // smallest unit の整数 string のみ (CLAUDE.md §3)
    } catch (e) {
      if (e instanceof InvalidAmountError) return reply.code(400).send({ error: "invalid_amount" });
      throw e;
    }
    try {
      return await uniswapPreview({ swapper, tokenIn, tokenOut, amount: amount! });
    } catch (e) {
      if (e instanceof UniswapError) return reply.code(e.status >= 500 ? 502 : e.status).send({ error: "uniswap_error", message: sanitizeError(e) });
      throw e;
    }
  });

  const swapBody = (body: { swapper?: string; tokenIn?: string; tokenOut?: string; amount?: string } | undefined) => {
    const { swapper = "", tokenIn = "", tokenOut = "", amount } = body ?? {};
    if (!isEvmAddress(swapper) || !isEvmAddress(tokenIn) || !isEvmAddress(tokenOut)) return null;
    try {
      return { swapper, tokenIn, tokenOut, amount: assertTokenAmount(amount) };
    } catch {
      return null;
    }
  };

  /** Uniswap swap の unsigned plan (Chainlink peg guard を通った時だけ) */
  app.post<{ Body: { swapper?: string; tokenIn?: string; tokenOut?: string; amount?: string } }>("/eth/uniswap/swap-plan", async (req, reply) => {
    const input = swapBody(req.body);
    if (!input) return reply.code(400).send({ error: "invalid_argument" });
    try {
      return await buildUniswapSwapPlan(input);
    } catch (e) {
      if (e instanceof UniswapError) return reply.code(e.status >= 500 ? 502 : e.status).send({ error: "uniswap_error", message: sanitizeError(e) });
      throw e;
    }
  });

  /** fork 専用の swap 実行 (approvedBy=user 必須、mainnet には送らない) */
  app.post<{ Body: { swapper?: string; tokenIn?: string; tokenOut?: string; amount?: string; approvedBy?: string } }>("/eth/uniswap/execute", async (req, reply) => {
    const input = swapBody(req.body);
    if (!input) return reply.code(400).send({ error: "invalid_argument" });
    if (req.body?.approvedBy !== "user") return reply.code(403).send({ error: "approval_required", message: "Execution requires the user's approval in the app." });
    try {
      return await executeUniswapSwapOnFork(input);
    } catch (e) {
      if (e instanceof UniswapError) return reply.code(e.status >= 500 ? 502 : e.status).send({ error: "uniswap_error", message: sanitizeError(e) });
      if (e instanceof PlanError) return reply.code(e.code === "rpc_unavailable" ? 502 : 409).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  // ── 1inch Aqua (PEGGED_STABLE template のみ、peg guard fail-closed、実行は fork のみ) ──
  const aquaInput = (b: Partial<AquaShipInput> | undefined): AquaShipInput | null => {
    if (!b || !isEvmAddress(b.maker ?? "")) return null;
    return {
      maker: b.maker!,
      template: String(b.template ?? ""),
      usdcAmount: String(b.usdcAmount ?? ""),
      usdeAmount: String(b.usdeAmount ?? ""),
      bandBps: Number(b.bandBps),
      reviewAt: String(b.reviewAt ?? ""),
      ...(b.feeBps !== undefined ? { feeBps: Number(b.feeBps) } : {}),
    };
  };
  const planErr = (reply: import("fastify").FastifyReply, e: unknown) => {
    if (e instanceof PlanError) {
      const code = e.code === "event_not_found" ? 404 : e.code === "rpc_unavailable" || e.code === "upstream_error" ? 502 : 409;
      return reply.code(code).send({ error: e.code, message: e.message });
    }
    throw e;
  };

  /** unsigned ship plan (MCP の ship_lp_strategy もこれを読む) */
  app.post<{ Body: Partial<AquaShipInput> }>("/eth/aqua/ship-plan", async (req, reply) => {
    const input = aquaInput(req.body);
    if (!input) return reply.code(400).send({ error: "invalid_argument" });
    try {
      return await buildAquaShipPlan(input);
    } catch (e) {
      return planErr(reply, e);
    }
  });

  app.post<{ Body: Partial<AquaShipInput> & { approvedBy?: string } }>("/eth/aqua/ship", async (req, reply) => {
    const input = aquaInput(req.body);
    if (!input) return reply.code(400).send({ error: "invalid_argument" });
    if (req.body?.approvedBy !== "user") return reply.code(403).send({ error: "approval_required", message: "Execution requires the user's approval in the app." });
    try {
      return await shipAquaOnFork(input);
    } catch (e) {
      return planErr(reply, e);
    }
  });

  /** fork 専用: 1 回 fill して見せる (production の taker は KYB 済み resolver 限定) */
  app.post<{ Body: { strategyHash?: string; taker?: string; usdcIn?: string; approvedBy?: string } }>("/eth/aqua/fill", async (req, reply) => {
    const { strategyHash = "", taker = "", usdcIn = "" } = req.body ?? {};
    if (!/^0x[0-9a-fA-F]{64}$/.test(strategyHash) || !isEvmAddress(taker)) return reply.code(400).send({ error: "invalid_argument" });
    if (req.body?.approvedBy !== "user") return reply.code(403).send({ error: "approval_required", message: "Execution requires the user's approval in the app." });
    try {
      return await fillAquaOnFork({ strategyHash, taker, usdcIn });
    } catch (e) {
      return planErr(reply, e);
    }
  });
}
