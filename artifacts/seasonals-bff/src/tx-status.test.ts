/**
 * GET /tx/status — Web (Wallet Standard sign-only) が /tx/submit 後の着地を確かめる read-only route。
 * Helius の getSignatureStatuses を fetch spy で差し替え、要約の対応と入力検証を見る。
 */
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server";
import { _setSleepForTest } from "./clients/helius-rpc";

const SIG = "5".repeat(87);
let app: FastifyInstance;
const savedKey = process.env.HELIUS_API_KEY;

beforeEach(async () => {
  process.env.HELIUS_API_KEY = "test-key";
  _setSleepForTest(async () => undefined); // 5xx の再試行 backoff を待たない
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
  jest.restoreAllMocks();
  _setSleepForTest(null);
  if (savedKey === undefined) delete process.env.HELIUS_API_KEY;
  else process.env.HELIUS_API_KEY = savedKey;
});

function mockRpc(value: unknown) {
  return jest
    .spyOn(global, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { value: [value] } }), { status: 200 }));
}

test("signature の形でなければ 400 で、RPC を呼ばない", async () => {
  const spy = jest.spyOn(global, "fetch");
  const res = await app.inject({ method: "GET", url: "/tx/status?signature=not-a-sig" });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_signature");
  expect(spy).not.toHaveBeenCalled();
});

test("未着地 (null) は pending", async () => {
  const spy = mockRpc(null);
  const res = await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` });
  expect(res.json()).toEqual({ signature: SIG, status: "pending", slot: null, err: null });
  const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
  expect(body.method).toBe("getSignatureStatuses");
  expect(body.params).toEqual([[SIG], { searchTransactionHistory: true }]);
});

test("confirmationStatus をそのまま、err があれば failed", async () => {
  mockRpc({ slot: 123, err: null, confirmationStatus: "confirmed" });
  expect((await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` })).json()).toEqual({
    signature: SIG,
    status: "confirmed",
    slot: 123,
    err: null,
  });
  jest.restoreAllMocks();
  mockRpc({ slot: 124, err: { InstructionError: [0, { Custom: 6001 }] }, confirmationStatus: "confirmed" });
  const failed = (await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` })).json();
  expect(failed.status).toBe("failed");
  expect(failed.err).toContain("6001");
});

test("RPC 失敗は 502 で、応答に key を含めない", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
  const res = await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` });
  expect(res.statusCode).toBe(502);
  expect(res.body).not.toContain("test-key");
});

test("/health は Solana 実行可否を boolean だけで返す", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.json().solana).toEqual({ heliusConfigured: true, executionTarget: "mainnet" });
  expect(res.body).not.toContain("test-key");
});
