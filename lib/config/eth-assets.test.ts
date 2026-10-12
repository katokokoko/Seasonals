import { ETH_ASSETS, ETH_NATIVE_KEY, findEthAsset, pendlePtAsset } from "./eth-assets";

describe("eth-assets registry", () => {
  it("keys are unique lowercase addresses (or the native pseudo key)", () => {
    const keys = ETH_ASSETS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of ETH_ASSETS) {
      if (a.key === ETH_NATIVE_KEY) expect(a.address).toBeNull();
      else expect(a.key).toBe(a.address!.toLowerCase());
    }
  });

  it("finds entries case-insensitively and marks stETH as rebasing", () => {
    const steth = findEthAsset("0xAE7AB96520DE3A18E5E111B5EAAB095312D7FE84");
    expect(steth?.symbol).toBe("stETH");
    expect(steth?.rebasing).toBe(true);
    expect(findEthAsset(ETH_NATIVE_KEY)?.category).toBe("other");
  });

  it("builds Pendle PT entries as deposited pt_yt", () => {
    const pt = pendlePtAsset("0xABC0000000000000000000000000000000000001", "PT-sUSDe", 18);
    expect(pt).toMatchObject({ key: "0xabc0000000000000000000000000000000000001", category: "pt_yt", deposited: true, protocolId: "pendle" });
  });
});
