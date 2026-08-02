/**
 * deposited-mints — 預入判定 (Phase 8.62)。
 * Total / Deposited トグルの土台なので、registry の各系統が拾えることを固定する。
 */
import { SWAP_EARN_MARKETS } from "./swap-earn-markets";
import { SAVE_MARKETS } from "./save-markets";
import { KAMINO_VAULTS } from "./kamino-markets";
import { isDepositedMint } from "./deposited-mints";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

describe("isDepositedMint", () => {
  it("swap-earn の share token は預入 (jlUSDC / jitoSOL 等)", () => {
    const jlUsdc = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlUSDC")!;
    const jitoSol = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jitoSOL")!;
    expect(isDepositedMint(jlUsdc.share_mint)).toBe(true);
    expect(isDepositedMint(jitoSol.share_mint)).toBe(true);
  });

  it("Save の cToken は預入", () => {
    expect(isDepositedMint(SAVE_MARKETS[0]!.ctoken_mint)).toBe(true);
  });

  it("kVault の share (vault address) は預入", () => {
    expect(isDepositedMint(KAMINO_VAULTS[0]!.vault)).toBe(true);
  });

  it("生の USDC / SOL は預入ではない", () => {
    expect(isDepositedMint(USDC)).toBe(false);
    expect(isDepositedMint(SOL)).toBe(false);
  });

  it("未知の mint は預入ではない (registry が唯一の判断材料)", () => {
    expect(isDepositedMint("UnknownMint1111111111111111111111111111111")).toBe(
      false
    );
  });
});
