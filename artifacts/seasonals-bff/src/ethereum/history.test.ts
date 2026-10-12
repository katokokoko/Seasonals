import { ETH_NATIVE_KEY } from "@workspace/lib/config/eth-assets";

import type { EtherscanTokenTx, EtherscanTx } from "../clients/etherscan";
import type { AavePositionView } from "./aave";
import {
  aaveExtraHoldings,
  chainlinkToUsd8,
  ethDeltasFromEtherscan,
} from "./history";

const ME = "0xAbCdEf0000000000000000000000000000000001";
const me = ME.toLowerCase();
const OTHER = "0x9999999999999999999999999999999999999999";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SPAM = "0xdeadbeef00000000000000000000000000000000";

function tx(over: Partial<EtherscanTx>): EtherscanTx {
  return { hash: "0x1", timeStamp: "1000", from: OTHER, to: me, value: "0", ...over };
}

function tokenTx(over: Partial<EtherscanTokenTx>): EtherscanTokenTx {
  return { ...tx({}), contractAddress: USDC, ...over };
}

const tracked = (key: string) => key === USDC;

describe("ethDeltasFromEtherscan", () => {
  it("credits received ETH", () => {
    const out = ethDeltasFromEtherscan(ME, { txs: [tx({ value: "500" })], internals: [], tokenTxs: [] }, tracked);
    expect(out).toEqual([{ timestamp: 1000, mint: ETH_NATIVE_KEY, amount: 500n }]);
  });

  it("debits value + gas for a successful send", () => {
    const out = ethDeltasFromEtherscan(
      ME,
      { txs: [tx({ from: ME, to: OTHER, value: "1000", gasUsed: "21000", gasPrice: "10" })], internals: [], tokenTxs: [] },
      tracked
    );
    expect(out).toEqual([{ timestamp: 1000, mint: ETH_NATIVE_KEY, amount: -(1000n + 210_000n) }]);
  });

  it("still debits gas (but not value) for a failed send", () => {
    const out = ethDeltasFromEtherscan(
      ME,
      { txs: [tx({ from: ME, to: OTHER, value: "1000", isError: "1", gasUsed: "50000", gasPrice: "2" })], internals: [], tokenTxs: [] },
      tracked
    );
    expect(out).toEqual([{ timestamp: 1000, mint: ETH_NATIVE_KEY, amount: -100_000n }]);
  });

  it("does not credit a failed incoming tx", () => {
    const out = ethDeltasFromEtherscan(ME, { txs: [tx({ value: "5", isError: "1" })], internals: [], tokenTxs: [] }, tracked);
    expect(out).toEqual([]);
  });

  it("nets a self-transfer down to gas", () => {
    const out = ethDeltasFromEtherscan(
      ME,
      { txs: [tx({ from: ME, to: ME, value: "700", gasUsed: "1", gasPrice: "3" })], internals: [], tokenTxs: [] },
      tracked
    );
    const sum = out.reduce((s, d) => s + d.amount, 0n);
    expect(sum).toBe(-3n);
  });

  it("includes internal ETH (e.g. Lido withdrawal claim) and skips failed internals", () => {
    const out = ethDeltasFromEtherscan(
      ME,
      {
        txs: [],
        internals: [tx({ value: "42", timeStamp: "2000" }), tx({ value: "9", isError: "1" })],
        tokenTxs: [],
      },
      tracked
    );
    expect(out).toEqual([{ timestamp: 2000, mint: ETH_NATIVE_KEY, amount: 42n }]);
  });

  it("tracks registry tokens both ways and ignores spam tokens", () => {
    const out = ethDeltasFromEtherscan(
      ME,
      {
        txs: [],
        internals: [],
        tokenTxs: [
          tokenTx({ value: "100", contractAddress: USDC.toUpperCase().replace("0X", "0x") }),
          tokenTx({ from: ME, to: OTHER, value: "40", timeStamp: "3000" }),
          tokenTx({ value: "999999", contractAddress: SPAM }),
        ],
      },
      tracked
    );
    expect(out).toEqual([
      { timestamp: 1000, mint: USDC, amount: 100n },
      { timestamp: 3000, mint: USDC, amount: -40n },
    ]);
  });

  it("skips malformed values instead of guessing", () => {
    const out = ethDeltasFromEtherscan(ME, { txs: [tx({ value: "1e18" })], internals: [], tokenTxs: [] }, tracked);
    expect(out).toEqual([]);
  });
});

describe("chainlinkToUsd8", () => {
  const base = { asset: "ETH" as const, updatedAt: "", source: "chainlink" as const };
  it("scales 8- and 18-decimal answers exactly", () => {
    expect(chainlinkToUsd8({ ...base, answer: "312345678901", decimals: 8, stale: false })).toBe("3123.45678901");
    expect(chainlinkToUsd8({ ...base, answer: "1000200000000000000", decimals: 18, stale: false })).toBe("1.00020000");
  });
  it("refuses stale / missing / non-positive prices", () => {
    expect(chainlinkToUsd8(null)).toBeNull();
    expect(chainlinkToUsd8({ ...base, answer: "100", decimals: 8, stale: true })).toBeNull();
    expect(chainlinkToUsd8({ ...base, answer: "0", decimals: 8, stale: false })).toBeNull();
  });
});

describe("aaveExtraHoldings", () => {
  const view = (net: string | null): AavePositionView => ({
    spokeName: "Main",
    spokeAddress: "0x1",
    totalSuppliedUsd: net,
    totalDebtUsd: "0.00000000",
    netBalanceUsd: net,
    healthFactor: null,
    netApy: null,
    source: "aavekit",
    observedAt: "",
  });
  it("adds positive net balances as lending, outside the history", () => {
    expect(aaveExtraHoldings([view("12.50000000"), view("0.00000000"), view(null)])).toEqual([
      {
        symbol: "Aave V4 · Main",
        protocol_id: "aave",
        category: "lending",
        usd: "12.50000000",
        deposited: true,
        in_history: false,
      },
    ]);
  });
});
