/**
 * buildSolanaTxs — route ごとの builder 応答を lib `BuiltTxs` ({ txs, lastValidBlockHeight }) に揃える。
 * swap-earn だけが lastValidBlockHeight を返す (着地確認で expired を確定できる、lib tx-confirm)。
 */
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import type { BuiltTxs } from "@workspace/lib/derive/tx-confirm";
import { b64, installFakeBff } from "../testing/fakeBff";
import { buildSolanaTxs } from "./buildTx";

const USER = "So11111111111111111111111111111111111111112";
const jlUsdc = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC")!;
const save = SAVE_MARKETS[0]!;

test("swap-earn deposit は tx 1 本と lastValidBlockHeight を返す", async () => {
  const calls = installFakeBff((path) =>
    path === "/protocols/swap-earn/deposit-tx"
      ? { json: { swapTransaction: b64([1]), lastValidBlockHeight: 123456, outAmount: "1", outputMint: "x", quote: {} } }
      : undefined
  );
  await expect(buildSolanaTxs({ kind: "swap_earn_deposit", shareMint: jlUsdc.share_mint }, USER, "1500000")).resolves.toEqual({
    txs: [b64([1])],
    lastValidBlockHeight: 123456,
  });
  expect(calls[0]!.body).toMatchObject({ user: USER, shareMint: jlUsdc.share_mint, amount: "1500000" });
});

test("funding deposit (USDC → jlJupUSD) は inputMint を body に載せる。underlying 払いは載せない", async () => {
  const jupUsd = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlJupUSD")!;
  const usdc = jupUsd.funding![0]!;
  const calls = installFakeBff((path) =>
    path === "/protocols/swap-earn/deposit-tx"
      ? { json: { swapTransaction: b64([9]), lastValidBlockHeight: 42, outAmount: "1", outputMint: jupUsd.share_mint, quote: {}, inputMint: usdc.mint } }
      : undefined
  );
  await expect(
    buildSolanaTxs({ kind: "swap_earn_deposit", shareMint: jupUsd.share_mint, inputMint: usdc.mint }, USER, "2000000")
  ).resolves.toEqual({ txs: [b64([9])], lastValidBlockHeight: 42 });
  expect(calls[0]!.body).toEqual({ slippageBps: 50, user: USER, shareMint: jupUsd.share_mint, amount: "2000000", inputMint: usdc.mint });

  await buildSolanaTxs({ kind: "swap_earn_deposit", shareMint: jupUsd.share_mint }, USER, "1");
  expect(calls[1]!.body).not.toHaveProperty("inputMint");
});

test("swap-earn withdraw も lastValidBlockHeight を返す", async () => {
  installFakeBff((path) =>
    path === "/protocols/swap-earn/withdraw-tx"
      ? { json: { swapTransaction: b64([2]), lastValidBlockHeight: 7, outAmount: "1", outputMint: "x", quote: {} } }
      : undefined
  );
  await expect(buildSolanaTxs({ kind: "swap_earn_withdraw", shareMint: jlUsdc.share_mint }, USER, "1")).resolves.toEqual({
    txs: [b64([2])],
    lastValidBlockHeight: 7,
  });
});

test("swap-earn 以外 (Save の複数 tx) は lastValidBlockHeight = null", async () => {
  installFakeBff((path) =>
    path === "/protocols/save/deposit-tx"
      ? { json: { transactions: [b64([1]), b64([2])], reserve: save.reserve, ctokenMint: save.ctoken_mint, underlyingMint: "x" } }
      : undefined
  );
  // useSignAndSubmit.run が受ける lib の型そのもの (local な shape を持たない、CLAUDE.md §1)
  const built: BuiltTxs = await buildSolanaTxs({ kind: "save_deposit", reserve: save.reserve }, USER, "100000");
  expect(built).toEqual({ txs: [b64([1]), b64([2])], lastValidBlockHeight: null });
});
