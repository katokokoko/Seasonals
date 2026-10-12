/**
 * base64 ↔ Uint8Array (BFF が返す unsigned tx / wallet が返す署名済 tx)。
 * Buffer polyfill も @solana/web3.js も使わず、tx は bytes のまま wallet に渡す。
 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  // String.fromCharCode の引数上限を避けて 32KB ずつ
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
