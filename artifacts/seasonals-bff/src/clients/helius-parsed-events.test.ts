/**
 * Phase C: Parsed Events adapter — quote-before-parse、body、toWalletTx、
 * そして **録画 fixture での Enhanced との parity** (scripts/record-tx-history-fixtures.ts)。
 *
 * parity の比較規則 (2026-10-12 の録画 6QGJNXnC…、14 tx 全件で一致):
 *   - tokenBalanceChanges: (account, mint, userAccount, rawTokenAmount.tokenAmount) の集合が一致
 *     (順序は Enhanced と raw の index 順で違う。Enhanced は差分 0 の token account を入れない →
 *     adapter も入れない)
 *   - source A では全口座の nativeBalanceChange が一致 (Enhanced は変化 0 の口座も 0 で返す)
 *   - timestamp = blockTime
 *   - type は分類体系が違う (Enhanced "TOKEN_MINT" / Parsed "transfer") ので比べない
 *     (consumer は metadata.tx_type に情報として載せるだけ)
 */
import enhancedFixture from "../__fixtures__/helius/enhanced.6QGJNXnC.json";
import parsedFixture from "../__fixtures__/helius/parsed.6QGJNXnC.json";

import type { HeliusAccountData, HeliusEnhancedTx } from "./helius-tx";
import {
  _resetParsedEventsDropStatsForTest,
  accountDataFromTransfers,
  buildParsedEventsBody,
  fetchParsedTxHistoryPage,
  parsedEventsDropStats,
  quoteLargeNumbers,
  toWalletTx,
  type ParsedTxItem,
} from "./helius-parsed-events";
import { _setSleepForTest } from "./helius-limiter";

const WALLET = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";
const enhanced = enhancedFixture as unknown as HeliusEnhancedTx[];
const parsedItems = (parsedFixture as unknown as { data: ParsedTxItem[] }).data;

function tokenKeys(tx: HeliusEnhancedTx): string[] {
  return (tx.accountData ?? [])
    .flatMap((a) =>
      (a.tokenBalanceChanges ?? []).map(
        (c) => `${a.account}|${c.mint}|${c.userAccount}|${c.rawTokenAmount.tokenAmount}`
      )
    )
    .sort();
}

function nativeMap(tx: HeliusEnhancedTx): Record<string, number | undefined> {
  return Object.fromEntries((tx.accountData ?? []).map((a) => [a.account, a.nativeBalanceChange]));
}

describe("parity: toWalletTx(parsed) vs Enhanced (recorded fixtures)", () => {
  const bySig = new Map(enhanced.map((t) => [t.signature, t] as const));
  const shared = parsedItems.filter((p) => bySig.has(p.signature));

  it("fixtures overlap and every item has raw meta (source A)", () => {
    expect(shared.length).toBeGreaterThanOrEqual(10);
    for (const p of shared) {
      expect(Array.isArray(p.rawTransaction?.meta?.preTokenBalances)).toBe(true);
    }
  });

  it.each(shared.map((p) => [p.signature.slice(0, 8), p] as const))(
    "%s: tokenBalanceChanges / nativeBalanceChange / timestamp match",
    (_sig, item) => {
      const ours = toWalletTx(item, WALLET);
      const theirs = bySig.get(item.signature)!;
      expect(ours).not.toBeNull();
      expect(ours!.timestamp).toBe(theirs.timestamp);
      expect(tokenKeys(ours!)).toEqual(tokenKeys(theirs));
      expect(nativeMap(ours!)).toEqual(nativeMap(theirs));
      expect(ours!.fee).toBe(theirs.fee);
    }
  );

  it("source B keeps the 'touched account' set and the wallet's token deltas (non-WSOL)", () => {
    for (const item of shared) {
      const theirs = bySig.get(item.signature)!;
      const b = accountDataFromTransfers(item.parsed!, WALLET);
      const touched = new Set(b.map((a) => a.account));
      // B は instruction の rawAccounts を全部入れる → Enhanced の wallet 口座は含まれる
      expect(touched.has(WALLET) || !theirs.accountData?.some((a) => a.account === WALLET)).toBe(true);
      const walletKeys = (rows: HeliusAccountData[]) =>
        rows
          .flatMap((a) => (a.tokenBalanceChanges ?? []).map((c) => ({ a: a.account, c })))
          .filter(({ c }) => c.userAccount === WALLET && c.mint !== "So11111111111111111111111111111111111111112")
          .map(({ a, c }) => `${a}|${c.mint}|${c.rawTokenAmount.tokenAmount}`)
          .sort();
      expect(walletKeys(b)).toEqual(walletKeys(theirs.accountData ?? []));
      // position account の rent は B では出さない (wallet 以外に nativeBalanceChange 無し)
      expect(b.filter((a) => a.account !== WALLET && a.nativeBalanceChange !== undefined)).toEqual([]);
    }
  });
});

