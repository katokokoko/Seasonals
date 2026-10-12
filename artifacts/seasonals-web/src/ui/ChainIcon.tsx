import type { ChainId } from "@workspace/lib/config/chains";
import ethereumLogo from "../assets/brands/ethereum.png";
import { IconSolana } from "./icons";

/**
 * Chain mark。Ethereum は公式ロゴ (カラー、縦長なので幅は比率なり)。
 * Solana は公式 asset が未提供のため単色の簡略 glyph のまま。
 */
export function ChainIcon({ chain, size = 16 }: { chain: ChainId; size?: number }) {
  if (chain === "ethereum") {
    return <img className="chain-logo" src={ethereumLogo} alt="" height={size} style={{ height: size, width: "auto" }} />;
  }
  return <IconSolana size={size} />;
}
