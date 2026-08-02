/**
 * exponent-tx — Exponent PT 満期 redeem client (Phase 8.34)
 *
 * on-chain IDL 非公開のため instruction は手組み。forensics (2026-07-22、実 tx
 * 5561izAd… / 2JVrPXAi… を decode) で確定した仕様:
 *   - program: ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7 (exponent_core)
 *   - custom 1-byte discriminator: wrapper_merge = [39] (#[instruction(discriminator=[39])])
 *   - data = [39][amount_py u64 LE][redeem_sy_accounts_until u8] (計 10 bytes)
 *   - accounts = 固定 16 (WrapperMerge struct 順 + event_authority + program)
 *     + remaining (redeem_sy セット + interface CPI セット)。redeem_sy セットは
 *     SY interface program 依存で静的に導出できないため、**同 vault の直近成功
 *     wrapper_merge tx を template に user 固有スロット (signer / 各 ATA) だけ
 *     置換**して構築する。vault state の decode 値と template を cross-check し、
 *     不一致 (= program 上流変更) は throw して壊れた tx を作らない。
 *
 * 満期後の wrapper_merge は PT のみ burn (YT は burn しない — merge.rs 実装明記)
 * → SY 償還 → base asset を user が受領 (amount_base_out)。
 *
 * 規約: §4.5 amount は smallest-unit string → bigint (Number 禁止)。
 * §32.2 Keypair / secret は一切持たない (unsigned tx の base64 だけ返す)。
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const EXPONENT_PROGRAM_ID =
  "ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7";
const WRAPPER_MERGE_DISCRIMINATOR = 39;
const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";

/** redeem 対象 market (registry / live union の該当 entry) */
export interface ExponentRedeemMarket {
  pt_mint: string;
  yt_mint: string;
  vault_address: string;
  underlying_mint: string;
}

// ── Vault state decode (offsets は fragSOL / BulkSOL vault で実測検証済) ──────

/** Vault account の redeem に必要な field (vault.rs のフィールド順 + 8B disc) */
export interface DecodedVault {
  sy_program: string; // offset 8
  mint_sy: string; // 40
  mint_yt: string; // 72
  mint_pt: string; // 104
  escrow_sy: string; // 168
  yield_position: string; // 200
  address_lookup_table: string; // 232
  /** start_ts(u32@264) + duration(u32@268) = 満期 unix 秒 */
  maturity_ts: number;
  authority: string; // 304
}

export function decodeVaultForRedeem(data: Buffer): DecodedVault {
  if (data.length < 336) {
    throw new Error(`vault account too small: ${data.length}`);
  }
  const pk = (off: number) => new PublicKey(data.subarray(off, off + 32)).toBase58();
  return {
    sy_program: pk(8),
    mint_sy: pk(40),
    mint_yt: pk(72),
    mint_pt: pk(104),
    escrow_sy: pk(168),
    yield_position: pk(200),
    address_lookup_table: pk(232),
    maturity_ts: data.readUInt32LE(264) + data.readUInt32LE(268),
    authority: pk(304),
  };
}

// ── instruction data encode ──────────────────────────────────────────────────

/** data = [39][amount u64 LE][until u8]。amount は §4.5 integer string → bigint */
export function encodeWrapperMergeData(
  amountSmallest: string,
  redeemSyAccountsUntil: number
): Buffer {
  if (!/^[0-9]+$/.test(amountSmallest)) {
    throw new Error(`invalid amount: ${amountSmallest}`);
  }
  const buf = Buffer.alloc(10);
  buf.writeUInt8(WRAPPER_MERGE_DISCRIMINATOR, 0);
  buf.writeBigUInt64LE(BigInt(amountSmallest), 1);
  buf.writeUInt8(redeemSyAccountsUntil, 9);
  return buf;
}

// ── template 置換 (pure) ─────────────────────────────────────────────────────

export interface RedeemTemplate {
  /** wrapper_merge ix の account 列 (base58、tx 順) */
  accounts: { pubkey: string; isWritable: boolean }[];
  /** template tx の署名者 (置換対象) */
  signer: string;
  redeem_sy_accounts_until: number;
  /** mint → token program (ATA 導出用、template から逆算) */
  tokenProgramByMint: Record<string, string>;
}

