/**
 * orca-tx — B2: positions 用の read-only context (module で 1 つ) と pool の共有 cache (30 秒)。
 * SDK は mock。我々の miss では SDK 側 cache を使わない (IGNORE_CACHE)。
 */
import { PublicKey } from "@solana/web3.js";
import { ORCA_MARKETS } from "@workspace/lib/config/orca-markets";
import { fetchOrcaPositions } from "./orca-tx";
import { _clearAllCachesForTest } from "../cache/ttl-cache";

const IGNORE = { maxAge: 0 };
const mockGetPool = jest.fn(async () => ({ getData: () => ({ sqrtPrice: { toString: () => "18446744073709551616" } }) }));
const mockFrom = jest.fn(() => ({ ctx: true }));
const mockGetAll = jest.fn();
jest.mock("@orca-so/whirlpools-sdk", () => ({
  IGNORE_CACHE: { maxAge: 0 },
  ORCA_WHIRLPOOL_PROGRAM_ID: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  WhirlpoolContext: { from: (...a: unknown[]) => mockFrom(...(a as [])) },
  buildWhirlpoolClient: () => ({ getPool: (...a: unknown[]) => mockGetPool(...(a as [])) }),
  getAllPositionAccountsByOwner: (...a: unknown[]) => mockGetAll(...(a as [])),
  PoolUtil: { getTokenAmountsFromLiquidity: () => ({ tokenA: 1n, tokenB: 2n }) },
  PriceMath: { tickIndexToSqrtPriceX64: () => 0n },
}));

const WALLET_A = "11111111111111111111111111111111";
const WALLET_B = "So11111111111111111111111111111111111111112";
const market = ORCA_MARKETS[0]!;

function positionsIn(pool: string) {
  const pos = {
    whirlpool: new PublicKey(pool),
    positionMint: new PublicKey(WALLET_B),
    liquidity: 10n,
    tickLowerIndex: -10,
    tickUpperIndex: 10,
    feeOwedA: 0n,
    feeOwedB: 0n,
  };
  return { positions: new Map([["Pos1", pos]]), positionsWithTokenExtensions: new Map() };
}

beforeEach(() => {
  jest.clearAllMocks();
  _clearAllCachesForTest();
  process.env.HELIUS_API_KEY = "test-key";
  mockGetAll.mockResolvedValue(positionsIn(market.pool_address));
});
afterEach(() => jest.useRealTimers());

test("pool は wallet を跨いで 30 秒共有、miss は IGNORE_CACHE で読み、owner は wallet ごとに渡す", async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ["nextTick", "setImmediate"] });
  const [a] = await Promise.all([fetchOrcaPositions(WALLET_A), fetchOrcaPositions(WALLET_B)]);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ pool_id: market.pool_id, position_address: "Pos1", token_a: "1", token_b: "2" });
  expect(mockGetPool).toHaveBeenCalledTimes(1);
  expect(mockGetPool).toHaveBeenCalledWith(market.pool_address, IGNORE);
  // positions の読みは wallet ごと (owner 明示)
  expect(mockGetAll.mock.calls.map((c) => (c[0] as { owner: PublicKey }).owner.toBase58()).sort()).toEqual([WALLET_A, WALLET_B].sort());
  // read-only context は 1 つ
  expect(mockFrom).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(30_000);
  await fetchOrcaPositions(WALLET_A);
  expect(mockGetPool).toHaveBeenCalledTimes(2);
  expect(mockFrom).toHaveBeenCalledTimes(1);
});
