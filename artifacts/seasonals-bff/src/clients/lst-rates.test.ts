/**
 * lst-rates — LST の交換レートを protocol 実データから取る (Phase 8.73)。
 *
 * ここで固定するのは **採用しない条件**。誤った rate を 1 つ通すと、保有の
 * 評価額とフェアバリューガードの両方が静かに狂う (8.72 で実際にそうなった)。
 */
import {
  fetchLstSolValues,
  parseInfPoolRate,
  parseMarinadePriceSol,
  parseStakePoolRate,
} from "./lst-rates";
import { _clearAllCachesForTest } from "../cache/ttl-cache";
import { _setSleepForTest } from "./helius-limiter";
import { _resetUsageForTest, usageSnapshot } from "../usage";

jest.mock("./helius-rpc", () => ({
  ...jest.requireActual("./helius-rpc"),
  getEpochInfo: jest.fn(async () => ({ epoch: 1011 })),
}));

const SPL_STAKE_POOL_PROGRAM = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";
const SANCTUM_S_CONTROLLER = "5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx";

/** 実測 (2026-08-03) の Jito stake pool の値 → 1.293886836 SOL/jitoSOL */
const JITO_TOTAL_LAMPORTS = 9_943_787_707_142_971n;
const JITO_POOL_SUPPLY = 7_685_206_642_074_660n;
const EPOCH = 1011;

function stakePoolBuf(p: {
  accountType?: number;
  totalLamports?: bigint;
  poolTokenSupply?: bigint;
  lastUpdateEpoch?: bigint;
  length?: number;
}): Buffer {
  const buf = Buffer.alloc(p.length ?? 611);
  buf.writeUInt8(p.accountType ?? 1, 0);
  buf.writeBigUInt64LE(p.totalLamports ?? JITO_TOTAL_LAMPORTS, 258);
  buf.writeBigUInt64LE(p.poolTokenSupply ?? JITO_POOL_SUPPLY, 266);
  buf.writeBigUInt64LE(p.lastUpdateEpoch ?? BigInt(EPOCH), 274);
  return buf;
}

describe("parseStakePoolRate (jitoSOL)", () => {
  it("実測どおりの lamports/token を返す", () => {
    const rate = parseStakePoolRate(
      SPL_STAKE_POOL_PROGRAM,
      stakePoolBuf({}),
      EPOCH
    );
    expect(rate).toBe(1_293_886_836n);
  });

  it("owner が SPL stake pool program でなければ採用しない", () => {
    expect(
      parseStakePoolRate("SomeOtherProgram1111111111111111111111111111", stakePoolBuf({}), EPOCH)
    ).toBeNull();
  });

  it("accountType が StakePool(1) でなければ採用しない", () => {
    expect(
      parseStakePoolRate(SPL_STAKE_POOL_PROGRAM, stakePoolBuf({ accountType: 2 }), EPOCH)
    ).toBeNull();
  });

  it("**epoch が古ければ採用しない** (未更新の比率を使わない)", () => {
    expect(
      parseStakePoolRate(
        SPL_STAKE_POOL_PROGRAM,
        stakePoolBuf({ lastUpdateEpoch: BigInt(EPOCH - 1) }),
        EPOCH
      )
    ).toBeNull();
  });

  it("supply 0 / 短すぎる data は採用しない (0 除算も防ぐ)", () => {
    expect(
      parseStakePoolRate(SPL_STAKE_POOL_PROGRAM, stakePoolBuf({ poolTokenSupply: 0n }), EPOCH)
    ).toBeNull();
    expect(
      parseStakePoolRate(SPL_STAKE_POOL_PROGRAM, Buffer.alloc(100), EPOCH)
    ).toBeNull();
  });

  it("比率が妥当範囲外なら採用しない (layout 読み違いの保険)", () => {
    // 1 SOL 未満 — LST は SOL に対して増える一方なので有り得ない
    expect(
      parseStakePoolRate(
        SPL_STAKE_POOL_PROGRAM,
        stakePoolBuf({ totalLamports: JITO_POOL_SUPPLY / 2n }),
        EPOCH
      )
    ).toBeNull();
    // 5 SOL 超
    expect(
      parseStakePoolRate(
        SPL_STAKE_POOL_PROGRAM,
        stakePoolBuf({ totalLamports: JITO_POOL_SUPPLY * 6n }),
        EPOCH
      )
    ).toBeNull();
  });
});

