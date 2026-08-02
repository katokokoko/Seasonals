/**
 * solana-devnet — 自律実行の devnet 署名/broadcast client (Phase 8.29)
 *
 * bounded 委任署名は **devnet 限定** のハードガードをここに集約する。
 * RPC URL に "devnet" が含まれなければ DevnetGuardError を throw し、
 * mainnet で自律実行が動くことを構造的に不可能にする。
 *
 * mockable: autonomous.test.ts は `jest.mock("./clients/solana-devnet")` で
 * 実 network を掴まない。
 */

import {
  Connection,
  type Keypair,
  Transaction,
} from "@solana/web3.js";

const DEFAULT_DEVNET_URL = "https://api.devnet.solana.com";

export class DevnetGuardError extends Error {
  readonly code = "not_devnet";
  constructor(url: string) {
    super(`autonomous execution is devnet-only (SOLANA_RPC_URL=${url})`);
    this.name = "DevnetGuardError";
  }
}

/** RPC URL が devnet を指しているか (env の lazy read、testability)。 */
export function isDevnetRpc(): boolean {
  const url = process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_URL;
  return url.includes("devnet");
}

let cached: Connection | null = null;

/** devnet connection。非 devnet なら DevnetGuardError。 */
export function getDevnetConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_URL;
  if (!url.includes("devnet")) {
    throw new DevnetGuardError(url);
  }
  if (!cached) {
    cached = new Connection(url, "confirmed");
  }
  return cached;
}

/**
 * tx に blockhash/feePayer をセットして signer で署名 → broadcast → confirm。
 * 委任鍵で署名した bounded tx をここで確定させる。confirmed 署名を返す。
 */
export async function sendAndConfirmDevnetTx(
  tx: Transaction,
  signer: Keypair
): Promise<string> {
  const conn = getDevnetConnection();
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

/** test 用: connection cache クリア */
export function _clearDevnetConnectionForTest(): void {
  cached = null;
}