describe("quoteLargeNumbers (§4.5)", () => {
  it("quotes rawTokenAmount / nativeTransfers.amount / pre・postBalances above 2^53 without precision loss", () => {
    const big = "9007199254740993"; // 2^53 + 1 (Number では ...992 になる)
    const text = `{"data":[{"signature":"s","parserStatus":"OK","parsed":{"blockTime":1,"fee":5000,"feePayer":"X",
      "nativeTransfers":[{"fromUserAccount":"X","toUserAccount":"W","amount":${big}}],
      "tokenTransfers":[{"fromUserAccount":"X","toUserAccount":"W","fromTokenAccount":"XA","toTokenAccount":"WA","rawTokenAmount":${big},"decimals":6,"mint":"M"}],
      "summary":{"type":"transfer","parsedData":{"amount":1.5,"other":{"amount":3}}},"instructions":[]},
      "rawTransaction":{"meta":{"preBalances":[1, ${big}],"postBalances":[2,3],"fee":5000}}}]}`;
    const out = JSON.parse(quoteLargeNumbers(text));
    const p = out.data[0].parsed;
    expect(p.nativeTransfers[0].amount).toBe(big);
    expect(p.tokenTransfers[0].rawTokenAmount).toBe(big);
    expect(out.data[0].rawTransaction.meta.preBalances).toEqual(["1", big]);
    expect(out.data[0].rawTransaction.meta.postBalances).toEqual(["2", "3"]);
    // 対象外 / 小数は触らない (JSON を壊さない)
    expect(p.summary.parsedData.amount).toBe(1.5);
    expect(p.fee).toBe(5000);

    const tx = toWalletTx(out.data[0] as ParsedTxItem, "W")!;
    const wa = tx.accountData!.find((a) => a.account === "WA")!;
    expect(wa.tokenBalanceChanges![0]!.rawTokenAmount.tokenAmount).toBe(big);
    // source B の native: wallet の受取 2^53+1 は safe integer を超える → 省略 (不明、誤った数値は出さない)
    expect(tx.accountData!.find((a) => a.account === "W")!.nativeBalanceChange).toBeUndefined();
  });

  it("rawTokenAmount is quoted only inside tokenTransfers (logMessages / other sections untouched)", () => {
    const big = "9007199254740993";
    const log = `Program log: {\\"rawTokenAmount\\":${big}} amount ${big}`;
    const text = `{"data":[{"signature":"s","parserStatus":"OK","parsed":{"blockTime":1,
      "tokenTransfers":[{"fromTokenAccount":"XA","toTokenAccount":"WA","rawTokenAmount":${big},"decimals":6,"mint":"M"}],
      "summary":{"type":"transfer","parsedData":{"rawTokenAmount":7}},"instructions":[]},
      "rawTransaction":{"meta":{"logMessages":["${log}"],"innerRawTokenAmount":{"rawTokenAmount":8}}}}]}`;
    const quoted = quoteLargeNumbers(text);
    const out = JSON.parse(quoted);
    expect(out.data[0].parsed.tokenTransfers[0].rawTokenAmount).toBe(big);
    expect(out.data[0].parsed.summary.parsedData.rawTokenAmount).toBe(7);
    expect(out.data[0].rawTransaction.meta.innerRawTokenAmount.rawTokenAmount).toBe(8);
    expect(out.data[0].rawTransaction.meta.logMessages[0]).toBe(JSON.parse(`"${log}"`));
    // log の本文は 1 文字も変わらない
    expect(quoted).toContain(`"logMessages":["${log}"]`);
  });

  it("source A token delta keeps full precision", () => {
    const item: ParsedTxItem = {
      signature: "s",
      parserStatus: "OK",
      parsed: { blockTime: 10, fee: 5000, summary: { type: "swap" } },
      rawTransaction: {
        meta: {
          preBalances: ["100", "0"],
          postBalances: ["95", "0"],
          preTokenBalances: [
            { accountIndex: 1, mint: "M", owner: "W", uiTokenAmount: { amount: "1", decimals: 6 } },
          ],
          postTokenBalances: [
            { accountIndex: 1, mint: "M", owner: "W", uiTokenAmount: { amount: "18014398509481985", decimals: 6 } },
          ],
        },
        transaction: { message: { accountKeys: ["W", "WA"] } },
      },
    };
    const tx = toWalletTx(item)!;
    expect(tx.type).toBe("SWAP");
    expect(tx.accountData).toEqual([
      { account: "W", nativeBalanceChange: -5, tokenBalanceChanges: [] },
      {
        account: "WA",
        nativeBalanceChange: 0,
        tokenBalanceChanges: [
          { mint: "M", userAccount: "W", tokenAccount: "WA", rawTokenAmount: { tokenAmount: "18014398509481984", decimals: 6 } },
        ],
      },
    ]);
  });
});

