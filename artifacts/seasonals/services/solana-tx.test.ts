/**
 * solana-tx — SolanaRoute 13 種 → mobile api builder の対応を固定する。
 *
 * どの builder を呼ぶか / body / 応答 key (`swapTransaction` / `transaction` /
 * `transactions`) の吸収を route ごとに検証する (web buildTx と同じ観点)。
 */
import type { SolanaRoute } from "@workspace/lib/derive/solana-action";

import { buildSolanaTxs, SWAP_EARN_SLIPPAGE_BPS } from "./solana-tx";
import * as api from "./api";

jest.mock("./api", () => ({
  getSwapEarnDepositTx: jest.fn(async () => ({ swapTransaction: "SWAP_DEP" })),
  getSwapEarnWithdrawTx: jest.fn(async () => ({ swapTransaction: "SWAP_WD" })),
  getKaminoDepositTx: jest.fn(async () => ({ transaction: "KAM_DEP" })),
  getKaminoWithdrawTx: jest.fn(async () => ({ transaction: "KAM_WD" })),
  getKaminoVaultDepositTx: jest.fn(async () => ({ transaction: "KV_DEP" })),
  getKaminoVaultWithdrawTx: jest.fn(async () => ({ transaction: "KV_WD" })),
  getMeteoraDepositTxns: jest.fn(async () => ({ transactions: ["MET_1", "MET_2"] })),
  getMeteoraWithdrawTxns: jest.fn(async () => ({ transactions: ["METW_1"] })),
  getOrcaDepositTxns: jest.fn(async () => ({ transactions: ["ORCA_SWAP", "ORCA_OPEN"] })),
  getOrcaWithdrawTxns: jest.fn(async () => ({ transactions: ["ORCAW_1"] })),
  getSaveDepositTxns: jest.fn(async () => ({ transactions: ["SAVE_ATA", "SAVE_DEP"] })),
  getSaveWithdrawTxns: jest.fn(async () => ({ transactions: ["SAVE_WD"] })),
  getExponentRedeemTx: jest.fn(async () => ({ transaction: "EXP_REDEEM" })),
}));

// namespace import は babel interop で `default` 等の非 mock key を含むので builder だけに絞る
const mocked: Record<string, jest.Mock> = Object.fromEntries(
  Object.entries(api as unknown as Record<string, unknown>).filter(
    ([name, fn]) => name.startsWith("get") && jest.isMockFunction(fn)
  )
) as Record<string, jest.Mock>;

const USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
const AMOUNT = "1500000";

type Case = {
  route: SolanaRoute;
  fn: string;
  body: Record<string, unknown>;
  out: string[];
};

