/**
 * protocol-icons — menu の protocol ロゴ解決 (Phase 8.44 で MenuDrawer から分離)
 *
 * ロゴは `assets/brands/<icon_id>.png` に置き、**静的 require** でバンドルに含める
 * (動的 URI は使わない)。`icon_id` は ProtocolMenuEntry のフィールドで、fixture
 * (`lib/__fixtures__/menu-listings.ts`) が唯一のソース。
 *
 * 画像の規約: **正方形・不透明・ブランド地色を焼き込み**。`iconBox` は
 * `overflow:hidden` の角丸なので、fixture の `icon_bg` を画像の地色と一致させないと
 * 角に別色が覗く。マークのキャンバス占有率は 0.5 前後 (kamino 基準) に揃えると
 * scale 補正なしで他と釣り合う。
 *
 * 未登録 id は MenuDrawer 側で頭文字バッジに fallback する。登録漏れは静かに
 * 起きる (icon_id が単なる string 型で typecheck が効かない) ため、
 * protocol-icons.test.ts で fixture 全 protocol の登録を強制している。
 */

import type { ImageRequireSource } from "react-native";

export const ICON_BY_ID: Record<string, ImageRequireSource> = {
  jupiter: require("../../assets/brands/jupiter.png"),
  kamino: require("../../assets/brands/kamino.png"),
  solstice: require("../../assets/brands/solstice.png"),
  sanctum: require("../../assets/brands/sanctum.png"),
  perena: require("../../assets/brands/perena.png"),
  savefi: require("../../assets/brands/savefi.png"),
  marinade: require("../../assets/brands/marinade.png"),
  meteora: require("../../assets/brands/meteora.png"),
  jito: require("../../assets/brands/jito.png"),
  orca: require("../../assets/brands/orca.png"),
  // 8.44 追加。マーク占有率は hylo 0.55 / exponent 0.50 で kamino (0.50) と同等 →
  // ICON_SCALE_BY_ID の補正は不要
  hylo: require("../../assets/brands/hylo.png"),
  exponent: require("../../assets/brands/exponent.png"),
};

// Phase 6.3: per-protocol icon visual balance 微調整。
// 元 PNG の内側 padding / aspect 比のバラつきを吸収するため transform scale を適用。
// 他 protocol は default 1.0。
const ICON_SCALE_BY_ID: Record<string, number> = {
  jupiter: 1.5,
  sanctum: 1.2,
};

export function scaleOf(id: string): number {
  return ICON_SCALE_BY_ID[id] ?? 1.0;
}
