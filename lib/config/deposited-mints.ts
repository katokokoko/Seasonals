/**
 * deposited-mints — その mint が「protocol に預けた資産」かの判定 (Phase 8.62)
 *
 * ウォレットに入っている token は 2 種類ある:
 *   - **生の資産** (USDC / SOL など。ただ持っているだけ)
 *   - **預入の証** (jlUSDC / jitoSOL / cToken / PT など。protocol で働いている)
 *
 * Portfolio の `Total` / `Deposited` トグルはこの区別で切り替える。
 * BFF (履歴の集計) と mobile (見出しの金額) の両方が使うので lib に置く (§1)。
 *
 * **含まれないもの**: Kamino の obligation、Meteora / Orca の LP position は
 * SPL token として wallet に来ないため、そもそも DAS の token 一覧に現れない。
 * したがって本判定の対象外で、履歴にも計上されていない (別の取得経路が要る)。
 */

import { KNOWN_PROTOCOL_MINTS } from "../__fixtures__/known-mints";
import { findExponentMarketByPtMint } from "./exponent-markets";
import { findKaminoVaultByAddress } from "./kamino-markets";
import { findSaveMarketByCToken } from "./save-markets";
import { findMarketByShareMint } from "./swap-earn-markets";

/** `wallet_stable` / `wallet_sol` / `wallet_holding` = 預入ではない */
function isWalletProtocol(protocolId: string): boolean {
  return protocolId.startsWith("wallet_");
}

/**
 * この mint は protocol への預入を表すか。
 * registry のいずれかに hit すれば預入とみなす (registry が唯一の判断材料)。
 */
export function isDepositedMint(mint: string): boolean {
  if (findMarketByShareMint(mint)) return true; // swap-earn (jlToken / LST / USD* …)
  if (findSaveMarketByCToken(mint)) return true; // Save の cToken
  if (findExponentMarketByPtMint(mint)) return true; // Exponent PT
  if (findKaminoVaultByAddress(mint)) return true; // kVault share
  const known = KNOWN_PROTOCOL_MINTS[mint];
  if (known && !isWalletProtocol(known.protocol_id)) return true;
  return false;
}
