/**
 * Adapter Registry — protocol_id → Adapter の解決
 *
 * BFF / Mobile / MCP Server が `getLendingAdapter("kamino")` のように呼ぶ。
 * 起動時に register、以降は in-memory map で lookup。
 */

import type {
  AdapterRegistry,
  LendingAdapter,
  SwapAdapter,
} from "./types";
import { kaminoAdapter } from "./kamino";
import { jupiterAdapter } from "./jupiter";

class AdapterRegistryImpl implements AdapterRegistry {
  private lendings = new Map<string, LendingAdapter>();
  private swaps = new Map<string, SwapAdapter>();

  registerLending(adapter: LendingAdapter): void {
    this.lendings.set(adapter.meta.protocol_id, adapter);
  }
  registerSwap(adapter: SwapAdapter): void {
    this.swaps.set(adapter.meta.protocol_id, adapter);
  }
  getLending(protocol_id: string): LendingAdapter | undefined {
    return this.lendings.get(protocol_id);
  }
  getSwap(protocol_id: string): SwapAdapter | undefined {
    return this.swaps.get(protocol_id);
  }
  listLending(): LendingAdapter[] {
    return Array.from(this.lendings.values());
  }
  listSwap(): SwapAdapter[] {
    return Array.from(this.swaps.values());
  }
}

const registry = new AdapterRegistryImpl();
registry.registerLending(kaminoAdapter);
registry.registerSwap(jupiterAdapter);

export function getRegistry(): AdapterRegistry {
  return registry;
}

// 直接 export も (typed default で使う場合)
export { kaminoAdapter, jupiterAdapter };