/**
 * template の account 列から user 固有スロットを置換する (pure)。
 * 置換対象: signer → user、template signer の各 ATA (sy/yt/pt/base) → user の ATA。
 * base ATA が 1 度も現れない template は不正 (非 ATA 利用者) として throw。
 */
export function substituteUserAccounts(
  template: RedeemTemplate,
  subs: {
    user: string;
    templateAtas: Record<string, string>; // key: sy|yt|pt|base → template user ATA
    userAtas: Record<string, string>;
  }
): { pubkey: string; isSigner: boolean; isWritable: boolean }[] {
  const ataMap = new Map<string, string>();
  for (const k of ["sy", "yt", "pt", "base"] as const) {
    ataMap.set(subs.templateAtas[k]!, subs.userAtas[k]!);
  }
  let baseSeen = false;
  const out = template.accounts.map((a) => {
    if (a.pubkey === template.signer) {
      return { pubkey: subs.user, isSigner: true, isWritable: a.isWritable };
    }
    const replaced = ataMap.get(a.pubkey);
    if (replaced !== undefined) {
      if (a.pubkey === subs.templateAtas.base) baseSeen = true;
      return { pubkey: replaced, isSigner: false, isWritable: a.isWritable };
    }
    return { pubkey: a.pubkey, isSigner: false, isWritable: a.isWritable };
  });
  if (!baseSeen) {
    // base ATA が template に無い = template user が非 ATA 口座を使用 → 置換不能
    throw new Error("template_base_ata_not_found");
  }
  return out;
}

// ── connection / template 取得 ───────────────────────────────────────────────

function getConnection(): Connection {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is not set");
  return new Connection(`${HELIUS_MAINNET_URL}/?api-key=${apiKey}`, "confirmed");
}

const templateCache = new Map<string, { at: number; tpl: RedeemTemplate }>();
const TEMPLATE_TTL_MS = 60 * 60_000;

function ataFor(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): string {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram).toBase58();
}

/**
 * 同 vault の直近成功 wrapper_merge tx を template として採取する。
 * 見つからなければ null (呼び手が redeem_template_unavailable として fail-closed)。
 */
async function fetchRedeemTemplate(
  conn: Connection,
  vault: PublicKey,
  vaultState: DecodedVault,
  underlyingMint: string
): Promise<RedeemTemplate | null> {
  const cached = templateCache.get(vault.toBase58());
  if (cached && Date.now() - cached.at < TEMPLATE_TTL_MS) return cached.tpl;

  const sigs = await conn.getSignaturesForAddress(vault, { limit: 100 });
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) continue;
    const msg = tx.transaction.message;
    const allKeys = [
      ...msg.staticAccountKeys.map((k) => k.toBase58()),
      ...(tx.meta.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(tx.meta.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ];
    for (const ix of msg.compiledInstructions) {
      if (allKeys[ix.programIdIndex] !== EXPONENT_PROGRAM_ID) continue;
      const data = Buffer.from(ix.data);
      if (data.length !== 10 || data[0] !== WRAPPER_MERGE_DISCRIMINATOR) continue;

      const signer = allKeys[0]!; // fee payer = merger (観測 tx で一致)
      const accounts = ix.accountKeyIndexes.map((ki) => ({
        pubkey: allKeys[ki]!,
        isWritable: msg.isAccountWritable(ki),
      }));

      // template user の ATA を両 token program で導出し、実際に現れる方を採用
      const tokenProgramByMint: Record<string, string> = {};
      const present = new Set(accounts.map((a) => a.pubkey));
      const owner = new PublicKey(signer);
      for (const mint of [
        vaultState.mint_sy,
        vaultState.mint_yt,
        vaultState.mint_pt,
        underlyingMint,
      ]) {
        for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
          if (present.has(ataFor(new PublicKey(mint), owner, prog))) {
            tokenProgramByMint[mint] = prog.toBase58();
            break;
          }
        }
      }
      // 4 mint 全ての ATA が template に現れなければ次の候補へ
      if (Object.keys(tokenProgramByMint).length < 4) continue;

      const tpl: RedeemTemplate = {
        accounts,
        signer,
        redeem_sy_accounts_until: data.readUInt8(9),
        tokenProgramByMint,
      };
      templateCache.set(vault.toBase58(), { at: Date.now(), tpl });
      return tpl;
    }
  }
  return null;
}

