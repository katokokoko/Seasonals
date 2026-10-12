/**
 * helius-rpc — read-only RPC の retry (Helius 429 対策)。
 *
 * - 429 / 5xx は backoff 再試行 (最大 3 attempt)、Retry-After を尊重
 * - 429 以外の 4xx と JSON-RPC error は即失敗 (再試行しない)
 * - sendTransactionViaHelius (broadcast) は再試行しない
 * - error message に api-key を含めない
 */
import {
  _setSleepForTest,
  getMultipleAccountsBase64,
  sendTransactionViaHelius,
  simulateUnsignedTx,
} from "./helius-rpc";

const KEY = "test-key";
const PUBKEY = "So11111111111111111111111111111111111111112";

const okAccounts = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "x",
      result: { value: [{ owner: "Owner1111", data: [Buffer.from("hi").toString("base64"), "base64"] }] },
    }),
    { status: 200 }
  );
const tooMany = (headers?: Record<string, string>) =>
  new Response("Too Many Requests", { status: 429, ...(headers ? { headers } : {}) });

let prevKey: string | undefined;
let sleeps: number[];
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  prevKey = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = KEY;
  sleeps = [];
  _setSleepForTest(async (ms) => {
    sleeps.push(ms);
  });
  fetchSpy = jest.spyOn(global, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  _setSleepForTest(null);
  if (prevKey === undefined) delete process.env.HELIUS_API_KEY;
  else process.env.HELIUS_API_KEY = prevKey;
});

async function expectRejectWithoutKey(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e as Error
  );
  expect(err).toBeInstanceOf(Error);
  expect(err.message).not.toContain(KEY);
  return err;
}

test("429 → 200: 再試行して 200 の結果を返す", async () => {
  fetchSpy.mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(okAccounts());
  const out = await getMultipleAccountsBase64([PUBKEY]);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(out).toEqual([{ owner: "Owner1111", data: Buffer.from("hi") }]);
  expect(sleeps).toEqual([500]);
});

test("429 が 3 連続: reject、fetch は 3 回、待ちは 500 → 1000", async () => {
  fetchSpy.mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany());
  const err = await expectRejectWithoutKey(getMultipleAccountsBase64([PUBKEY]));
  expect(err.message).toMatch(/HTTP 429/);
  expect(fetchSpy).toHaveBeenCalledTimes(3);
  expect(sleeps).toEqual([500, 1000]);
});

test("5xx も再試行する", async () => {
  fetchSpy.mockResolvedValueOnce(new Response("bad gateway", { status: 502 })).mockResolvedValueOnce(okAccounts());
  await expect(getMultipleAccountsBase64([PUBKEY])).resolves.toHaveLength(1);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("network error も再試行し、message に key を出さない", async () => {
  fetchSpy
    .mockRejectedValueOnce(new TypeError(`fetch failed https://mainnet.helius-rpc.com/?api-key=${KEY}`))
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockRejectedValueOnce(new TypeError(`fetch failed ?api-key=${KEY}`));
  const err = await expectRejectWithoutKey(getMultipleAccountsBase64([PUBKEY]));
  expect(err.message).toMatch(/network error/);
  expect(fetchSpy).toHaveBeenCalledTimes(3);
});

test("HTTP 400: 再試行せず 1 回で reject", async () => {
  fetchSpy.mockResolvedValue(new Response("bad request", { status: 400 }));
  const err = await expectRejectWithoutKey(getMultipleAccountsBase64([PUBKEY]));
  expect(err.message).toMatch(/HTTP 400/);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(sleeps).toEqual([]);
});

test("JSON-RPC error: 再試行せず 1 回で reject", async () => {
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32602, message: "Invalid params" } }), {
      status: 200,
    })
  );
  const err = await expectRejectWithoutKey(getMultipleAccountsBase64([PUBKEY]));
  expect(err.message).toMatch(/RPC error -32602: Invalid params/);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("sendTransactionViaHelius は 429 でも再送しない (1 回のみ)", async () => {
  fetchSpy.mockResolvedValue(tooMany());
  const err = await expectRejectWithoutKey(sendTransactionViaHelius("AAAA"));
  expect(err.message).toMatch(/HTTP 429/);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(sleeps).toEqual([]);
});

test("Retry-After (秒) が backoff より長ければそちらを待つ", async () => {
  fetchSpy.mockResolvedValueOnce(tooMany({ "retry-after": "2" })).mockResolvedValueOnce(okAccounts());
  await getMultipleAccountsBase64([PUBKEY]);
  expect(sleeps).toEqual([2000]);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("simulateUnsignedTx: 429 は再試行、simulation の失敗は再試行しない", async () => {
  fetchSpy.mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "x",
        result: { value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: Cannot deposit"] } },
      }),
      { status: 200 }
    )
  );
  const out = await simulateUnsignedTx("AAAA");
  expect(out).toEqual({ ok: false, err: JSON.stringify({ InstructionError: [0, { Custom: 1 }] }), reason: "Cannot deposit" });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("simulateUnsignedTx: 429 が尽きたら従来どおり fail-open", async () => {
  fetchSpy.mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany());
  await expect(simulateUnsignedTx("AAAA")).resolves.toEqual({ ok: true });
  expect(fetchSpy).toHaveBeenCalledTimes(3);
});
