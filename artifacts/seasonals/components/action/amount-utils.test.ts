/**
 * Phase 8.16: 金額入力の純関数ヘルパー検証 (RN render 不要)。
 */
import type { AgentPlan } from "@workspace/lib/types";
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import {
  KAMINO_MARKETS,
  KAMINO_VAULTS,
} from "@workspace/lib/config/kamino-markets";
import { EXPONENT_MARKETS } from "@workspace/lib/config/exponent-markets";
import {
  depositMaxSmallest,
  resolveAmountUnit,
  validateAmountInput,
  validateDepositAgainstBalance,
} from "./amount-utils";

type Action = NonNullable<AgentPlan["selected_action"]>;

function action(partial: Partial<Action>): Action {
  return {
    action_type: "deposit",
    protocol: "jupiter_lend",
    asset: "USDC",
    amount: "100000",
    ...partial,
  } as Action;
}

const JITO = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jito")!;
const SAVE_USDC = SAVE_MARKETS.find((m) => m.underlying_symbol === "USDC")!;
const KAMINO_SOL = KAMINO_MARKETS.find((m) => m.underlying_symbol === "SOL")!;
const VAULT_USDC = KAMINO_VAULTS.find((v) => v.underlying_symbol === "USDC")!;

describe("resolveAmountUnit", () => {
  it("deposit: TOKEN_DECIMALS 建て (USDC=6 / SOL=9)", () => {
    expect(resolveAmountUnit(action({ asset: "USDC" }))).toEqual({
      decimals: 6,
      unitSymbol: "USDC",
    });
    expect(resolveAmountUnit(action({ asset: "SOL" }))).toEqual({
      decimals: 9,
      unitSymbol: "SOL",
    });
  });

  it("withdraw swap-earn: share 建て (jitoSOL)", () => {
    const u = resolveAmountUnit(
      action({
        action_type: "withdraw",
        metadata: { share_mint: JITO.share_mint, share_decimals: 9 },
      } as never)
    );
    expect(u).toEqual({ decimals: 9, unitSymbol: "jitoSOL" });
  });

  it("withdraw save: cToken 建て (cUSDC)", () => {
    const u = resolveAmountUnit(
      action({
        action_type: "withdraw",
        metadata: { share_mint: SAVE_USDC.ctoken_mint, share_decimals: 6 },
      } as never)
    );
    expect(u).toEqual({ decimals: 6, unitSymbol: "cUSDC" });
  });

  it("withdraw kamino reserve: underlying 建て (SOL 9)", () => {
    const u = resolveAmountUnit(
      action({
        action_type: "withdraw",
        metadata: {
          share_mint: KAMINO_SOL.reserve,
          share_decimals: 9,
          underlying_decimals: 9,
        },
      } as never)
    );
    expect(u).toEqual({ decimals: 9, unitSymbol: "SOL" });
  });

  it("withdraw kVault: shares 建て", () => {
    const u = resolveAmountUnit(
      action({
        action_type: "withdraw",
        metadata: { share_mint: VAULT_USDC.vault, share_decimals: 6 },
      } as never)
    );
    expect(u).toEqual({ decimals: 6, unitSymbol: "shares" });
  });

  it("8.34 withdraw Exponent PT: PT 建て (pt_mint 経由)", () => {
    const usx = EXPONENT_MARKETS.find((m) => m.underlying_symbol === "USX")!;
    const u = resolveAmountUnit(
      action({
        action_type: "withdraw",
        metadata: { share_mint: usx.pt_mint },
      } as never)
    );
    expect(u).toEqual({ decimals: usx.pt_decimals, unitSymbol: "PT-USX" });
  });

  it("action null は安全な default", () => {
    expect(resolveAmountUnit(null)).toEqual({ decimals: 6, unitSymbol: "" });
  });
});

describe("validateAmountInput", () => {
  it("正常入力 → smallest 変換", () => {
    expect(validateAmountInput("1.5", 6)).toEqual({ ok: true, smallest: "1500000" });
    expect(validateAmountInput("0.000001", 6)).toEqual({ ok: true, smallest: "1" });
  });
  it("桁超過 / 不正文字 / 空 / 0 は error", () => {
    expect(validateAmountInput("1.1234567", 6).ok).toBe(false);
    expect(validateAmountInput("1..5", 6).ok).toBe(false);
    expect(validateAmountInput("abc", 6).ok).toBe(false);
    expect(validateAmountInput("", 6).ok).toBe(false);
    expect(validateAmountInput("0", 6).ok).toBe(false);
    expect(validateAmountInput("0.000", 6).ok).toBe(false);
  });
});

describe("depositMaxSmallest", () => {
  it("SOL は 0.01 SOL の fee 予約を差し引く", () => {
    expect(depositMaxSmallest("1000000000", "SOL")).toBe("990000000");
    expect(depositMaxSmallest("5000000", "SOL")).toBe("0"); // 予約未満
  });
  it("SOL 以外は全額", () => {
    expect(depositMaxSmallest("1500000", "USDC")).toBe("1500000");
  });
  it("不正 balance は null", () => {
    expect(depositMaxSmallest("1.5", "USDC")).toBeNull();
  });
});

describe("8.80: validateDepositAgainstBalance (残高超過の署名前 gate)", () => {
  it("残高超過 → error (symbol と保有量が文言に出る)", () => {
    const r = validateDepositAgainstBalance("100000", "0", "JupUSD", 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Insufficient JupUSD — you have 0");
  });

  it("保有量は human 表示 (12.34 USDC 持ちで 20 は不足)", () => {
    const r = validateDepositAgainstBalance("20000000", "12340000", "USDC", 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("12.34");
  });

  it("同額 / 未満は ok (境界)", () => {
    expect(validateDepositAgainstBalance("12340000", "12340000", "USDC", 6).ok).toBe(true);
    expect(validateDepositAgainstBalance("1", "12340000", "USDC", 6).ok).toBe(true);
  });

  it("残高不明 (null) は誤ブロックしない — BFF gate が後段で拾う", () => {
    expect(validateDepositAgainstBalance("100000", null, "USDC", 6).ok).toBe(true);
  });

  it("壊れた残高文字列は不明扱いで ok", () => {
    expect(validateDepositAgainstBalance("100000", "1.5", "USDC", 6).ok).toBe(true);
  });
});
