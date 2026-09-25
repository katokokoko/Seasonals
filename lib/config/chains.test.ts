import { chainOfAddress, chainInfo, SUPPORTED_CHAINS } from "./chains";

describe("chains", () => {
  it("lists solana and ethereum with CAIP-2 ids", () => {
    expect(SUPPORTED_CHAINS.map((c) => c.caip2)).toEqual(["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:1"]);
    expect(chainInfo("ethereum").name).toBe("Ethereum");
  });
  it("detects address chain", () => {
    expect(chainOfAddress("0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1")).toBe("ethereum");
    expect(chainOfAddress("So11111111111111111111111111111111111111112")).toBe("solana");
    expect(chainOfAddress("0x1234")).toBeNull();
    expect(chainOfAddress("hello")).toBeNull();
  });
});
