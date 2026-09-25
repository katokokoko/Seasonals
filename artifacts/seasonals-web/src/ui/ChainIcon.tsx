import type { ChainId } from "@workspace/lib/config/chains";
import { IconEthereum, IconSolana } from "./icons";

export function ChainIcon({ chain, size = 16 }: { chain: ChainId; size?: number }) {
  return chain === "ethereum" ? <IconEthereum size={size} /> : <IconSolana size={size} />;
}
