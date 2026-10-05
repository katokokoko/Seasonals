/**
 * SKR staking 読取の検査 (docs/skr-r0-implementation.md §6)
 * - R0-01 読取: 正常だけ fresh、owner / PDA / mint / layout 不一致は unsupported、RPC 失敗は unavailable、
 *   UserStake 不在は正常な空状態、偽の量 / 日付なし
 * - R0-02 batch: 必須 account は同一 batch、個別 fetch 0 件、液体 SKR の失敗 / 別 slot は staking に影響しない
 * - R0-03 / R0-04 を byte 入力から通しで確認
 * - 取得済み mainnet batch の decode が fixture の decoded / checks と一致 (LIVE-01 の共通 account 部分)
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import {
  FIXTURE_SKR_CHAIN_TIME,
  FIXTURE_SKR_OBSERVED_AT,
  FIXTURE_SKR_PENDING_AMOUNT,
  FIXTURE_SKR_POSITION_ACCOUNT,
  FIXTURE_SKR_SHARES,
  FIXTURE_SKR_SLOT,
  FIXTURE_SKR_UNSTAKE_TS_COOLING,
  FIXTURE_SKR_WALLET,
  fixtureCooldownStateCoolingDown,
} from "@workspace/lib/__fixtures__";
import { fixtureSkrProtocolReference as ref } from "@workspace/lib/__fixtures__/skr-staking/protocol-reference";
import {
  SKR_GUARDIAN_POOL,
  SKR_IDL_SHA256,
  SKR_STAKE_CONFIG,
  SKR_STAKE_VAULT,
  SKR_STAKING_PROGRAM_ID,
  SOLANA_CLOCK_SYSVAR,
  SKR_MINT,
  SPL_TOKEN_PROGRAM_ID,
} from "@workspace/lib/config/skr-staking";
import {
  clockAccount,
  encodeUserStake,
  patchGuardianPoolTotalShares,
  patchStakeConfig,
  patchTokenAccountAmount,
  programAccount,
  referenceAccounts,
  referenceClockFields,
  type UserStakeFields,
} from "./skr-staking-encode";
import {
  createHeliusSkrRpc,
  decodeAndValidateSkrBatch,
  decodeClock,
  decodeGuardianPool,
  decodeSplMint,
  decodeSplTokenAccount,
  decodeStakeConfig,
  deriveSkrAccounts,
  InvalidSkrWalletError,
  readSkrStakingState,
  skrBatchAddresses,
  type RawAccount,
  type SkrRpc,
} from "./skr-staking";

const OTHER_WALLET = "9hQpJ4xRwY7nKsT2bGvCmHdEq6jPzN5fLrXk3aBoMyVc";
const COOLDOWN = BigInt(ref.decoded.config.cooldown_seconds);
const TS = BigInt(FIXTURE_SKR_UNSTAKE_TS_COOLING);
const UNLOCK = TS + COOLDOWN;
const NOW = () => new Date(FIXTURE_SKR_OBSERVED_AT);

function userStake(over: Partial<UserStakeFields> = {}): RawAccount {
  return programAccount(
    encodeUserStake({
      stake_config: SKR_STAKE_CONFIG,
      user: FIXTURE_SKR_WALLET,
      guardian_pool: SKR_GUARDIAN_POOL,
      shares: BigInt(FIXTURE_SKR_SHARES),
      unstaking_amount: BigInt(FIXTURE_SKR_PENDING_AMOUNT),
      unstake_timestamp: TS,
      ...over,
    })
  );
}

interface BatchOpts {
  user?: RawAccount | null;
  clockUnix?: bigint;
  config?: RawAccount | null;
  pool?: RawAccount | null;
  vault?: RawAccount | null;
  mint?: RawAccount | null;
  clock?: RawAccount | null;
}

/** [config, pool, userStake, vault, mint, Clock] */
function batch(opts: BatchOpts = {}): (RawAccount | null)[] {
  const r = referenceAccounts();
  const clock =
    opts.clock !== undefined
      ? opts.clock
      : clockAccount({ ...referenceClockFields(), unix_timestamp: opts.clockUnix ?? BigInt(FIXTURE_SKR_CHAIN_TIME) });
  return [
    opts.config !== undefined ? opts.config : r.config,
    opts.pool !== undefined ? opts.pool : r.pool,
    opts.user !== undefined ? opts.user : userStake(),
    opts.vault !== undefined ? opts.vault : r.vault,
    opts.mint !== undefined ? opts.mint : r.mint,
    clock,
  ];
}

