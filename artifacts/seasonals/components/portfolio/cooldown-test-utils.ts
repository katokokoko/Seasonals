/**
 * test 用: SkrStakingView を組み立てる (cooldown-display / StakingRow / CooldownEventDetail の test が共有)
 */
import type { CooldownFreshness } from "@workspace/lib/derive/cooldown-client";
import type { CooldownStateResponse } from "@workspace/lib/types";

import type { SkrStakingView } from "../../services/useSkrStakingView";

export function viewOf(
  state: CooldownStateResponse | undefined,
  freshness: CooldownFreshness,
  over: Partial<SkrStakingView> = {}
): SkrStakingView {
  return {
    address: state?.wallet_address ?? "W",
    scope: state
      ? { source: state.source, cluster: state.cluster, wallet_address: state.wallet_address }
      : { source: "live", cluster: "mainnet-beta", wallet_address: "W" },
    state,
    freshness,
    observedAt: state?.observed_at ?? null,
    isFetching: false,
    refetch: async () => undefined,
    ...over,
  };
}
