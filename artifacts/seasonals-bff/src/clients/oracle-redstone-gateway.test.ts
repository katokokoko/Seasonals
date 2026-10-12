/**
 * RedStone gateway (tier B) — 署名を自前で recover し、正規 signer の quorum と中央値で価格を出す。
 * fixture は 2026-10-05 に公開 gateway から取った USDT / JLP / USDG の実 package (各 5 件)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REDSTONE_PRIMARY_SIGNERS } from "@workspace/lib/config/oracle-feeds";
import {
  _clearGatewayCacheForTest,
  aggregateGatewayFeed,
  fetchGatewaySnapshot,
  packageValueToInt,
  recoverPackageSigner,
  type GatewayPackage,
} from "./oracle-redstone-gateway";

const fx = JSON.parse(readFileSync(join(__dirname, "../__fixtures__/oracle/redstone-gateway.json"), "utf8")) as Record<string, GatewayPackage[]>;
const TS = fx.USDT![0]!.timestampMilliseconds;
const NOW = TS + 20_000; // package の 20 秒後
const SIGNERS = new Set(REDSTONE_PRIMARY_SIGNERS.map((a) => a.toLowerCase()));
const clone = (p: GatewayPackage): GatewayPackage => JSON.parse(JSON.stringify(p));

describe("recoverPackageSigner", () => {
  it.each(["USDT", "JLP", "USDG"])("%s: 実 package 5 件すべて正規 signer に recover される (5 つとも別 signer)", async (id) => {
    const signers = await Promise.all(fx[id]!.map(recoverPackageSigner));
    for (const s of signers) expect(SIGNERS.has(s!)).toBe(true);
    expect(new Set(signers).size).toBe(5);
  });
  it("値を 1 桁変える / 署名を壊すと別 address になるか null", async () => {
    const pkg = clone(fx.USDT![0]!);
    const original = await recoverPackageSigner(pkg);
    pkg.dataPoints[0]!.value = 0.99966;
    expect(await recoverPackageSigner(pkg)).not.toBe(original);
    const broken = clone(fx.USDT![0]!);
    broken.signature = Buffer.alloc(10).toString("base64");
    expect(await recoverPackageSigner(broken)).toBeNull();
  });
});

describe("aggregateGatewayFeed", () => {
  it("5 signer の中央値と age (USDT は全員同値)", async () => {
    const r = await aggregateGatewayFeed(fx.USDT, "USDT", NOW);
    expect(r).toEqual({ status: { available: true, price_usd: "0.99965000", age_seconds: 20 }, validSigners: 5 });
  });
  it("JLP: signer ごとに値が違う → 中央値 (bigint で exact)", async () => {
    const r = await aggregateGatewayFeed(fx.JLP, "JLP", NOW);
    // 4.89472214 / 4.89472231 / 4.89478671 / 4.8948601 / 4.8950871 の中央
    expect(r.status.price_usd).toBe("4.89478671");
  });
  it("偶数件は中央 2 つの低い方 (金額を盛らない)", async () => {
    const four = fx.JLP!.filter((p) => p.dataPoints[0]!.value !== 4.89478671);
    expect(four).toHaveLength(4);
    expect((await aggregateGatewayFeed(four, "JLP", NOW)).status.price_usd).toBe("4.89472231");
  });
  it("値を改ざんした package は signer が allow-list 外になって捨てられる", async () => {
    const tampered = fx.USDT!.map(clone);
    tampered[0]!.dataPoints[0]!.value = 1.5;
    tampered[1]!.dataPoints[0]!.value = 1.5;
    const r = await aggregateGatewayFeed(tampered, "USDT", NOW);
    expect(r.validSigners).toBe(3);
    expect(r.status.price_usd).toBe("0.99965000");
  });
  it("quorum: 有効 2 件なら unavailable、3 件なら available", async () => {
    expect((await aggregateGatewayFeed(fx.USDT!.slice(0, 2), "USDT", NOW)).status.available).toBe(false);
    expect((await aggregateGatewayFeed(fx.USDT!.slice(0, 3), "USDT", NOW)).status.available).toBe(true);
  });
  it("同じ signer の重複は 1 件扱い (5 件中 3 件が同じ signer なら quorum 不足)", async () => {
    const dup = [fx.USDT![0]!, fx.USDT![0]!, fx.USDT![0]!, fx.USDT![1]!, fx.USDT![1]!];
    const r = await aggregateGatewayFeed(dup, "USDT", NOW);
    expect(r.validSigners).toBe(2);
    expect(r.status.available).toBe(false);
  });
  it("dataPackageId / dataServiceId / dataFeedId が違う package は数えない", async () => {
    expect((await aggregateGatewayFeed(fx.USDT, "JLP", NOW)).validSigners).toBe(0);
    const otherService = fx.USDT!.map((p) => ({ ...clone(p), dataServiceId: "redstone-primary-demo" }));
    expect((await aggregateGatewayFeed(otherService, "USDT", NOW)).validSigners).toBe(0);
  });
  it("古い package だけなら available だが age は閾値超 (evaluateOracle が stale として扱う)", async () => {
    const r = await aggregateGatewayFeed(fx.USDT, "USDT", TS + 120_000);
    expect(r.status).toMatchObject({ available: true, age_seconds: 120 });
  });
  it("package が無い feed は unavailable", async () => {
    expect((await aggregateGatewayFeed(undefined, "USDT", NOW)).status.available).toBe(false);
  });
});

test("packageValueToInt は SDK と同じく 8 decimals に固定する", () => {
  expect(packageValueToInt(0.99965)).toBe(99965000n);
  expect(packageValueToInt(4.8950871)).toBe(489508710n);
  expect(packageValueToInt("1.5")).toBe(150000000n);
  expect(packageValueToInt("1.123456789")).toBeNull();
  expect(packageValueToInt(-1)).toBeNull();
});

describe("fetchGatewaySnapshot", () => {
  const body = JSON.stringify({ USDT: fx.USDT });
  beforeEach(() => _clearGatewayCacheForTest());
  afterEach(() => jest.restoreAllMocks());

  it("10 秒以内の 2 回目と同時呼び出しは 1 回の取得を共有する", async () => {
    const spy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response(body, { status: 200 }));
    const [a, b] = await Promise.all([fetchGatewaySnapshot(), fetchGatewaySnapshot()]);
    await fetchGatewaySnapshot();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.USDT).toHaveLength(5);
    expect(b).toBe(a);
  });
  it("1 本目の gateway が失敗したら 2 本目を使い、全滅なら throw", async () => {
    const spy = jest
      .spyOn(global, "fetch")
      .mockImplementationOnce(async () => new Response("down", { status: 513 }))
      .mockImplementationOnce(async () => new Response(body, { status: 200 }));
    expect((await fetchGatewaySnapshot()).USDT).toHaveLength(5);
    expect(String(spy.mock.calls[1]![0])).toContain("oracle-gateway-2.a.redstone.finance");
    _clearGatewayCacheForTest();
    jest.restoreAllMocks();
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network"));
    await expect(fetchGatewaySnapshot()).rejects.toThrow();
  });
});
