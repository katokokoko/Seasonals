/**
 * api — BFF error の伝搬 (Phase 8.74)
 *
 * tx を取る関数は、BFF が返す machine-readable な `error` code を
 * `BffError.code` として持ち回る。呼び手 (ActionModal) が
 * **「失敗」と「意図的な拒否」を区別**するために必要。
 */
import { BffError, getSwapEarnDepositTx } from "./api";

const originalFetch = global.fetch;

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  global.fetch = originalFetch;
});

const INPUT = {
  user: "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r",
  shareMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  amount: "1000000000",
};

describe("getSwapEarnDepositTx — 409 の扱い", () => {
  it("BFF の message を投げ、code を保持する", async () => {
    global.fetch = jest.fn(async () =>
      mockResponse(409, {
        error: "fair_value_blocked",
        reason: "fair_value_deviation",
        message: "Quote is 6.20% below jitoSOL redemption value (limit 2.00%).",
      })
    ) as unknown as typeof fetch;

    await expect(getSwapEarnDepositTx(INPUT)).rejects.toThrow(
      /6\.20% below jitoSOL/
    );
    // code が拾えないと「拒否」を「失敗」として見せてしまう
    await expect(getSwapEarnDepositTx(INPUT)).rejects.toMatchObject({
      code: "fair_value_blocked",
    });
  });

  it("message が無い旧応答は error を message に使う (degrade)", async () => {
    global.fetch = jest.fn(async () =>
      mockResponse(409, { error: "oracle_blocked" })
    ) as unknown as typeof fetch;

    const err = await getSwapEarnDepositTx(INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(BffError);
    expect(err.message).toBe("oracle_blocked");
    expect(err.code).toBe("oracle_blocked");
  });

  it("error も message も無ければ HTTP status で埋める / code は undefined", async () => {
    global.fetch = jest.fn(async () =>
      mockResponse(502, {})
    ) as unknown as typeof fetch;

    const err = await getSwapEarnDepositTx(INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(BffError);
    expect(err.message).toContain("502");
    expect(err.code).toBeUndefined();
  });

  it("成功時は body をそのまま返す", async () => {
    global.fetch = jest.fn(async () =>
      mockResponse(200, { swapTransaction: "BASE64", outputMint: "X" })
    ) as unknown as typeof fetch;

    await expect(getSwapEarnDepositTx(INPUT)).resolves.toMatchObject({
      swapTransaction: "BASE64",
    });
  });
});
