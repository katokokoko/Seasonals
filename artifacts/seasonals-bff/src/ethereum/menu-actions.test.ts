import { encodeFunctionData, getAddress } from "viem";
import { sUSDeAbi, withdrawalQueueAbi } from "./abis";
import { ETHENA, LIDO } from "./config";
import { ETHENA_PRODUCT_ID, LIDO_PRODUCT_ID } from "./holdings";
import { buildMenuPlan, parseMenuAmount, splitWithdrawal } from "./menu-actions";
import { PlanError } from "./plans";

const OWNER = "0x00000000000000000000000000000000000000Aa" as const;
const E18 = 10n ** 18n;

/** readContract / getBalance / call を関数名で返す最小 client */
function fakeClient(reads: Record<string, unknown>, balance = 0n) {
  return {
    readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
      const key = `${address.toLowerCase()}:${functionName}`;
      if (key in reads) return reads[key];
      if (functionName in reads) return reads[functionName];
      throw new Error(`unexpected read ${key}`);
    },
    getBalance: async () => balance,
    call: async () => ({ data: "0x" }),
  } as never;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof PlanError ? e.code : String(e);
  }
};

test("amount parsing rejects zero, junk and too many decimals", () => {
  expect(parseMenuAmount("1.5", 18)).toBe(15n * 10n ** 17n);
  for (const bad of ["0", "0.0", "-1", "1e3", "abc", "1.1234567"]) {
    expect(() => parseMenuAmount(bad, 6)).toThrow(PlanError);
  }
});

test("Lido requests are split at the per-request cap without changing the total", () => {
  const parts = splitWithdrawal(2500n, 100n, 1000n);
  expect(parts).toEqual([1000n, 1000n, 500n]);
  const tail = splitWithdrawal(2050n, 100n, 1000n);
  expect(tail.reduce((a, b) => a + b, 0n)).toBe(2050n);
  expect(tail.every((p) => p >= 100n && p <= 1000n)).toBe(true);
  expect(() => splitWithdrawal(99n, 100n, 1000n)).toThrow(PlanError);
});

test("Lido stake refuses more ETH than the address holds", async () => {
  const client = fakeClient({}, 1n * E18);
  expect(await code(buildMenuPlan({ owner: OWNER, productId: LIDO_PRODUCT_ID, action: "deposit", amount: "2" }, { client }))).toBe("insufficient_balance");
});

test("Lido withdrawal approves the queue then requests, split at 1000 stETH", async () => {
  const st = LIDO.stETH.toLowerCase();
  const client = fakeClient({
    [`${st}:balanceOf`]: 1500n * E18,
    [`${st}:allowance`]: 0n,
    MIN_STETH_WITHDRAWAL_AMOUNT: 100n,
    MAX_STETH_WITHDRAWAL_AMOUNT: 1000n * E18,
  });
  const plan = await buildMenuPlan({ owner: OWNER, productId: LIDO_PRODUCT_ID, action: "withdraw", amount: "1500" }, { client });
  expect(plan.steps.map((s) => s.kind)).toEqual(["approval", "call"]);
  expect(plan.steps[1]!.to).toBe(LIDO.withdrawalQueue);
  expect(plan.steps[1]!.data).toBe(
    encodeFunctionData({ abi: withdrawalQueueAbi, functionName: "requestWithdrawals", args: [[1000n * E18, 500n * E18], getAddress(OWNER.toLowerCase())] })
  );
  expect(plan.broadcast).toBe(false);
});

test("Ethena withdraw starts a cooldown and warns when one is already running", async () => {
  const s = ETHENA.sUSDe.toLowerCase();
  const client = fakeClient({
    [`${s}:balanceOf`]: 10n * E18,
    cooldownDuration: 604800,
    cooldowns: [1_900_000_000n, 5n * E18] as const,
    convertToAssets: 12n * E18,
  });
  const plan = await buildMenuPlan({ owner: OWNER, productId: ETHENA_PRODUCT_ID, action: "withdraw", amount: "10" }, { client });
  expect(plan.actionType).toBe("ethena_cooldown");
  expect(plan.steps[0]!.data).toBe(encodeFunctionData({ abi: sUSDeAbi, functionName: "cooldownShares", args: [10n * E18] }));
  expect(plan.warnings?.some((w) => w.includes("restarts the timer"))).toBe(true);
});

test("unknown products are not planned (fail closed)", async () => {
  expect(await code(buildMenuPlan({ owner: OWNER, productId: "ethereum:pendle:pt:0x1", action: "deposit", amount: "1" }, { client: fakeClient({}) }))).toBe(
    "unsupported_action"
  );
});
