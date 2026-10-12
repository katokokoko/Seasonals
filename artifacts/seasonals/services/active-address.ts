/**
 * active-address — 読み取り対象の address と mode を決める純関数 (watch-only mode)
 *
 * home の positions / earn / wallet events / SKR / portfolioHistory は全部この address を
 * 見る (読み取りの起点は 1 箇所)。署名できるかどうか (`canSign`) とは分けて返す:
 *   - !useOnchain (fixture variant) → 常に none。watch UI も出さない
 *   - 接続 wallet の authorization がある → connected (status に依らず authorization 優先。
 *     reauthorize 中も表示を切らさない、従来の app/index.tsx と同じ)
 *   - 無ければ watch address → watch (read-only、canSign は常に false)
 *   - どちらも無い → none
 *
 * walletStore (web3.js) を import しないので jest で軽く回せる。hook は useActiveAddress.ts。
 */

export type ActiveAddressMode = "connected" | "watch" | "none";

export interface ActiveAddressInput {
  useOnchain: boolean;
  connectedAddress: string | null;
  isConnected: boolean;
  watchAddress: string | null;
}

export interface ActiveAddress {
  address: string | null;
  mode: ActiveAddressMode;
  /** MWA で署名できる状態か (connected かつ status === "connected" の時だけ) */
  canSign: boolean;
}

const NONE: ActiveAddress = { address: null, mode: "none", canSign: false };

export function resolveActiveAddress(input: ActiveAddressInput): ActiveAddress {
  if (!input.useOnchain) return NONE;
  if (input.connectedAddress) {
    return {
      address: input.connectedAddress,
      mode: "connected",
      canSign: input.isConnected,
    };
  }
  if (input.watchAddress) {
    return { address: input.watchAddress, mode: "watch", canSign: false };
  }
  return NONE;
}
