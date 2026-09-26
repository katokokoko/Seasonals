jest.mock("./pricing", () => ({ checkPeg: jest.fn() }));
import { checkPeg } from "./pricing";
import { buildUniswapSwapPlan, UniswapError } from "./uniswap";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDE = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const swapper = "0x283Ac701577ca85327aA9f371a4E6cD631FC383b";

beforeEach(() => {
  process.env.UNISWAP_API_KEY = "test-key-not-real-000";
});

test("only USDC ⇄ USDe (pairs that have a Chainlink peg guard)", async () => {
  await expect(buildUniswapSwapPlan({ swapper, tokenIn: USDC, tokenOut: WETH, amount: "1" })).rejects.toBeInstanceOf(UniswapError);
  expect(checkPeg).not.toHaveBeenCalled();
});

test("peg guard refusal stops before any Trading API call (fail-closed)", async () => {
  (checkPeg as jest.Mock).mockResolvedValue({ ok: false, reason: "Price is stale — refusing (fail-closed).", deviationBps: null, bandBps: 50, prices: [] });
  const fetchSpy = jest.spyOn(globalThis, "fetch");
  await expect(buildUniswapSwapPlan({ swapper, tokenIn: USDC, tokenOut: USDE, amount: "100000000" })).rejects.toThrow(/Price guard refused/);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