// ── tx builder ───────────────────────────────────────────────────────────────

/**
 * 満期 PT の redeem (wrapper_merge) unsigned v0 tx。
 * 満期前 / vault 不整合 / template 不在は throw (呼び手が 400/502 に map)。
 */
export async function buildExponentRedeemTx(p: {
  wallet: string;
  market: ExponentRedeemMarket;
  amountSmallest: string;
}): Promise<{ transaction: string }> {
  const conn = getConnection();
  const vaultPk = new PublicKey(p.market.vault_address);

  const info = await conn.getAccountInfo(vaultPk);
  if (!info) throw new Error("vault_not_found");
  if (info.owner.toBase58() !== EXPONENT_PROGRAM_ID) {
    throw new Error("vault_owner_mismatch");
  }
  const vault = decodeVaultForRedeem(info.data);

  // cross-check: registry/live の market と on-chain vault の整合 (§32.2 —
  // 不一致 = 上流変更 or 誤設定。壊れた tx を作らず throw)
  if (vault.mint_pt !== p.market.pt_mint) throw new Error("vault_pt_mint_mismatch");
  if (vault.mint_yt !== p.market.yt_mint) throw new Error("vault_yt_mint_mismatch");

  // 満期チェックは on-chain 値が authoritative (fail-closed)
  if (vault.maturity_ts * 1000 > Date.now()) throw new Error("not_matured");

  const tpl = await fetchRedeemTemplate(conn, vaultPk, vault, p.market.underlying_mint);
  if (!tpl) throw new Error("redeem_template_unavailable");

  // template の固定スロットも vault state と照合 (struct 順: 2=vault, 3=escrow_sy,
  // 6=mint_yt, 7=mint_pt, 9=ALT, 11=yield_position, 12=sy_program)
  const fixedChecks: [number, string][] = [
    [2, vaultPk.toBase58()],
    [3, vault.escrow_sy],
    [6, vault.mint_yt],
    [7, vault.mint_pt],
    [9, vault.address_lookup_table],
    [11, vault.yield_position],
    [12, vault.sy_program],
  ];
  for (const [i, want] of fixedChecks) {
    if (tpl.accounts[i]?.pubkey !== want) {
      throw new Error(`template_layout_mismatch_at_${i}`);
    }
  }

  const owner = new PublicKey(p.wallet);
  const tSigner = new PublicKey(tpl.signer);
  const prog = (mint: string) => new PublicKey(tpl.tokenProgramByMint[mint]!);
  const mints = {
    sy: vault.mint_sy,
    yt: vault.mint_yt,
    pt: vault.mint_pt,
    base: p.market.underlying_mint,
  };
  const templateAtas: Record<string, string> = {};
  const userAtas: Record<string, string> = {};
  for (const [k, mint] of Object.entries(mints)) {
    templateAtas[k] = ataFor(new PublicKey(mint), tSigner, prog(mint));
    userAtas[k] = ataFor(new PublicKey(mint), owner, prog(mint));
  }

  const keys = substituteUserAccounts(tpl, {
    user: p.wallet,
    templateAtas,
    userAtas,
  });

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    // 観測 tx と同じく 4 ATA を idempotent 生成 (YT を持たない PT 購入者にも対応)
    ...Object.entries(mints).map(([k, mint]) =>
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        new PublicKey(userAtas[k]!),
        owner,
        new PublicKey(mint),
        prog(mint)
      )
    ),
    new TransactionInstruction({
      programId: new PublicKey(EXPONENT_PROGRAM_ID),
      keys: keys.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: encodeWrapperMergeData(p.amountSmallest, tpl.redeem_sy_accounts_until),
    }),
  ];

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return { transaction: Buffer.from(tx.serialize()).toString("base64") };
}
