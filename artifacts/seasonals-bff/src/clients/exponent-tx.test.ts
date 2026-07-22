/**
 * Phase 8.34: exponent-tx pure helper のテスト (network なし)。
 * account 順序 / offset は forensics (実 tx 5561izAd… / 2JVrPXAi… と
 * fragSOL / BulkSOL vault) で確定した値を fixture に固定する。
 */
import { PublicKey } from "@solana/web3.js";
import {
  decodeVaultForRedeem,
  encodeWrapperMergeData,
  substituteUserAccounts,
  type RedeemTemplate,
} from "./exponent-tx";

const PK = (seed: string) =>
  new PublicKey(Buffer.alloc(32, seed.charCodeAt(0))).toBase58();

describe("encodeWrapperMergeData", () => {
  it("layout: [39][amount u64 LE][until u8] = 10 bytes", () => {
    const buf = encodeWrapperMergeData("1943703955", 10);
    expect(buf.length).toBe(10);
    expect(buf[0]).toBe(39); // custom discriminator (lib.rs #[instruction(discriminator=[39])])
    expect(buf.readBigUInt64LE(1)).toBe(1943703955n);
    expect(buf.readUInt8(9)).toBe(10);
  });

  it("§4.5: 整数 string 以外は throw (parse しない)", () => {
    expect(() => encodeWrapperMergeData("1.5", 10)).toThrow("invalid amount");
    expect(() => encodeWrapperMergeData("-1", 10)).toThrow("invalid amount");
    expect(() => encodeWrapperMergeData("1e9", 10)).toThrow("invalid amount");
  });
});

describe("decodeVaultForRedeem", () => {
  function vaultFixture(): Buffer {
    // vault.rs フィールド順: disc(8) + sy_program(8) + mint_sy(40) + mint_yt(72)
    // + mint_pt(104) + escrow_yt(136) + escrow_sy(168) + yield_position(200)
    // + address_lookup_table(232) + start_ts(264) + duration(268) + signer_seed(272)
    // + authority(304) + …
    const buf = Buffer.alloc(400);
    const put = (off: number, seed: string) =>
      new PublicKey(Buffer.alloc(32, seed.charCodeAt(0))).toBuffer().copy(buf, off);
    put(8, "s"); // sy_program
    put(40, "m"); // mint_sy
    put(72, "y"); // mint_yt
    put(104, "p"); // mint_pt
    put(168, "e"); // escrow_sy
    put(200, "r"); // yield_position
    put(232, "a"); // ALT
    buf.writeUInt32LE(1_765_717_100, 264); // start_ts
    buf.writeUInt32LE(31_615_200, 268); // duration
    put(304, "u"); // authority
    return buf;
  }

  it("実測 offset で field を decode し maturity = start + duration", () => {
    const v = decodeVaultForRedeem(vaultFixture());
    expect(v.sy_program).toBe(PK("s"));
    expect(v.mint_sy).toBe(PK("m"));
    expect(v.mint_yt).toBe(PK("y"));
    expect(v.mint_pt).toBe(PK("p"));
    expect(v.escrow_sy).toBe(PK("e"));
    expect(v.yield_position).toBe(PK("r"));
    expect(v.address_lookup_table).toBe(PK("a"));
    expect(v.authority).toBe(PK("u"));
    expect(v.maturity_ts).toBe(1_765_717_100 + 31_615_200); // = 1797332300 (fragSOL 実測)
  });

  it("account が小さすぎる場合は throw (壊れた decode をしない)", () => {
    expect(() => decodeVaultForRedeem(Buffer.alloc(100))).toThrow("too small");
  });
});

describe("substituteUserAccounts", () => {
  const SIGNER = PK("S");
  const USER = PK("U");
  const T_ATA = { sy: PK("1"), yt: PK("2"), pt: PK("3"), base: PK("4") };
  const U_ATA = { sy: PK("5"), yt: PK("6"), pt: PK("7"), base: PK("8") };
  const VAULT = PK("v");

  function tpl(accounts: { pubkey: string; isWritable: boolean }[]): RedeemTemplate {
    return { accounts, signer: SIGNER, redeem_sy_accounts_until: 10, tokenProgramByMint: {} };
  }

  it("signer / 各 ATA を user 側へ置換、他は不変・writability 維持", () => {
    const out = substituteUserAccounts(
      tpl([
        { pubkey: SIGNER, isWritable: true },
        { pubkey: T_ATA.sy, isWritable: true },
        { pubkey: VAULT, isWritable: true },
        { pubkey: T_ATA.yt, isWritable: true },
        { pubkey: T_ATA.pt, isWritable: true },
        { pubkey: T_ATA.base, isWritable: true },
        { pubkey: SIGNER, isWritable: true }, // remaining にも signer が再出現 (実測)
      ]),
      { user: USER, templateAtas: T_ATA, userAtas: U_ATA }
    );
    expect(out.map((a) => a.pubkey)).toEqual([
      USER,
      U_ATA.sy,
      VAULT,
      U_ATA.yt,
      U_ATA.pt,
      U_ATA.base,
      USER,
    ]);
    expect(out[0]!.isSigner).toBe(true);
    expect(out[6]!.isSigner).toBe(true);
    expect(out[2]!.isSigner).toBe(false);
    expect(out.every((a) => a.isWritable)).toBe(true);
  });

  it("base ATA が template に現れない場合は throw (非 ATA 利用 template)", () => {
    expect(() =>
      substituteUserAccounts(
        tpl([
          { pubkey: SIGNER, isWritable: true },
          { pubkey: T_ATA.sy, isWritable: true },
          { pubkey: T_ATA.pt, isWritable: true },
        ]),
        { user: USER, templateAtas: T_ATA, userAtas: U_ATA }
      )
    ).toThrow("template_base_ata_not_found");
  });
});
