import { SWAP_EARN_MARKETS } from "../config/swap-earn-markets";
import { chooseDepositFunding, depositAcceptedSymbols } from "./deposit-funding";

const jlJupUsd = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlJupUSD")!;
const jlUsdc = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlUSDC")!;
const USDC = jlUsdc.underlying_mint;
const JUPUSD = jlJupUsd.underlying_mint;

describe("chooseDepositFunding (2026-10-13 funding deposit)", () => {
  it("underlying を保有していれば underlying (funding も持っていても)", () => {
    expect(chooseDepositFunding(jlJupUsd, [{ mint: JUPUSD, amount: "1000000" }, { mint: USDC, amount: "5000000" }])).toEqual({ kind: "underlying" });
  });
  it("underlying 無し + funding (USDC) 保有 → funding", () => {
    const c = chooseDepositFunding(jlJupUsd, [{ mint: USDC, amount: "5000000" }]);
    expect(c.kind).toBe("funding");
    expect(c.kind === "funding" && c.token.symbol).toBe("USDC");
  });
  it("どちらも無い / 残高 0 → none (受け付ける token を列挙)", () => {
    expect(chooseDepositFunding(jlJupUsd, [])).toEqual({ kind: "none", accepts: ["JupUSD", "USDC"] });
    expect(chooseDepositFunding(jlJupUsd, [{ mint: USDC, amount: "0" }, { mint: JUPUSD, amount: "00" }]).kind).toBe("none");
  });
  it("funding allowlist の無い market (jlUSDC) は underlying か none だけ", () => {
    expect(chooseDepositFunding(jlUsdc, [{ mint: USDC, amount: "1" }])).toEqual({ kind: "underlying" });
    expect(chooseDepositFunding(jlUsdc, [{ mint: JUPUSD, amount: "1" }])).toEqual({ kind: "none", accepts: ["USDC"] });
  });
  it("mint で判定する (symbol の表記揺れに依存しない)", () => {
    expect(chooseDepositFunding(jlJupUsd, [{ mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", amount: "1" }]).kind).toBe("none");
  });
  it("depositAcceptedSymbols", () => {
    expect(depositAcceptedSymbols(jlJupUsd)).toEqual(["JupUSD", "USDC"]);
    expect(depositAcceptedSymbols(jlUsdc)).toEqual(["USDC"]);
  });
});
