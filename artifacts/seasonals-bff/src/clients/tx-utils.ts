/**
 * tx-utils — LP 系 client 共通の tx 変換 + ephemeral 部分署名 (Phase 8.17/8.18)
 *
 * SDK が返す legacy Transaction を v0 (VersionedTransaction) に変換し、
 * **server 生成の ephemeral keypair (position account / position mint 用 —
 * user の資金鍵ではない、§32.2 整合)** で部分署名して base64 化する。
 * user (feePayer) の署名スロットは空のまま → mobile が MWA sign-only で埋める
 * (sign-only 経路は部分署名を保持する — 8.17 で round-trip 検証済)。
 */

import {
  Connection,
  PublicKey,
  Signer,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * legacy / v0 混在の tx 群を v0 base64[] へ。ephemeralSigners は各 tx の required
 * signer に含まれる場合のみ署名する。legacy は payer + 新 blockhash で再コンパイル。
 */
export async function toV0Base64(
  connection: Connection,
  txs: (Transaction | VersionedTransaction)[],
  payer: PublicKey,
  ephemeralSigners: Signer[]
): Promise<string[]> {
  let blockhash: string | null = null;
  const out: string[] = [];
  for (const tx of txs) {
    let vtx: VersionedTransaction;
    if (tx instanceof VersionedTransaction) {
      vtx = tx; // SDK が既に v0 + blockhash 設定済 (短命 — 速やかに sign/submit)
    } else {
      if (!blockhash) {
        blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      }
      const msg = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: tx.instructions,
      }).compileToV0Message();
      vtx = new VersionedTransaction(msg);
    }
    const required = new Set(
      vtx.message.staticAccountKeys
        .slice(0, vtx.message.header.numRequiredSignatures)
        .map((k) => k.toBase58())
    );
    const signers = ephemeralSigners.filter((k) =>
      required.has(k.publicKey.toBase58())
    );
    if (signers.length > 0) vtx.sign(signers);
    out.push(Buffer.from(vtx.serialize()).toString("base64"));
  }
  return out;
}
