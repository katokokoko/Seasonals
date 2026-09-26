import { checkPendlePrice, divergenceBps, levelOf } from "./pendle-guard";
import { PlanError } from "./plans";

const E18 = 10n ** 18n;

test("divergence is measured from the oracle and rounded up (borders are not loosened)", () => {
  expect(divergenceBps(E18, E18)).toBe(0n);
  expect(divergenceBps(1000n, 1020n)).toBe(200n);
  expect(divergenceBps(1000n, 1021n)).toBe(210n);
  expect(divergenceBps(10_000n, 10_201n)).toBe(201n);
  expect(divergenceBps(3n, 4n)).toBe(3334n); // 3333.3… → 切り上げ
  expect(divergenceBps(1000n, 950n)).toBe(500n);
  expect(() => divergenceBps(0n, 1n)).toThrow(PlanError);
});

test("§4 thresholds: ≤2% ok, 2–5% warn, >5% block", () => {
  expect(levelOf(200n)).toBe("ok");
  expect(levelOf(201n)).toBe("warn");
  expect(levelOf(500n)).toBe("warn");
  expect(levelOf(501n)).toBe("block");
});

function client(opts: { state?: readonly [boolean, number, boolean]; twap?: bigint; syPerToken?: bigint; fail?: boolean }) {
  return {
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (opts.fail) throw new Error("rpc down");
      if (functionName === "getOracleState") return opts.state ?? [false, 10, true];
      if (functionName === "getPtToSyRate" || functionName === "getYtToSyRate") return opts.twap ?? E18;
      if (functionName === "previewDeposit") return ((args[1] as bigint) * E18) / (opts.syPerToken ?? E18);
      if (functionName === "previewRedeem") return opts.syPerToken ?? E18;
      throw new Error(functionName);
    },
  } as never;
}

const base = { market: "0x" + "1".repeat(40), sy: "0x" + "2".repeat(40), token: "0x" + "3".repeat(40), kind: "pt" as const, label: "PT-X" };

test("buy quote in SY terms is compared with the TWAP", async () => {
  // 1 token = 1 SY、100 token で 101 PT → 1 PT = 0.990099 SY、TWAP 0.99 → 0.01% 以内
  const r = await checkPendlePrice(client({ twap: (99n * E18) / 100n }), { ...base, side: "buy", tokenAmount: 100n * E18, pyAmount: 101n * E18 });
  expect(r.level).toBe("ok");
  // 同じ見積もりで TWAP が 0.93 なら 6.4% 離れて block
  const b = await checkPendlePrice(client({ twap: (93n * E18) / 100n }), { ...base, side: "buy", tokenAmount: 100n * E18, pyAmount: 101n * E18 });
  expect(b.level).toBe("block");
  expect(b.message).toMatch(/refused/);
});

test("oracle not ready or unreadable blocks the trade (fail closed)", async () => {
  const run = (c: never) => checkPendlePrice(c, { ...base, side: "sell", tokenAmount: E18, pyAmount: E18 }).catch((e) => (e as PlanError).code);
  expect(await run(client({ state: [true, 50, false] }))).toBe("oracle_unavailable");
  expect(await run(client({ fail: true }))).toBe("oracle_unavailable");
});
