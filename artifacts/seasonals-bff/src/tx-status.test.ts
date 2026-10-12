/**
 * GET /tx/status — Web (Wallet Standard sign-only) が /tx/submit 後の着地を確かめる read-only route。
 * Helius の getSignatureStatuses / getBlockHeight を fetch spy で差し替え、要約の対応と入力検証を見る。
 * sendTransactionViaHelius の maxRetries (既定では送らない) もここで見る。
 */
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server";
import { _setSleepForTest, BlockhashExpiredError, sendTransactionViaHelius, SUBMIT_BLOCKHASH_RETRIES } from "./clients/helius-rpc";

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

const HEIGHT = 300_000_123;

function rpcBody(init: RequestInit | undefined): { method: string; params: unknown[] } {
  return JSON.parse(String(init?.body));
}

/**
 * getSignatureStatuses の後、pending の時だけ getBlockHeight が飛ぶ。method で応答を振り分ける。
 * height が "fail" なら getBlockHeight だけ 500 を返す (status は成功させる)
 */
function mockRpc(value: unknown, height: number | "fail" = HEIGHT) {
  return jest.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
    const { method } = rpcBody(init);
    if (method === "getBlockHeight") {
      if (height === "fail") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: height }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { value: [value] } }), { status: 200 });
  });
}

function statusCall(spy: jest.SpyInstance) {
  const call = spy.mock.calls.find((c) => rpcBody(c[1] as RequestInit).method === "getSignatureStatuses");
  return rpcBody(call![1] as RequestInit);
}

test("signature の形でなければ 400 で、RPC を呼ばない", async () => {
  const spy = jest.spyOn(global, "fetch");
  const res = await app.inject({ method: "GET", url: "/tx/status?signature=not-a-sig" });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_signature");
  expect(spy).not.toHaveBeenCalled();
});

