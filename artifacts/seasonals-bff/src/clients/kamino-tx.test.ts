/**
 * Phase 8.52: kamino-tx の on-chain デコードと署名前ガードのテスト (network なし)。
 *
 * ここが固定するのは **我々のデコーダ / ガードの挙動** であって、Kamino 側の
 * 構造体レイアウトそのものではない (凍結した fixture では上流の変更を検知できない)。
 * レイアウト drift の実測検知は scripts/verify-tx-routes.mjs の drift check が担う。
 */
import { fetchWithTimeout } from "./http";
import { simulateUnsignedTx } from "./helius-rpc";
import {
  KaminoDoomedTxError,
  fetchKaminoDepositCaps,
  fetchKaminoDepositTx,
  fetchKaminoWithdrawTx,
} from "./kamino-tx";

jest.mock("./http");
jest.mock("./helius-rpc");

const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;
const mockSimulate = simulateUnsignedTx as jest.MockedFunction<
  typeof simulateUnsignedTx
>;

/** K-Lend Reserve 口座 (8624B) の合成 fixture。deposit_limit を offset 5016 に置く */
const KLEND_RESERVE_SIZE = 8624;
function reserveAccount(limit: bigint, size = KLEND_RESERVE_SIZE): string {
  const buf = Buffer.alloc(size);
  if (size >= 5024) buf.writeBigUInt64LE(limit, 5016);
  return buf.toString("base64");
}

function rpcReply(accounts: (string | null)[]) {
  return {
    ok: true,
    json: async () => ({
      result: {
        value: accounts.map((data) => (data === null ? null : { data: [data, "base64"] })),
      },
    }),
  } as unknown as Response;
}

// reserve address は**キャッシュのキー**なので、テストごとに別アドレスを使う
let seq = 0;
const nextReserve = () => `Reserve${(seq += 1)}`;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HELIUS_API_KEY = "test-key";
  mockSimulate.mockResolvedValue({ ok: true });
});

describe("fetchKaminoDepositCaps", () => {
  it("offset 5016 の u64 LE を deposit limit として読む", async () => {
    const reserve = nextReserve();
    mockFetch.mockResolvedValue(rpcReply([reserveAccount(1_000_000_000_000_000n)]));
    const caps = await fetchKaminoDepositCaps([reserve]);
    // 1.0B USDC (6 decimals) — 実測値と同じ桁
    expect(caps).toEqual([{ reserve, limit: 1_000_000_000_000_000n }]);
  });

  it("limit 0 (預入停止中) も 0n として返す — 「取れなかった」と区別する", async () => {
    const reserve = nextReserve();
    mockFetch.mockResolvedValue(rpcReply([reserveAccount(0n)]));
    expect(await fetchKaminoDepositCaps([reserve])).toEqual([
      { reserve, limit: 0n },
    ]);
  });

  it("口座サイズが 8624 でなければ skip (レイアウト変更時にゴミ値を読まない)", async () => {
    mockFetch.mockResolvedValue(
      rpcReply([reserveAccount(1_000n, 8624 + 64), reserveAccount(1_000n, 4096)])
    );
    expect(await fetchKaminoDepositCaps([nextReserve(), nextReserve()])).toEqual([]);
  });

  it("欠損口座 / RPC 失敗は空配列で degrade (呼び手は「上限不明」扱い)", async () => {
    mockFetch.mockResolvedValue(rpcReply([null]));
    expect(await fetchKaminoDepositCaps([nextReserve()])).toEqual([]);
    mockFetch.mockRejectedValue(new Error("network"));
    expect(await fetchKaminoDepositCaps([nextReserve()])).toEqual([]);
    expect(await fetchKaminoDepositCaps([])).toEqual([]); // 空入力で RPC を打たない
  });

  it("60s キャッシュ: 2 回目は RPC を打たない (menu と deposit 経路で共有)", async () => {
    const reserve = nextReserve();
    mockFetch.mockResolvedValue(rpcReply([reserveAccount(42n)]));
    await fetchKaminoDepositCaps([reserve]);
    const calls = mockFetch.mock.calls.length;
    expect(await fetchKaminoDepositCaps([reserve])).toEqual([{ reserve, limit: 42n }]);
    expect(mockFetch.mock.calls.length).toBe(calls);
  });
});

describe("署名前の simulate ガード", () => {
  const txReply = {
    ok: true,
    json: async () => ({ transaction: "TX_BASE64" }),
  } as unknown as Response;
  const body = { wallet: "W", market: "M", reserve: "R", amount: "1.5" };

  it("deposit: simulate が失敗したら KaminoDoomedTxError (理由付き)", async () => {
    mockFetch.mockResolvedValue(txReply);
    mockSimulate.mockResolvedValue({
      ok: false,
      err: '{"InstructionError":[0,{"Custom":6009}]}',
      reason: "Cannot deposit liquidity above the reserve deposit limit",
    });
    await expect(fetchKaminoDepositTx(body)).rejects.toThrow(KaminoDoomedTxError);
    await expect(fetchKaminoDepositTx(body)).rejects.toThrow(
      /above the reserve deposit limit/
    );
  });

  it("deposit: simulate が通れば tx をそのまま返す", async () => {
    mockFetch.mockResolvedValue(txReply);
    expect(await fetchKaminoDepositTx(body)).toEqual({ transaction: "TX_BASE64" });
  });

  it("withdraw: simulate を**呼ばない** (出口を外部 RPC の判定に依存させない)", async () => {
    mockFetch.mockResolvedValue(txReply);
    mockSimulate.mockResolvedValue({ ok: false, err: "would fail" });
    expect(await fetchKaminoWithdrawTx(body)).toEqual({ transaction: "TX_BASE64" });
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it("simulate 自体が throw しても deposit は通す (fail-open)", async () => {
    mockFetch.mockResolvedValue(txReply);
    mockSimulate.mockRejectedValue(new Error("rpc down"));
    expect(await fetchKaminoDepositTx(body)).toEqual({ transaction: "TX_BASE64" });
  });
});