const CASES: Case[] = [
  {
    route: { kind: "swap_earn_deposit", shareMint: "SHARE_A" },
    fn: "getSwapEarnDepositTx",
    body: { user: USER, shareMint: "SHARE_A", amount: AMOUNT, slippageBps: 50 },
    out: ["SWAP_DEP"],
  },
  {
    route: { kind: "swap_earn_withdraw", shareMint: "SHARE_B" },
    fn: "getSwapEarnWithdrawTx",
    body: { user: USER, shareMint: "SHARE_B", amount: AMOUNT, slippageBps: 50 },
    out: ["SWAP_WD"],
  },
  {
    route: { kind: "kamino_deposit", reserve: "RESERVE_1" },
    fn: "getKaminoDepositTx",
    body: { user: USER, reserve: "RESERVE_1", amount: AMOUNT },
    out: ["KAM_DEP"],
  },
  {
    route: { kind: "kamino_withdraw", reserve: "RESERVE_2" },
    fn: "getKaminoWithdrawTx",
    body: { user: USER, reserve: "RESERVE_2", amount: AMOUNT },
    out: ["KAM_WD"],
  },
  {
    route: { kind: "kamino_vault_deposit", vault: "VAULT_1" },
    fn: "getKaminoVaultDepositTx",
    body: { user: USER, vault: "VAULT_1", amount: AMOUNT },
    out: ["KV_DEP"],
  },
  {
    route: { kind: "kamino_vault_withdraw", vault: "VAULT_2" },
    fn: "getKaminoVaultWithdrawTx",
    body: { user: USER, vault: "VAULT_2", amount: AMOUNT },
    out: ["KV_WD"],
  },
  {
    route: { kind: "meteora_deposit", poolKey: "MET_POOL" },
    fn: "getMeteoraDepositTxns",
    body: { user: USER, poolKey: "MET_POOL", amount: AMOUNT },
    out: ["MET_1", "MET_2"],
  },
  {
    route: { kind: "meteora_withdraw", position: "MET_POS" },
    fn: "getMeteoraWithdrawTxns",
    body: { user: USER, position: "MET_POS", amount: AMOUNT },
    out: ["METW_1"],
  },
  {
    route: { kind: "orca_deposit", poolKey: "ORCA_POOL" },
    fn: "getOrcaDepositTxns",
    body: { user: USER, poolKey: "ORCA_POOL", amount: AMOUNT },
    out: ["ORCA_SWAP", "ORCA_OPEN"],
  },
  {
    route: { kind: "orca_withdraw", position: "ORCA_POS" },
    fn: "getOrcaWithdrawTxns",
    body: { user: USER, position: "ORCA_POS", amount: AMOUNT },
    out: ["ORCAW_1"],
  },
  {
    route: { kind: "save_deposit", reserve: "SAVE_RESERVE" },
    fn: "getSaveDepositTxns",
    body: { user: USER, reserve: "SAVE_RESERVE", amount: AMOUNT },
    out: ["SAVE_ATA", "SAVE_DEP"],
  },
  {
    route: { kind: "save_withdraw", ctokenMint: "CTOKEN" },
    fn: "getSaveWithdrawTxns",
    body: { user: USER, ctokenMint: "CTOKEN", amount: AMOUNT },
    out: ["SAVE_WD"],
  },
  {
    route: { kind: "exponent_redeem", ptMint: "PT_MINT" },
    fn: "getExponentRedeemTx",
    body: { user: USER, ptMint: "PT_MINT", amount: AMOUNT },
    out: ["EXP_REDEEM"],
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buildSolanaTxs", () => {
  it("13 route kind すべてを網羅している", () => {
    expect(new Set(CASES.map((c) => c.route.kind)).size).toBe(13);
    expect(Object.keys(mocked)).toHaveLength(13);
    expect(SWAP_EARN_SLIPPAGE_BPS).toBe(50);
  });

  it.each(CASES.map((c) => [c.route.kind, c] as const))(
    "%s → 対応する builder 1 本だけを正しい body で呼び、base64 配列を返す",
    async (_kind, c) => {
      const out = await buildSolanaTxs(c.route, USER, AMOUNT);
      expect(out).toEqual(c.out);
      expect(mocked[c.fn]).toHaveBeenCalledTimes(1);
      expect(mocked[c.fn]).toHaveBeenCalledWith(c.body);
      for (const [name, fn] of Object.entries(mocked)) {
        if (name !== c.fn) expect(fn).not.toHaveBeenCalled();
      }
    }
  );

  it("builder の error (plain Error) をそのまま伝搬する", async () => {
    mocked.getKaminoDepositTx!.mockRejectedValueOnce(new Error("reserve_paused"));
    await expect(
      buildSolanaTxs({ kind: "kamino_deposit", reserve: "R" }, USER, AMOUNT)
    ).rejects.toThrow("reserve_paused");
  });

  it("未知の route kind は throw (fail-closed)", async () => {
    await expect(
      buildSolanaTxs({ kind: "nope" } as unknown as SolanaRoute, USER, AMOUNT)
    ).rejects.toThrow("unsupported_solana_route: nope");
  });
});