test("未着地 (null) は pending で、続けて block height を引く (2 call)", async () => {
  const spy = mockRpc(null);
  const res = await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` });
  expect(res.json()).toEqual({ signature: SIG, status: "pending", slot: null, err: null, blockHeight: HEIGHT });
  expect(statusCall(spy).params).toEqual([[SIG], { searchTransactionHistory: true }]);
  // status が先、height はその後 (confirmed)
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls.map((c) => rpcBody(c[1] as RequestInit).method)).toEqual([
    "getSignatureStatuses",
    "getBlockHeight",
  ]);
  expect(rpcBody(spy.mock.calls[1]![1] as RequestInit).params).toEqual([{ commitment: "confirmed" }]);
});

test("着地済み (confirmed) は height を引かず blockHeight: null (1 call)、err があれば failed", async () => {
  const spy = mockRpc({ slot: 123, err: null, confirmationStatus: "confirmed" });
  expect((await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` })).json()).toEqual({
    signature: SIG,
    status: "confirmed",
    slot: 123,
    err: null,
    blockHeight: null,
  });
  expect(spy).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
  const failedSpy = mockRpc({ slot: 124, err: { InstructionError: [0, { Custom: 6001 }] }, confirmationStatus: "confirmed" });
  const failed = (await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` })).json();
  expect(failed.status).toBe("failed");
  expect(failed.err).toContain("6001");
  expect(failed.blockHeight).toBeNull();
  expect(failedSpy).toHaveBeenCalledTimes(1);
});

test("pending で block height の取得が失敗しても blockHeight: null で、status はそのまま返す", async () => {
  mockRpc(null, "fail");
  const res = await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ signature: SIG, status: "pending", slot: null, err: null, blockHeight: null });
});

test("RPC 失敗は 502 で、応答に key を含めない", async () => {
  // call ごとに新しい Response を返す (Response の body は 1 度しか読めない)
  jest.spyOn(global, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
  const res = await app.inject({ method: "GET", url: `/tx/status?signature=${SIG}` });
  expect(res.statusCode).toBe(502);
  expect(res.body).not.toContain("test-key");
});

test("/health は Solana 実行可否を boolean だけで返す", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.json().solana).toEqual({ heliusConfigured: true, executionTarget: "mainnet" });
  expect(res.body).not.toContain("test-key");
});

describe("sendTransactionViaHelius の maxRetries", () => {
  function mockSend() {
    return jest
      .spyOn(global, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: SIG }), { status: 200 }));
  }
  function sendOpts(spy: jest.SpyInstance): Record<string, unknown> {
    const body = rpcBody(spy.mock.calls[0]![1] as RequestInit);
    expect(body.method).toBe("sendTransaction");
    return body.params[1] as Record<string, unknown>;
  }

  test("既定では maxRetries を送らない (RPC node が blockhash 失効まで rebroadcast する)", async () => {
    const spy = mockSend();
    await expect(sendTransactionViaHelius("AAAA")).resolves.toBe(SIG);
    const opts = sendOpts(spy);
    expect(opts).not.toHaveProperty("maxRetries");
    expect(opts).toMatchObject({ encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" });
  });

  // 2026-10-13: Seed Vault 署名の tx が preflight で "Blockhash not found" (-32002) になった件
  const { Keypair, TransactionMessage, VersionedTransaction } = jest.requireActual("@solana/web3.js") as typeof import("@solana/web3.js");
  const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
  function signedTxB64(): string {
    const payer = Keypair.generate();
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BLOCKHASH, instructions: [] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    return Buffer.from(tx.serialize()).toString("base64");
  }
  const notFound = () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32002, message: "Transaction simulation failed: Blockhash not found" } }), { status: 200 });
  const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: SIG }), { status: 200 });
  const valid = (v: boolean) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { context: { slot: 1 }, value: v } }), { status: 200 });
  function scripted(...responses: Array<() => Response>) {
    let i = 0;
    return jest.spyOn(global, "fetch").mockImplementation(async () => (responses[Math.min(i++, responses.length - 1)]!)());
  }
  function methods(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map((c) => rpcBody(c[1] as RequestInit).method as string);
  }

  test("Blockhash not found でも blockhash が有効なら待って再送し signature を返す", async () => {
    const spy = scripted(notFound, () => valid(true), ok);
    await expect(sendTransactionViaHelius(signedTxB64())).resolves.toBe(SIG);
    expect(methods(spy)).toEqual(["sendTransaction", "isBlockhashValid", "sendTransaction"]);
    expect(rpcBody(spy.mock.calls[1]![1] as RequestInit).params).toEqual([BLOCKHASH, { commitment: "processed" }]);
  });

  test("blockhash が失効していれば BlockhashExpiredError (再送しない)、/tx/submit は 409 blockhash_expired", async () => {
    let spy = scripted(notFound, () => valid(false));
    await expect(sendTransactionViaHelius(signedTxB64())).rejects.toBeInstanceOf(BlockhashExpiredError);
    expect(methods(spy)).toEqual(["sendTransaction", "isBlockhashValid"]);
    spy.mockRestore();

    spy = scripted(notFound, () => valid(false));
    const res = await app.inject({ method: "POST", url: "/tx/submit", payload: { signedTx: signedTxB64() } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "blockhash_expired", message: expect.stringMatching(/Nothing moved/) });
  });

  test("有効なのに見つからないままなら再送は上限で打ち切り、元の error を返す", async () => {
    // send → isBlockhashValid を交互に返す (上限 + 1 回目の send まで)
    const seq = Array.from({ length: SUBMIT_BLOCKHASH_RETRIES + 1 }, () => [notFound, () => valid(true)]).flat();
    const spy = scripted(...seq);
    await expect(sendTransactionViaHelius(signedTxB64())).rejects.toThrow(/Blockhash not found/);
    expect(methods(spy).filter((m) => m === "sendTransaction")).toHaveLength(SUBMIT_BLOCKHASH_RETRIES + 1);
  });

  test("skipPreflight の送信と他の error は再送しない", async () => {
    let spy = scripted(notFound);
    await expect(sendTransactionViaHelius(signedTxB64(), { skipPreflight: true })).rejects.toThrow(/Blockhash not found/);
    expect(methods(spy)).toEqual(["sendTransaction"]);
    spy.mockRestore();
    spy = scripted(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32002, message: "Transaction simulation failed: insufficient funds" } }), { status: 200 }));
    await expect(sendTransactionViaHelius(signedTxB64())).rejects.toThrow(/insufficient funds/);
    expect(methods(spy)).toEqual(["sendTransaction"]);
  });

  test("明示した maxRetries はそのまま渡す", async () => {
    const spy = mockSend();
    await sendTransactionViaHelius("AAAA", { maxRetries: 5, skipPreflight: true });
    expect(sendOpts(spy)).toMatchObject({ maxRetries: 5, skipPreflight: true, preflightCommitment: "confirmed" });
  });
});
