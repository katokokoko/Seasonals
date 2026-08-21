/**
 * protocol-icons — ロゴ登録漏れの検出 (Phase 8.44)
 *
 * `icon_id` は `string` 型なので、fixture に protocol を足してもロゴを登録し忘れると
 * typecheck も lint も通り、実機で初めて「頭文字バッジのまま」と気付く (実際 hylo /
 * exponent がその状態だった)。fixture 側を正として登録を強制する。
 */
import { fixtureMenuListings } from "@workspace/lib/__fixtures__/menu-listings";

import {
  ICON_BY_ID,
  iconBgOf,
  iconIdOfProtocol,
  scaleOf,
} from "./protocol-icons";

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

  // 8.92: Wallet holdings 展開行の protocol アイコン解決
  it("iconIdOfProtocol は jupiter_lend → jupiter に読み替え、他は素通し", () => {
    expect(iconIdOfProtocol("jupiter_lend")).toBe("jupiter");
    expect(iconIdOfProtocol("jito")).toBe("jito");
    expect(iconIdOfProtocol("savefi")).toBe("savefi");
    expect(iconIdOfProtocol("unknown_protocol")).toBe("unknown_protocol");
  });

  it("registry 系 protocol_id は読み替え後に必ずロゴが引ける", () => {
    // deposited-breakdown が返しうる protocol_id (share_mint registry 群のもの)
    const registryProtocolIds = [
      "jupiter_lend",
      "jito",
      "marinade",
      "sanctum",
      "perena",
      "solstice",
      "hylo",
      "savefi",
      "kamino",
      "exponent",
    ];
    const missing = registryProtocolIds.filter(
      (id) => ICON_BY_ID[iconIdOfProtocol(id)] === undefined
    );
    expect(missing).toEqual([]);
  });

  it("iconBgOf は fixture の icon_bg を返し、未登録 id は null", () => {
    expect(iconBgOf("jupiter")).toBe("#0E1F3A"); // fixture ICON_BG_DARK
    expect(iconBgOf("does-not-exist")).toBeNull();
  });
});
