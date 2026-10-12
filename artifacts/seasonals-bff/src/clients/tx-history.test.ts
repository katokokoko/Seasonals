/**
 * Phase C: tx-history facade — backend 選択 (HELIUS_TX_HISTORY_API)、cursor、直近 cache、invalidate
 */
import { heliusTxHistoryApi } from "../flags";
import { fetchEnhancedTransactions, fetchEnhancedTransactionsPage } from "./helius-tx";
import { fetchParsedTxHistoryPage, type ParsedTxItem } from "./helius-parsed-events";
import {
  _clearWalletTxCacheForTest,
  fetchWalletTxPage,
  fetchWalletTxs,
  invalidateWalletTxCacheForWallet,
  walletTxBackend,
} from "./tx-history";

jest.mock("./helius-tx", () => ({
  fetchEnhancedTransactions: jest.fn(),
  fetchEnhancedTransactionsPage: jest.fn(),
}));
jest.mock("./helius-parsed-events", () => ({
  ...jest.requireActual("./helius-parsed-events"),
  fetchParsedTxHistoryPage: jest.fn(),
}));

const W = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";
const enhancedTx = (signature: string) => ({ signature, timestamp: 100, type: "TRANSFER", fee: 5000, accountData: [] });
const parsedItem = (signature: string, blockTime: number | null = 100): ParsedTxItem => ({
  signature,
  parserStatus: "OK",
  parsed: { blockTime, fee: 5000, feePayer: W, summary: { type: "transfer" }, nativeTransfers: [], tokenTransfers: [], instructions: [] },
});

const env = (v: Record<string, string>): NodeJS.ProcessEnv => v as NodeJS.ProcessEnv;

describe("heliusTxHistoryApi flag (unknown / unset → enhanced)", () => {
  it.each([
    [undefined, "enhanced"],
    ["", "enhanced"],
    ["enhanced", "enhanced"],
    ["parsed", "parsed"],
    [" Parsed ", "parsed"],
    ["parse", "enhanced"],
    ["true", "enhanced"],
  ])("%p → %s", (raw, expected) => {
    expect(heliusTxHistoryApi(env(raw === undefined ? {} : { HELIUS_TX_HISTORY_API: raw }))).toBe(expected);
  });
});