describe("parseInfPoolRate (INF)", () => {
  /** 実測: total_sol_value 2036561145651351 / supply 1413251334225738 → 1.441046681 */
  const TOTAL_SOL_VALUE = 2_036_561_145_651_351n;
  const INF_SUPPLY = 1_413_251_334_225_738n;

  function infBuf(totalSolValue = TOTAL_SOL_VALUE): Buffer {
    const buf = Buffer.alloc(240);
    buf.writeBigUInt64LE(totalSolValue, 0);
    return buf;
  }

  it("実測どおりの lamports/token を返す", () => {
    expect(parseInfPoolRate(SANCTUM_S_CONTROLLER, infBuf(), INF_SUPPLY)).toBe(
      1_441_046_681n
    );
  });

  it("owner が Sanctum S controller でなければ採用しない", () => {
    expect(
      parseInfPoolRate("SomeOtherProgram1111111111111111111111111111", infBuf(), INF_SUPPLY)
    ).toBeNull();
  });

  it("supply 0 は採用しない", () => {
    expect(parseInfPoolRate(SANCTUM_S_CONTROLLER, infBuf(), 0n)).toBeNull();
  });

  it("妥当範囲外は採用しない — offset 0 の読みは実測由来なので保険が要る", () => {
    expect(
      parseInfPoolRate(SANCTUM_S_CONTROLLER, infBuf(INF_SUPPLY / 2n), INF_SUPPLY)
    ).toBeNull();
    expect(
      parseInfPoolRate(SANCTUM_S_CONTROLLER, infBuf(INF_SUPPLY * 9n), INF_SUPPLY)
    ).toBeNull();
  });
});

describe("parseMarinadePriceSol (mSOL)", () => {
  it("decimal 文字列を lamports に変換する (float を挟まない)", () => {
    expect(parseMarinadePriceSol("1.3977423886241611")).toBe(1_397_742_388n);
    expect(parseMarinadePriceSol("  1.5\n")).toBe(1_500_000_000n);
    expect(parseMarinadePriceSol("2")).toBe(2_000_000_000n);
  });

  it("不正な body / 妥当範囲外は null", () => {
    for (const bad of ["", "abc", "-1.2", "0.5", "9.9", "<html>"]) {
      expect(parseMarinadePriceSol(bad)).toBeNull();
    }
  });
});

describe("fetchLstSolValues — B2: limiter 経由 + 共有 cache", () => {
  const savedKey = process.env.HELIUS_API_KEY;
  beforeEach(() => {
    process.env.HELIUS_API_KEY = "test-key";
    _clearAllCachesForTest();
    _resetUsageForTest();
    _setSleepForTest(async () => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    _setSleepForTest(null);
    if (savedKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = savedKey;
  });

  function upstream(opts: { supply429Once?: boolean } = {}) {
    const methods: string[] = [];
    let supply429 = opts.supply429Once ?? false;
    const spy = jest.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("marinade")) return new Response("1.3977423886", { status: 200 });
      const method = JSON.parse(String((init as RequestInit).body)).method as string;
      methods.push(method);
      if (method === "getTokenSupply" && supply429) {
        supply429 = false;
        return new Response("Too Many Requests", { status: 429 });
      }
      const result = method === "getMultipleAccounts" ? { value: [null, null] } : { value: { amount: "0" } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
    });
    return { spy, methods };
  }

  it("同時の呼び手は 1 回の取得に合流し、Helius 呼び出しは usage に数えられる", async () => {
    const { spy, methods } = upstream();
    const [a, b] = await Promise.all([fetchLstSolValues(), fetchLstSolValues()]);
    expect(a).toBe(b);
    expect(a.get("mSOL")).toBe(1_397_742_388n);
    expect(methods.sort()).toEqual(["getMultipleAccounts", "getTokenSupply"]);
    expect(spy).toHaveBeenCalledTimes(3); // RPC 2 + Marinade 1
    await fetchLstSolValues();
    expect(spy).toHaveBeenCalledTimes(3); // 60 秒 cache
    expect(usageSnapshot().byMethod).toMatchObject({ "rpc:getMultipleAccounts": 1, "rpc:getTokenSupply": 1 });
  });

  it("Helius の 429 は backoff 再試行する (冪等な読み取り)", async () => {
    const { methods } = upstream({ supply429Once: true });
    await fetchLstSolValues();
    expect(methods.filter((m) => m === "getTokenSupply")).toHaveLength(2);
  });
});