interface FakeRpc extends SkrRpc {
  batchCalls: string[][];
  liquidCalls: [string, string][];
}

function fakeRpc(
  accounts: (RawAccount | null)[] | Error,
  liquid: { slot: number; amounts: string[] } | Error = { slot: FIXTURE_SKR_SLOT + 1, amounts: ["5000000"] },
  slot = FIXTURE_SKR_SLOT
): FakeRpc {
  const rpc: FakeRpc = {
    batchCalls: [],
    liquidCalls: [],
    async getMultipleAccounts(addresses) {
      rpc.batchCalls.push(addresses);
      if (accounts instanceof Error) throw accounts;
      return { slot, accounts };
    },
    async getTokenAmountsByOwner(owner, mint) {
      rpc.liquidCalls.push([owner, mint]);
      if (liquid instanceof Error) throw liquid;
      return liquid;
    },
  };
  return rpc;
}

async function read(rpc: SkrRpc, wallet = FIXTURE_SKR_WALLET, onReject?: (s: string, r: string) => void) {
  return readSkrStakingState(wallet, { source: "live", rpc, now: NOW, onReject });
}

describe("取得済み mainnet batch の replay (共通 account)", () => {
  const r = referenceAccounts();

  it("IDL の SHA-256 が記録値と一致", () => {
    const idl = readFileSync(join(__dirname, "../../../../lib/__fixtures__/skr-staking/idl.json"));
    expect(createHash("sha256").update(idl).digest("hex")).toBe(SKR_IDL_SHA256);
  });

  it("config / pool / vault / mint / Clock の decode が fixture の decoded と一致", () => {
    const c = decodeStakeConfig(r.config);
    const p = decodeGuardianPool(r.pool);
    const v = decodeSplTokenAccount(r.vault);
    const m = decodeSplMint(r.mint);
    const k = decodeClock(r.clock);
    if (!c.ok || !p.ok || !v.ok || !m.ok || !k.ok) throw new Error("decode failed");
    const d = ref.decoded;
    expect(c.value).toEqual({
      authority: d.config.authority,
      mint: d.config.mint,
      stake_vault: d.config.stake_vault,
      min_stake_amount: d.config.min_stake_amount,
      cooldown_seconds: d.config.cooldown_seconds,
      total_shares: d.config.total_shares,
      share_price: d.config.share_price,
      last_vault_amount: d.config.last_vault_amount,
    });
    expect(p.value).toEqual({
      stake_config: d.pool.stake_config,
      guardian: d.pool.guardian,
      total_shares: d.pool.total_shares,
      last_share_price: d.pool.last_share_price,
      commission_bps: d.pool.commission_bps,
      active: d.pool.active,
    });
    expect(v.value.authority).toBe(d.vault_token_authority);
    expect(v.value.mint).toBe(SKR_MINT);
    expect(m.value.decimals).toBe(d.mint_decimals);
    expect(k.value.unix_timestamp).toBe(d.chain_time);
    expect(k.value.slot).toBe(String(ref.rpc_response.result.context.slot));
  });

  it("fixture の 11 checks を同じ検査で再現する (UserStake 不在の batch が通る)", () => {
    expect(Object.values(ref.checks).every(Boolean)).toBe(true);
    expect(Object.keys(ref.checks)).toHaveLength(11);
    const addrs = deriveSkrAccounts(FIXTURE_SKR_WALLET);
    const res = decodeAndValidateSkrBatch(FIXTURE_SKR_WALLET, addrs, batch({ user: null, clock: r.clock }));
    expect(res.ok).toBe(true);
  });
});

describe("PDA", () => {
  it("UserStake PDA は lib fixture の position_account と一致し、batch は 6 account の固定順", () => {
    const a = deriveSkrAccounts(FIXTURE_SKR_WALLET);
    expect(a.userStake).toBe(FIXTURE_SKR_POSITION_ACCOUNT);
    expect(skrBatchAddresses(a)).toEqual([
      SKR_STAKE_CONFIG,
      SKR_GUARDIAN_POOL,
      FIXTURE_SKR_POSITION_ACCOUNT,
      SKR_STAKE_VAULT,
      SKR_MINT,
      SOLANA_CLOCK_SYSVAR,
    ]);
    expect(deriveSkrAccounts(OTHER_WALLET).userStake).not.toBe(a.userStake);
  });

  it("32 byte にならない base58 は InvalidSkrWalletError", () => {
    expect(() => deriveSkrAccounts("1".repeat(44))).toThrow(InvalidSkrWalletError);
  });
});

