import { ethereumRpcUrl, sanitizeError } from "./client";
import { derivePendleMarketEvents, derivePendlePositionEvents, type PendleMarket } from "./pendle";
import { deriveEthenaCooldownEvent } from "./ethena";
import { deriveLidoEvents } from "./lido";
import { buildServer } from "../server";

const NOW = "2026-09-26T00:00:00.000Z";
const KEY = "abcdef0123456789abcdef0123456789";

describe("client env / sanitize", () => {
  it("ETHEREUM_RPC_URL wins over INFURA_API_KEY; none → null", () => {
    expect(ethereumRpcUrl({ INFURA_API_KEY: KEY })).toBe(`https://mainnet.infura.io/v3/${KEY}`);
    expect(ethereumRpcUrl({ INFURA_API_KEY: KEY, ETHEREUM_RPC_URL: "http://x.local" })).toBe("http://x.local");
    expect(ethereumRpcUrl({})).toBeNull();
  });
  it("never leaks the key or the RPC URL", () => {
    const err = new Error(`HTTP request failed.\nURL: https://mainnet.infura.io/v3/${KEY}\nStatus: 429`);
    const out = sanitizeError(err, { INFURA_API_KEY: KEY });
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("infura.io");
    const out2 = sanitizeError({ shortMessage: `bad ${KEY} at https://mainnet.infura.io/v3/${KEY}` }, { INFURA_API_KEY: KEY });
    expect(out2).toBe("bad <redacted> at <url>");
  });
});

const market = (over: Partial<PendleMarket>): PendleMarket => ({
  name: "sUSDe",
  address: "0xAAA",
  expiry: "2026-11-27T00:00:00.000Z",
  pt: "1-0xPT",
  yt: "1-0xYT",
  sy: "1-0xSY",
  underlyingAsset: "1-0xU",
  chainId: 1,
  details: { liquidity: 1_000_000, impliedApy: 0.08 },
  ...over,
});

describe("pendle", () => {
  it("public events: chain 1, future only, by liquidity, wallet-independent", () => {
    const ev = derivePendleMarketEvents(
      [
        market({ address: "0x1", details: { liquidity: 10 } }),
        market({ address: "0x2", details: { liquidity: 99 } }),
        market({ address: "0x3", expiry: "2026-01-01T00:00:00.000Z" }),
        market({ address: "0x4", chainId: 8453 }),
      ],
      NOW
    );
    expect(ev.map((e) => e.id)).toEqual(["ethereum:pendle:pt_maturity:market:0x2", "ethereum:pendle:pt_maturity:market:0x1"]);
    expect(ev.every((e) => !e.requiresWallet && e.class === "protocol")).toBe(true);
    expect(ev[0]!.metrics.some((m) => m.label === "Liquidity (USD)")).toBe(true);
    expect(derivePendleMarketEvents([market({})], NOW)[0]!.metrics.some((m) => m.label === "Implied APY (fixed)")).toBe(true);
  });
  it("positions: matured PT → Redeem available; future → not_yet; zero skipped", () => {
    const mk = new Map([
      ["0xaaa", market({ address: "0xAAA", expiry: "2026-09-01T00:00:00.000Z" })],
      ["0xbbb", market({ address: "0xBBB", pt: "1-0xPT2", name: "USDe" })],
    ]);
    const pos = (id: string, bal: string) => ({ marketId: `1-${id}`, pt: { balance: bal, valuation: 1234.5 }, yt: { balance: "0", valuation: 0 }, lp: { balance: "0", valuation: 0 } });
    const ev = derivePendlePositionEvents("0xOwner", [pos("0xAAA", "1000000000000000000"), pos("0xBBB", "5"), pos("0xAAA", "0")], mk, new Map([["0xpt", 18]]), NOW);
    expect(ev).toHaveLength(2);
    expect(ev[0]!.actions[0]!.availability).toBe("available");
    expect(ev[0]!.amount).toEqual({ value: "1000000000000000000", decimals: 18, symbol: "PT-sUSDe" });
    expect(ev[0]!.usd).toBe("1234.50000000");
    expect(ev[1]!.actions[0]!.availability).toBe("not_yet");
    expect(ev[1]!.amount).toBeUndefined(); // decimals 不明なら金額を出さない
  });
});

