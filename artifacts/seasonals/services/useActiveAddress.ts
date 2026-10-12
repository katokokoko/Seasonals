/**
 * useActiveAddress — 読み取り対象の address / mode を返す hook (watch-only mode)
 *
 * walletStore (接続 wallet) と watch store (監視 address) を合成する。判定は
 * active-address.ts の純関数 (接続 wallet 優先、fixture variant は常に none)。
 * watch は authorization を書かないので、`mode === "watch"` の間は署名経路に入らない。
 *
 * @see ./active-address.ts
 * @see ../stores/watch.ts
 */

import { useMemo } from "react";

import { USE_ONCHAIN } from "./config";
import { useWalletStore } from "./walletStore";
import { resolveActiveAddress, type ActiveAddress } from "./active-address";
import { useWatchStore } from "../stores/watch";

export type { ActiveAddress, ActiveAddressMode } from "./active-address";

export function useActiveAddress(): ActiveAddress {
  const connectedAddress = useWalletStore((s) => s.authorization?.address ?? null);
  const isConnected = useWalletStore(
    (s) => s.status === "connected" && s.authorization !== null
  );
  const watchAddress = useWatchStore((s) => s.selected);
  return useMemo(
    () =>
      resolveActiveAddress({
        useOnchain: USE_ONCHAIN,
        connectedAddress,
        isConnected,
        watchAddress,
      }),
    [connectedAddress, isConnected, watchAddress]
  );
}