describe("tx-history facade", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearWalletTxCacheForTest();
    delete process.env.HELIUS_TX_HISTORY_API;
  });
  afterAll(() => {
    delete process.env.HELIUS_TX_HISTORY_API;
  });

  describe("enhanced (default)", () => {
    it("fetchWalletTxs delegates to the Enhanced client and caches per wallet:limit", async () => {
      (fetchEnhancedTransactions as jest.Mock)
        .mockResolvedValueOnce([enhancedTx("A"), enhancedTx("B")])
        .mockResolvedValueOnce([enhancedTx("A")]);
      expect(walletTxBackend()).toBe("enhanced");
      await expect(fetchWalletTxs(W)).resolves.toEqual([enhancedTx("A"), enhancedTx("B")]);
      await fetchWalletTxs(W);
      expect(fetchEnhancedTransactions).toHaveBeenCalledTimes(1);
      expect(fetchEnhancedTransactions).toHaveBeenCalledWith(W, 50);
      // 別 limit は 50 件の cache を受け取らず自分の分を取る (それも cache される)
      await expect(fetchWalletTxs(W, 1)).resolves.toEqual([enhancedTx("A")]);
      await fetchWalletTxs(W, 1);
      expect(fetchEnhancedTransactions).toHaveBeenCalledTimes(2);
      expect(fetchEnhancedTransactions).toHaveBeenLastCalledWith(W, 1);
    });

    it("fetchWalletTxPage pages with `before` and ends on an empty page", async () => {
      (fetchEnhancedTransactionsPage as jest.Mock)
        .mockResolvedValueOnce([enhancedTx("A"), enhancedTx("B")])
        .mockResolvedValueOnce([]);
      const p1 = await fetchWalletTxPage(W, { limit: 2, timeGte: 1 });
      expect(fetchEnhancedTransactionsPage).toHaveBeenLastCalledWith(W, { limit: 2 }); // timeGte は無視
      expect(p1.nextCursor).toEqual({ limit: 2, beforeSignature: "B" });
      const p2 = await fetchWalletTxPage(W, p1.nextCursor);
      expect(fetchEnhancedTransactionsPage).toHaveBeenLastCalledWith(W, { limit: 2, before: "B" });
      expect(p2).toEqual({ txs: [], scanned: 0 });
    });

    it("afterSignature is parsed-only (throws instead of silently returning everything)", async () => {
      await expect(fetchWalletTxPage(W, { afterSignature: "A" })).rejects.toThrow(/parsed/);
      expect(fetchEnhancedTransactionsPage).not.toHaveBeenCalled();
    });
  });

  describe("parsed", () => {
    beforeEach(() => {
      process.env.HELIUS_TX_HISTORY_API = "parsed";
    });

    it("fetchWalletTxs converts items via toWalletTx (drops ERROR) and caches", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      (fetchParsedTxHistoryPage as jest.Mock).mockResolvedValue({
        items: [parsedItem("A"), { signature: "X", parserStatus: "ERROR" }],
        paginationToken: "t",
      });
      const txs = await fetchWalletTxs(W);
      expect(txs.map((t) => [t.signature, t.type, t.timestamp])).toEqual([["A", "TRANSFER", 100]]);
      await fetchWalletTxs(W);
      expect(fetchParsedTxHistoryPage).toHaveBeenCalledTimes(1);
      expect(fetchParsedTxHistoryPage).toHaveBeenCalledWith(W, { limit: 50 });
      expect(fetchEnhancedTransactions).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("fetchWalletTxPage carries filters with the token; empty page or no token ends", async () => {
      const page = fetchParsedTxHistoryPage as jest.Mock;
      page.mockResolvedValueOnce({ items: [parsedItem("A"), parsedItem("B")], paginationToken: "t1" });
      const p1 = await fetchWalletTxPage(W, { limit: 2, timeGte: 50, afterSignature: "Z" });
      expect(page).toHaveBeenLastCalledWith(W, { limit: 2, afterSignature: "Z", timeGte: 50 });
      expect(p1.scanned).toBe(2);
      expect(p1.nextCursor).toEqual({ limit: 2, paginationToken: "t1", afterSignature: "Z", timeGte: 50 });

      page.mockResolvedValueOnce({ items: [], paginationToken: "t2" });
      const p2 = await fetchWalletTxPage(W, p1.nextCursor);
      expect(page).toHaveBeenLastCalledWith(W, { limit: 2, paginationToken: "t1", afterSignature: "Z", timeGte: 50 });
      expect(p2.nextCursor).toBeUndefined();

      page.mockResolvedValueOnce({ items: [parsedItem("C")] });
      expect((await fetchWalletTxPage(W, { beforeSignature: "B" })).nextCursor).toBeUndefined();
      expect(page).toHaveBeenLastCalledWith(W, { limit: 100, beforeSignature: "B" });
    });

    it("a page whose items were all dropped still continues (cursor kept)", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      (fetchParsedTxHistoryPage as jest.Mock).mockResolvedValueOnce({
        items: [parsedItem("A", null)],
        paginationToken: "t",
      });
      const p = await fetchWalletTxPage(W);
      expect(p.txs).toEqual([]);
      expect(p.nextCursor).toEqual({ limit: 100, paginationToken: "t" });
      warn.mockRestore();
    });
  });

  it("invalidateWalletTxCacheForWallet clears every backend / limit entry of that wallet only", async () => {
    const OTHER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    (fetchEnhancedTransactions as jest.Mock).mockResolvedValue([]);
    (fetchParsedTxHistoryPage as jest.Mock).mockResolvedValue({ items: [] });
    await fetchWalletTxs(W);
    await fetchWalletTxs(W, 10);
    await fetchWalletTxs(OTHER);
    process.env.HELIUS_TX_HISTORY_API = "parsed";
    await fetchWalletTxs(W);
    expect(fetchEnhancedTransactions).toHaveBeenCalledTimes(3);
    expect(fetchParsedTxHistoryPage).toHaveBeenCalledTimes(1);

    invalidateWalletTxCacheForWallet(W);
    await fetchWalletTxs(W);
    expect(fetchParsedTxHistoryPage).toHaveBeenCalledTimes(2);
    delete process.env.HELIUS_TX_HISTORY_API;
    await fetchWalletTxs(W);
    await fetchWalletTxs(W, 10);
    await fetchWalletTxs(OTHER); // 他 wallet の cache は残る
    expect(fetchEnhancedTransactions).toHaveBeenCalledTimes(5);
  });
});