describe("toWalletTx drops", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    _resetParsedEventsDropStatsForTest();
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("parserStatus ERROR and null blockTime → null, counted", () => {
    expect(toWalletTx({ signature: "a", parserStatus: "ERROR", parserError: "x" })).toBeNull();
    expect(toWalletTx({ signature: "b", parserStatus: "OK", parsed: { blockTime: null } })).toBeNull();
    expect(toWalletTx({ signature: "c", parserStatus: "OK", parsed: { blockTime: null } })).toBeNull();
    expect(parsedEventsDropStats()).toEqual({ parserError: 1, noBlockTime: 2 });
    expect(warn).toHaveBeenCalledTimes(2); // 種類ごとに 1 回だけ
  });
});

describe("fetchParsedTxHistoryPage", () => {
  const realKey = process.env.HELIUS_API_KEY;
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    process.env.HELIUS_API_KEY = "SECRET";
    _setSleepForTest(async () => undefined);
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    _setSleepForTest(null);
    if (realKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = realKey;
  });

  it("POSTs only defined fields, key only in the query, and quotes numbers before parse", async () => {
    fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        `{"data":[{"signature":"s","parserStatus":"OK","parsed":{"blockTime":1,"tokenTransfers":[{"rawTokenAmount":9007199254740993,"mint":"M","decimals":0,"fromUserAccount":null,"toUserAccount":"W","fromTokenAccount":null,"toTokenAccount":"WA"}]}}],"paginationToken":"t:1"}`,
        { status: 200 }
      )
    );
    const page = await fetchParsedTxHistoryPage("W", { afterSignature: "A", timeGte: 100, limit: 50 });
    expect(page.paginationToken).toBe("t:1");
    expect(page.items[0]!.parsed!.tokenTransfers![0]!.rawTokenAmount).toBe("9007199254740993");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/v1/parsed-events/transaction-history?api-key=SECRET");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ address: "W", limit: 50, includeRawTransaction: true, afterSignature: "A", time: { gte: 100 } });
    expect(String((init as RequestInit).body)).not.toContain("SECRET");
  });

  it("empty page without token = end", async () => {
    fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`{"data":[]}`, { status: 200 }));
    await expect(fetchParsedTxHistoryPage("W")).resolves.toEqual({ items: [] });
  });

  it("retries 429 then succeeds; HTTP errors never leak the key", async () => {
    fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(new Response(`{"data":[]}`, { status: 200 }));
    await expect(fetchParsedTxHistoryPage("W")).resolves.toEqual({ items: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockReset().mockResolvedValue(new Response(`{"error":"invalid request payload"}`, { status: 400 }));
    await expect(fetchParsedTxHistoryPage("W")).rejects.toThrow(/parsed-events HTTP 400/);
    await expect(fetchParsedTxHistoryPage("W")).rejects.not.toThrow(/SECRET/);
  });

  it("buildParsedEventsBody clamps limit and omits unset fields", () => {
    expect(buildParsedEventsBody("W", { limit: 500, includeRaw: false })).toEqual({
      address: "W",
      limit: 100,
      includeRawTransaction: false,
    });
  });
});
