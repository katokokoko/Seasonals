/**
 * protocol-icons — ロゴ登録漏れの検出 (Phase 8.44)
 *
 * `icon_id` は `string` 型なので、fixture に protocol を足してもロゴを登録し忘れると
 * typecheck も lint も通り、実機で初めて「頭文字バッジのまま」と気付く (実際 hylo /
 * exponent がその状態だった)。fixture 側を正として登録を強制する。
 */
import { fixtureMenuListings } from "@workspace/lib/__fixtures__/menu-listings";

import { ICON_BY_ID, scaleOf } from "./protocol-icons";

describe("protocol-icons", () => {
  it("menu fixture の全 protocol にロゴが登録されている", () => {
    const missing = fixtureMenuListings
      .filter((entry) => ICON_BY_ID[entry.icon_id] === undefined)
      .map((entry) => `${entry.display_name} (icon_id: ${entry.icon_id})`);
    expect(missing).toEqual([]);
  });

  it("8.44 で追加した hylo / exponent が引ける", () => {
    expect(ICON_BY_ID["hylo"]).toBeDefined();
    expect(ICON_BY_ID["exponent"]).toBeDefined();
  });

  it("scaleOf は未登録 id に default 1.0 を返す", () => {
    expect(scaleOf("hylo")).toBe(1.0);
    expect(scaleOf("does-not-exist")).toBe(1.0);
    expect(scaleOf("jupiter")).toBe(1.5); // 既存の補正は維持
  });
});
