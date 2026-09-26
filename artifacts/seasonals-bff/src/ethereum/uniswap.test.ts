import { summarizeQuote } from "./uniswap";
import { buildServer } from "../server";

test("CLASSIC quote → swap path described, never executable here", () => {
  const p = summarizeQuote({ routing: "CLASSIC", requestId: "r1", quote: { output: { amount: "999941926838758711860" }, gasFeeUSD: "0.03" }, permitData: {} }, "1000000000", true);
  expect(p).toMatchObject({ routing: "CLASSIC", amountOut: "999941926838758711860", approvalRequired: true, permitSignatureRequired: true, executable: false });
  expect(p.nextStep).toMatch(/peg guard/);
  expect(summarizeQuote({ routing: "CLASSIC", quote: { gasFeeUSD: "0.031076847874406184" } }, "1", false).gasFeeUsd).toBe("0.03107684");
});

test("UniswapX and CHAINED routes are not executable", () => {
  expect(summarizeQuote({ routing: "DUTCH_V2", quote: { orderInfo: { outputs: [{ startAmount: "5" }] } }, permitData: null }, "1", false)).toMatchObject({ amountOut: "5", permitSignatureRequired: false });
  expect(summarizeQuote({ routing: "CHAINED", quote: {} }, "1", false).nextStep).toMatch(/not supported/);
  expect(summarizeQuote({ routing: "CLASSIC", quote: { output: { amount: "1.5" } } }, "1", false).amountOut).toBeNull();
});

describe("route validation", () => {
  const good = {
    swapper: "0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5",
    tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokenOut: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  };
  it("rejects non-integer amounts (smallest unit only)", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/eth/uniswap/quote", payload: { ...good, amount: "1.5" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_amount");
    await app.close();
  });
  it("without a key the proxy reports it instead of calling out", async () => {
    const saved = process.env.UNISWAP_API_KEY;
    process.env.UNISWAP_API_KEY = "";
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/eth/uniswap/quote", payload: { ...good, amount: "1000000" } });
    process.env.UNISWAP_API_KEY = saved;
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/not configured/);
    await app.close();
  });
});
