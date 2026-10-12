/**
 * SKR staking 固定値の検査 (docs/skr-r0-implementation.md §2)。
 *
 * - layout の offset / size / discriminator を **公式 IDL から計算して** 一致を確かめる
 * - 住所は取得済 fixture と一致し、base58 として正しい
 * - Menu registry (deposit / Agent 候補の元) に SKR が混入していない
 */
import idl from "../__fixtures__/skr-staking/idl.json";
import { fixtureSkrProtocolReference as ref } from "../__fixtures__/skr-staking/protocol-reference";
import { fixtureMenuListings } from "../__fixtures__/menu-listings";
import { isSolanaAddress } from "./chains";
import { isDepositedMint } from "./deposited-mints";
import { EXPONENT_MARKETS } from "./exponent-markets";
import { KAMINO_MARKETS, KAMINO_VAULTS } from "./kamino-markets";
import { METEORA_MARKETS } from "./meteora-markets";
import { ORCA_MARKETS } from "./orca-markets";
import { SAVE_MARKETS } from "./save-markets";
import { SWAP_EARN_MARKETS } from "./swap-earn-markets";
import {
  SKR_GUARDIAN,
  SKR_GUARDIAN_POOL,
  SKR_IDL_SHA256,
  SKR_LAYOUT,
  SKR_MINT,
  SKR_STAKE_CONFIG,
  SKR_STAKE_VAULT,
  SKR_STAKING_PROGRAM_ID,
  SKR_STAKING_PROTOCOL_ID,
  SOLANA_CLOCK_SYSVAR,
} from "./skr-staking";

interface IdlField {
  name: string;
  type: unknown;
}
interface IdlTypeDef {
  name: string;
  type: { kind: string; fields?: IdlField[] };
}
interface IdlAccount {
  name: string;
  discriminator: number[];
}

const PRIMITIVE_SIZE: Record<string, number> = {
  u8: 1,
  bool: 1,
  u16: 2,
  u64: 8,
  i64: 8,
  u128: 16,
  pubkey: 32,
};

/** IDL の struct field を順に積んで offset と全長を出す (Anchor: 先頭 8 byte は discriminator) */
function layoutFromIdl(typeName: string): {
  offsets: Record<string, number>;
  size: number;
} {
  const def = (idl.types as IdlTypeDef[]).find((t) => t.name === typeName);
  if (!def?.type.fields) throw new Error(`IDL type ${typeName} not found`);
  let cursor = 8;
  const offsets: Record<string, number> = {};
  for (const f of def.type.fields) {
    if (typeof f.type !== "string" || !(f.type in PRIMITIVE_SIZE)) {
      throw new Error(`${typeName}.${f.name}: 非 primitive 型 ${JSON.stringify(f.type)}`);
    }
    offsets[f.name] = cursor;
    cursor += PRIMITIVE_SIZE[f.type]!;
  }
  return { offsets, size: cursor };
}

function discriminatorFromIdl(accountName: string): number[] {
  const acc = (idl.accounts as IdlAccount[]).find((a) => a.name === accountName);
  if (!acc) throw new Error(`IDL account ${accountName} not found`);
  return acc.discriminator;
}

describe("SKR_LAYOUT は公式 IDL と一致する", () => {
  it.each([
    ["StakeConfig", SKR_LAYOUT.stakeConfig],
    ["GuardianDelegationPool", SKR_LAYOUT.guardianPool],
    ["UserStake", SKR_LAYOUT.userStake],
  ] as const)("%s", (name, layout) => {
    const fromIdl = layoutFromIdl(name);
    expect(layout.size).toBe(fromIdl.size);
    expect(layout.offsets).toEqual(fromIdl.offsets);
    expect([...layout.discriminator]).toEqual(discriminatorFromIdl(name));
    expect(layout.discriminator).toHaveLength(8);
  });

  it("fixture の space (実 account 長) とも一致する", () => {
    const [config, pool] = ref.rpc_response.result.value;
    expect(config?.space).toBe(SKR_LAYOUT.stakeConfig.size);
    expect(pool?.space).toBe(SKR_LAYOUT.guardianPool.size);
  });

  it("program id と IDL 識別値は fixture と一致する", () => {
    expect(idl.address).toBe(SKR_STAKING_PROGRAM_ID);
    expect(ref.program).toBe(SKR_STAKING_PROGRAM_ID);
    expect(ref.idl_sha256).toBe(SKR_IDL_SHA256);
  });
});

describe("SKR の住所", () => {
  it("fixture の取得順 [config, pool, vault, mint, Clock] と一致する", () => {
    expect(ref.addresses).toEqual([
      SKR_STAKE_CONFIG,
      SKR_GUARDIAN_POOL,
      SKR_STAKE_VAULT,
      SKR_MINT,
      SOLANA_CLOCK_SYSVAR,
    ]);
    expect(ref.decoded.pool.guardian).toBe(SKR_GUARDIAN);
  });

  it.each([
    SKR_STAKING_PROGRAM_ID,
    SKR_STAKE_CONFIG,
    SKR_STAKE_VAULT,
    SKR_GUARDIAN_POOL,
    SKR_GUARDIAN,
    SKR_MINT,
    SOLANA_CLOCK_SYSVAR,
  ])("%s は base58 address", (addr) => {
    expect(isSolanaAddress(addr)).toBe(true);
  });
});

describe("SKR は Menu registry に載せない (R0 は read-only、Agent 候補にも出さない)", () => {
  const registries = {
    KAMINO_MARKETS,
    KAMINO_VAULTS,
    SAVE_MARKETS,
    ORCA_MARKETS,
    METEORA_MARKETS,
    EXPONENT_MARKETS,
    SWAP_EARN_MARKETS,
    fixtureMenuListings,
  };

  it.each(Object.entries(registries))("%s に skr_staking / SKR mint が無い", (_name, reg) => {
    const text = JSON.stringify(reg);
    expect(text).not.toContain(SKR_STAKING_PROTOCOL_ID);
    expect(text).not.toContain(SKR_MINT);
  });

  it("SKR mint は deposited mint ではない (portfolio の deposited 集計に入らない)", () => {
    expect(isDepositedMint(SKR_MINT)).toBe(false);
  });
});