describe("R0-01 読取", () => {
  it("正常な batch は fresh で、lib fixture と同じ response になる (BFF と lib の導出が一致)", async () => {
    const res = await read(fakeRpc(batch()));
    expect(res).toEqual(fixtureCooldownStateCoolingDown);
  });

  it("UserStake 不在は正常な空状態 (fresh / position null / event 0)", async () => {
    const res = await read(fakeRpc(batch({ user: null })));
    expect(res.data_status).toBe("fresh");
    expect(res.position).toBeNull();
    expect(res.events).toEqual([]);
    expect(res.position_account).toBe(FIXTURE_SKR_POSITION_ACCOUNT);
  });

  const r = referenceAccounts();
  const truncated = (a: RawAccount): RawAccount => ({ owner: a.owner, data: a.data.subarray(0, a.data.length - 1) });
  const wrongDisc = (a: RawAccount): RawAccount => {
    const data = Buffer.from(a.data);
    data[0] = (data[0]! + 1) % 256;
    return { owner: a.owner, data };
  };
  /** config.mint (offset 41) を SKR 以外の key に書き換える */
  const otherConfigMint = (() => {
    const data = Buffer.from(r.config.data);
    new PublicKey(OTHER_WALLET).toBuffer().copy(data, 41);
    return { owner: r.config.owner, data };
  })();
  const inactivePool = (() => {
    const data = Buffer.from(r.pool.data);
    data.writeUInt8(0, 171);
    return { owner: r.pool.owner, data };
  })();
  const wrongVaultAuthority = (() => {
    const data = Buffer.from(r.vault.data);
    new PublicKey(OTHER_WALLET).toBuffer().copy(data, 32); // SPL token account の owner (authority)
    return { owner: r.vault.owner, data };
  })();
  const wrongDecimals = (() => {
    const data = Buffer.from(r.mint.data);
    data.writeUInt8(9, 44);
    return { owner: r.mint.owner, data };
  })();

  it.each<[string, BatchOpts, string]>([
    ["config 不在", { config: null }, "config_missing"],
    ["config の owner 違い", { config: { owner: SPL_TOKEN_PROGRAM_ID, data: r.config.data } }, "config_owner"],
    ["config の長さ違い", { config: truncated(r.config) }, "config_size"],
    ["config の discriminator 違い", { config: wrongDisc(r.config) }, "config_discriminator"],
    ["config.mint が SKR でない", { config: otherConfigMint }, "config_mint"],
    ["pool の owner 違い", { pool: { owner: SPL_TOKEN_PROGRAM_ID, data: r.pool.data } }, "pool_owner"],
    ["pool の discriminator 違い", { pool: wrongDisc(r.pool) }, "pool_discriminator"],
    ["pool が非 active", { pool: inactivePool }, "pool_inactive"],
    ["vault の authority が config でない", { vault: wrongVaultAuthority }, "vault_authority"],
    ["vault の owner が Token Program でない", { vault: { owner: SKR_STAKING_PROGRAM_ID, data: r.vault.data } }, "vault_owner"],
    ["mint の decimals 違い", { mint: wrongDecimals }, "mint_decimals"],
    ["Clock の owner 違い", { clock: { owner: SKR_STAKING_PROGRAM_ID, data: r.clock.data } }, "clock_owner"],
    ["Clock 不在", { clock: null }, "clock_missing"],
    ["UserStake の owner 違い", { user: { owner: SPL_TOKEN_PROGRAM_ID, data: userStake().data } }, "user_stake_owner"],
    ["UserStake の長さ違い", { user: truncated(userStake()) }, "user_stake_size"],
    ["UserStake の user が別 wallet", { user: userStake({ user: OTHER_WALLET }) }, "user_stake_user"],
    ["UserStake の pool が別", { user: userStake({ guardian_pool: SKR_STAKE_VAULT }) }, "user_stake_pool"],
    ["UserStake の config が別", { user: userStake({ stake_config: SKR_STAKE_VAULT }) }, "user_stake_config"],
  ])("%s → unsupported (量・日付・event なし)", async (_label, opts, reason) => {
    const rejects: string[] = [];
    const res = await read(fakeRpc(batch(opts)), FIXTURE_SKR_WALLET, (s, why) => rejects.push(`${s}:${why}`));
    expect(res.data_status).toBe("unsupported");
    expect(res.position).toBeNull();
    expect(res.events).toEqual([]);
    expect(res.observed_at).toBeNull();
    expect(rejects).toEqual([`unsupported:${reason}`]);
  });

  it.each([
    ["Error", new Error("socket hang up")],
    ["timeout (AbortError)", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
  ])("RPC %s → unavailable (fixture に fallback しない)", async (_label, err) => {
    const res = await read(fakeRpc(err));
    expect(res.data_status).toBe("unavailable");
    expect(res.source).toBe("live");
    expect(res.position).toBeNull();
    expect(res.events).toEqual([]);
  });
});

describe("R0-02 batch", () => {
  it("必須 account は 1 回の getMultipleAccounts で 6 件、個別 fetch なし", async () => {
    const rpc = fakeRpc(batch());
    await read(rpc);
    expect(rpc.batchCalls).toHaveLength(1);
    expect(rpc.batchCalls[0]).toEqual(skrBatchAddresses(deriveSkrAccounts(FIXTURE_SKR_WALLET)));
    expect(rpc.liquidCalls).toEqual([[FIXTURE_SKR_WALLET, SKR_MINT]]);
  });

  it("応答の context.slot を採用する (Clock の slot ではない)", async () => {
    const res = await read(fakeRpc(batch(), undefined, FIXTURE_SKR_SLOT + 77));
    expect(res.slot).toBe(FIXTURE_SKR_SLOT + 77);
    expect(res.position?.slot).toBe(FIXTURE_SKR_SLOT + 77);
  });

  it("液体 SKR の失敗は staking 判定に影響しない", async () => {
    const res = await read(fakeRpc(batch(), new Error("liquid down")));
    expect(res.data_status).toBe("fresh");
    expect(res.events).toEqual(fixtureCooldownStateCoolingDown.events);
    expect(res.liquid).toEqual({ amount: null, slot: null, observed_at: null, data_status: "unavailable" });
  });

  it("液体 SKR は ATA / 非 ATA を合算し、別 slot を持つ", async () => {
    const res = await read(fakeRpc(batch(), { slot: FIXTURE_SKR_SLOT + 9, amounts: ["1000000", "2500000"] }));
    expect(res.liquid.amount).toBe("3500000");
    expect(res.liquid.slot).toBe(FIXTURE_SKR_SLOT + 9);
    expect(res.slot).toBe(FIXTURE_SKR_SLOT);
  });
});

describe("R0-03 状態 (byte 入力から通し)", () => {
  it.each([
    ["unlock − 1", UNLOCK - 1n, "cooling_down"],
    ["unlock", UNLOCK, "ready"],
    ["unlock + 1", UNLOCK + 1n, "ready"],
  ] as const)("Clock = %s (%s) → %s", async (_l, clockUnix, expected) => {
    const res = await read(fakeRpc(batch({ clockUnix })));
    expect(res.position?.pending_status).toBe(expected);
  });

  it("サーバ時刻が未来でも Clock が unlock 前なら cooling_down", async () => {
    const res = await readSkrStakingState(FIXTURE_SKR_WALLET, {
      source: "live",
      rpc: fakeRpc(batch({ clockUnix: UNLOCK - 1n })),
      now: () => new Date("2031-01-01T00:00:00Z"),
    });
    expect(res.position?.pending_status).toBe("cooling_down");
  });

  it("取消 (unstaking_amount 0) → none、event 0", async () => {
    const res = await read(fakeRpc(batch({ user: userStake({ unstaking_amount: 0n }) })));
    expect(res.position?.pending_status).toBe("none");
    expect(res.events).toEqual([]);
  });

  it("追加解除で unlock_at が延び、event id は同じ", async () => {
    const before = await read(fakeRpc(batch()));
    const after = await read(
      fakeRpc(batch({ user: userStake({ unstaking_amount: 400_000_000n, unstake_timestamp: TS + 3000n }), clockUnix: TS + 3001n }))
    );
    expect(after.events[0]?.event.id).toBe(before.events[0]?.event.id);
    expect(after.events[0]?.schedule_revision).toBe(`v1:${TS + 3000n}:${COOLDOWN}`);
    expect(after.position?.pending_amount).toBe("400000000");
  });

  it("config の cooldown が変われば unlock_at はその値で計算する (48 時間固定にしない)", async () => {
    const r = referenceAccounts();
    const res = await read(
      fakeRpc(batch({ config: programAccount(patchStakeConfig(r.config.data, { cooldown_seconds: 259_200n })) }))
    );
    expect(res.position?.cooldown_seconds).toBe("259200");
    expect(res.position?.unlock_at).toBe(new Date(Number(TS + 259_200n) * 1000).toISOString());
  });
});

describe("R0-04 予定キー (byte 入力から通し)", () => {
  it("他人の操作 (config total_shares / share_price / vault 残高 / pool total_shares) と Clock では不変", async () => {
    const r = referenceAccounts();
    const base = await read(fakeRpc(batch()));
    const others = await read(
      fakeRpc(
        batch({
          config: programAccount(
            patchStakeConfig(r.config.data, {
              total_shares: 9_000_000_000_000_000n,
              share_price: 1_200_000_000n,
              last_vault_amount: 6_000_000_000_000_000n,
            })
          ),
          pool: programAccount(patchGuardianPoolTotalShares(r.pool.data, 9_000_000_000_000_000n)),
          vault: { owner: r.vault.owner, data: patchTokenAccountAmount(r.vault.data, 6_000_000_000_000_000n) },
          clockUnix: BigInt(FIXTURE_SKR_CHAIN_TIME) + 600n,
        }),
        undefined,
        FIXTURE_SKR_SLOT + 1500
      )
    );
    expect(others.events[0]?.schedule_revision).toBe(base.events[0]?.schedule_revision);
    expect(others.events[0]?.event.id).toBe(base.events[0]?.event.id);
    expect(others.position?.active_amount_estimate).not.toBe(base.position?.active_amount_estimate);
  });
});

describe("createHeliusSkrRpc", () => {
  const OLD_KEY = process.env.HELIUS_API_KEY;
  beforeEach(() => {
    process.env.HELIUS_API_KEY = "test-key-should-not-leak";
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env.HELIUS_API_KEY = OLD_KEY;
  });

  function rpcResponse(result: unknown, status = 200): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status });
  }

  it("getMultipleAccounts は base64 / confirmed で 1 回呼び、context.slot と account を返す", async () => {
    const value = ref.rpc_response.result.value;
    const spy = jest.spyOn(global, "fetch").mockResolvedValue(
      rpcResponse({ context: { slot: 448756999 }, value: [value[0], null] })
    );
    const out = await createHeliusSkrRpc().getMultipleAccounts([SKR_STAKE_CONFIG, FIXTURE_SKR_POSITION_ACCOUNT]);
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.method).toBe("getMultipleAccounts");
    expect(body.params).toEqual([
      [SKR_STAKE_CONFIG, FIXTURE_SKR_POSITION_ACCOUNT],
      { encoding: "base64", commitment: "confirmed" },
    ]);
    expect(out.slot).toBe(448756999);
    expect(out.accounts[0]?.owner).toBe(SKR_STAKING_PROGRAM_ID);
    expect(out.accounts[0]?.data.length).toBe(193);
    expect(out.accounts[1]).toBeNull();
  });

  it("長さ不一致・HTTP 失敗・RPC error は throw し、message に API key を含めない", async () => {
    const spy = jest.spyOn(global, "fetch");
    spy.mockResolvedValueOnce(rpcResponse({ context: { slot: 1 }, value: [] }));
    await expect(createHeliusSkrRpc().getMultipleAccounts([SKR_STAKE_CONFIG])).rejects.toThrow("length mismatch");
    spy.mockResolvedValueOnce(new Response("nope", { status: 429 }));
    const httpErr = await createHeliusSkrRpc().getMultipleAccounts([SKR_STAKE_CONFIG]).catch((e: Error) => e);
    expect(String(httpErr)).toContain("HTTP 429");
    expect(String(httpErr)).not.toContain("test-key");
    spy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32005, message: "x" } })));
    await expect(createHeliusSkrRpc().getMultipleAccounts([SKR_STAKE_CONFIG])).rejects.toThrow("RPC error -32005");
  });

  it("getTokenAccountsByOwner は mint filter / jsonParsed / confirmed、amount を string で返す", async () => {
    const spy = jest.spyOn(global, "fetch").mockResolvedValue(
      rpcResponse({
        context: { slot: 42 },
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: "18446744073709551615" } } } } } },
        ],
      })
    );
    const out = await createHeliusSkrRpc().getTokenAmountsByOwner(FIXTURE_SKR_WALLET, SKR_MINT);
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.params).toEqual([FIXTURE_SKR_WALLET, { mint: SKR_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    expect(out).toEqual({ slot: 42, amounts: ["18446744073709551615"] });
  });

  it("HELIUS_API_KEY が無ければ throw (route は unavailable にする)", async () => {
    delete process.env.HELIUS_API_KEY;
    await expect(createHeliusSkrRpc().getMultipleAccounts([SKR_STAKE_CONFIG])).rejects.toThrow("HELIUS_API_KEY");
  });
});
