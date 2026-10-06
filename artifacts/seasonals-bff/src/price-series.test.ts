/**
 * solanaPriceSeries — 評価額履歴の過去価格。Pyth Benchmarks (feed のある asset) が空 series を返す時
 * (2026-10 時点で 404) は DefiLlama に落とし、現在価格の横一直線にしない。
 */
jest.mock("./clients/pyth-history", () => ({
  ...jest.requireActual("./clients/pyth-history"),
  fetchPriceSeries: jest.fn(),
}));
jest.mock("./clients/llama-history", () => ({
  ...jest.requireActual("./clients/llama-history"),
  fetchLlamaPriceSeries: jest.fn(),
}));

import { fetchPriceSeries } from "./clients/pyth-history";
import { fetchLlamaPriceSeries } from "./clients/llama-history";
import { solanaPriceSeries } from "./server";

const SOL = "So11111111111111111111111111111111111111112";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const pyth = fetchPriceSeries as jest.MockedFunction<typeof fetchPriceSeries>;
const llama = fetchLlamaPriceSeries as jest.MockedFunction<typeof fetchLlamaPriceSeries>;

const asset = (mint: string, symbol: string, feedId?: string) =>
  ({ mint, symbol, decimals: 9, feedId, deposited: false, currentUsd8: "1.00000000", protocolId: "wallet_holding", category: "other" }) as never;

afterEach(() => jest.resetAllMocks());

test("Benchmarks が空なら feed のある asset も llama に落とす", async () => {
  pyth.mockResolvedValue({ t: [], usd8: [] });
  llama.mockImplementation(async (mints) => new Map(mints.map((m) => [m, { t: [1, 2], usd8: [`${m === SOL ? "120" : "0.00002"}.00000000`, "1.00000000"] }])));
  const out = await solanaPriceSeries([asset(SOL, "SOL", "ef0d"), asset(BONK, "BONK")], 0, 10, 1);
  expect(llama).toHaveBeenCalledTimes(2);
  expect(llama.mock.calls[0]![0]).toEqual([BONK]); // feed なし
  expect(llama.mock.calls[1]![0]).toEqual([SOL]); // Benchmarks が空だった feed あり
  expect(out.get(SOL)?.t).toEqual([1, 2]);
  expect(out.get(BONK)?.t).toEqual([1, 2]);
});

test("Benchmarks が取れていれば llama は feed なしの分だけ", async () => {
  pyth.mockResolvedValue({ t: [5], usd8: ["121.00000000"] });
  llama.mockResolvedValue(new Map());
  const out = await solanaPriceSeries([asset(SOL, "SOL", "ef0d")], 0, 10, 1);
  expect(llama).toHaveBeenCalledTimes(1);
  expect(llama.mock.calls[0]![0]).toEqual([]);
  expect(out.get(SOL)).toEqual({ t: [5], usd8: ["121.00000000"] });
});