describe("ethena", () => {
  it("no cooldown → null; future → not_yet; past → available", () => {
    expect(deriveEthenaCooldownEvent("0xO", { cooldownEnd: 0n, underlyingAmount: 0n }, 86400, NOW)).toBeNull();
    const future = deriveEthenaCooldownEvent("0xO", { cooldownEnd: BigInt(Date.parse(NOW) / 1000 + 3600), underlyingAmount: 10n ** 18n }, 86400, NOW)!;
    expect(future.actions[0]!.availability).toBe("not_yet");
    expect(future.amount!.value).toBe("1000000000000000000");
    const past = deriveEthenaCooldownEvent("0xO", { cooldownEnd: BigInt(Date.parse(NOW) / 1000 - 60), underlyingAmount: 1n }, 86400, NOW)!;
    expect(past.actions[0]!.availability).toBe("available");
    expect(past.title).toMatch(/claimable/);
  });
});

describe("lido", () => {
  it("claimed hidden, pending has no ETA, finalized is claimable now", () => {
    const ev = deriveLidoEvents(
      "0xO",
      [
        { requestId: 1n, amountOfStETH: 5n, timestamp: 1_790_000_000n, isFinalized: false, isClaimed: false },
        { requestId: 2n, amountOfStETH: 7n, timestamp: 1_790_000_000n, isFinalized: true, isClaimed: false },
        { requestId: 3n, amountOfStETH: 9n, timestamp: 1_790_000_000n, isFinalized: true, isClaimed: true },
      ],
      NOW
    );
    expect(ev.map((e) => e.kind)).toEqual(["withdrawal_pending", "withdrawal_claimable"]);
    expect(ev[0]!.at).toBeNull();
    expect(ev[0]!.actions[0]!.availability).toBe("not_yet");
    expect(ev[1]!.actions[0]).toMatchObject({ actionType: "lido_claim", availability: "available", params: { requestId: "2" } });
  });
});

describe("routes", () => {
  it("rejects a non-EVM address", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/eth/events?address=nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_address");
    await app.close();
  });
  it("status exposes booleans only", async () => {
    const saved = { ...process.env };
    process.env.INFURA_API_KEY = "";
    process.env.ETHEREUM_RPC_URL = "";
    process.env.ETH_FORK_RPC_URL = "http://127.0.0.1:1";
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/eth/status" });
    process.env = saved;
    const body = res.json();
    expect(body.rpcConfigured).toBe(false);
    expect(body.forkReachable).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/https?:/);
    await app.close();
  });
  it("execute requires explicit user approval and refuses mainnet targets", async () => {
    const app = await buildServer();
    const body = { owner: "0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5", eventId: "x", actionType: "lido_claim" };
    const noApproval = await app.inject({ method: "POST", url: "/eth/execute", payload: body });
    expect(noApproval.statusCode).toBe(403);
    const saved = process.env.ETH_EXECUTION_TARGET;
    process.env.ETH_EXECUTION_TARGET = "mainnet";
    const mainnet = await app.inject({ method: "POST", url: "/eth/execute", payload: { ...body, approvedBy: "user" } });
    process.env.ETH_EXECUTION_TARGET = saved;
    expect(mainnet.statusCode).toBe(409);
    expect(mainnet.json().message).toMatch(/plans only/);
    await app.close();
  });
  it("execute refuses a non-Anvil endpoint", async () => {
    const saved = { ...process.env };
    process.env.ETH_EXECUTION_TARGET = "fork";
    process.env.ETH_FORK_RPC_URL = "http://127.0.0.1:1";
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/eth/execute", payload: { owner: "0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5", eventId: "x", actionType: "lido_claim", approvedBy: "user" } });
    process.env = saved;
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/fork is not running/);
    await app.close();
  });
});
