/**
 * amount-utils — ActionModal の金額入力の純関数 (Phase 8.16、RN 非依存で test 容易)。
 *
 * 経路別の「編集単位」(§4.5):
 *   deposit                : underlying 建て (TOKEN_DECIMALS[asset])
 *   withdraw swap-earn     : share 建て (jlUSDC / jitoSOL 等、metadata.share_decimals)
 *   withdraw save          : cToken 建て (cUSDC 等、metadata.share_decimals)
 *   withdraw kVault        : share 建て ("shares"、metadata.share_decimals)
 *   withdraw kamino reserve: underlying 建て (BFF が underlying_decimals で変換するため)
 *
 * 変換は必ず `toSmallestUnit` (throw する §4.5 バリデータ) 経由。`Number()` は使わない。
 */
import type { AgentPlan } from "@workspace/lib/types";
import { TOKEN_DECIMALS, toSmallestUnit } from "@workspace/lib/utils/numeric";
import {
  findMarketByProtocolAsset,
  findMarketByShareMint,
} from "@workspace/lib/config/swap-earn-markets";
import {
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
} from "@workspace/lib/config/kamino-markets";
import { findSaveMarketByCToken } from "@workspace/lib/config/save-markets";
import { findExponentMarketByPtMint } from "@workspace/lib/config/exponent-markets";

type Action = NonNullable<AgentPlan["selected_action"]>;

export interface AmountUnit {
  /** 入力の decimals (toSmallestUnit に渡す) */
  decimals: number;
  /** 入力欄の単位表示 ("USDC" / "jitoSOL" / "cUSDC" / "shares") */
  unitSymbol: string;
}

/** deposit の decimals 解決 (旧 ActionModal.resolveDecimals と同一挙動)。 */
function depositDecimals(asset?: string): number {
  if (asset && asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

/** action から編集単位 (decimals + 単位ラベル) を解決する。 */
export function resolveAmountUnit(
  action: Action | null | undefined
): AmountUnit {
  if (!action) return { decimals: 6, unitSymbol: "" };

  if (action.action_type === "withdraw") {
    const shareMint = action.metadata?.share_mint;
    const shareDecimals =
      typeof action.metadata?.share_decimals === "number"
        ? (action.metadata.share_decimals as number)
        : undefined;
    const underlyingDecimals =
      typeof action.metadata?.underlying_decimals === "number"
        ? (action.metadata.underlying_decimals as number)
        : undefined;
    if (typeof shareMint === "string") {
      // 8.38 (L6): 解決順は ActionModal の dispatch cascade
      // (swap-earn → kamino reserve → kVault → save → exponent) と同一に揃える。
      // registry 間で pubkey は disjoint (レビュー検証済) だが、将来の重複時に
      // 「入力単位の出所」と「tx を送る先」が食い違わないための順序統一
      const swap = findMarketByShareMint(shareMint);
      if (swap) {
        return {
          decimals: shareDecimals ?? swap.share_decimals,
          unitSymbol: swap.share_symbol,
        };
      }
      // kamino reserve: BFF が underlying_decimals で human 変換する underlying 建て
      const kaminoReserve = findKaminoMarketByReserve(shareMint);
      if (kaminoReserve) {
        return {
          decimals: underlyingDecimals ?? kaminoReserve.underlying_decimals,
          unitSymbol: kaminoReserve.underlying_symbol,
        };
      }
      const save = findSaveMarketByCToken(shareMint);
      if (save) {
        return {
          decimals: shareDecimals ?? save.underlying_decimals,
          unitSymbol: save.ctoken_symbol,
        };
      }
      const vault = findKaminoVaultByAddress(shareMint);
      if (vault) {
        return {
          decimals: shareDecimals ?? vault.shares_decimals,
          unitSymbol: "shares",
        };
      }
      // Exponent PT redeem (8.34): PT 建て入力 (share_mint = pt_mint)
      const exponentPt = findExponentMarketByPtMint(shareMint);
      if (exponentPt) {
        return {
          decimals: shareDecimals ?? exponentPt.pt_decimals,
          unitSymbol: `PT-${exponentPt.underlying_symbol}`,
        };
      }
    }
    // registry 未解決 (best-effort 等): metadata の decimals を信じ、asset を表示
    return {
      decimals: shareDecimals ?? underlyingDecimals ?? 6,
      unitSymbol: action.asset ?? "",
    };
  }

  // 8.38 (L7): deposit の decimals は解決できるなら market の underlying_decimals を
  // 優先する (グローバル TOKEN_DECIMALS 表との乖離で桁ズレしないため)。
  const depositProtocol =
    action.protocol === "jupiter" ? "jupiter_lend" : action.protocol;
  const market = action.asset
    ? findMarketByProtocolAsset(depositProtocol, action.asset)
    : undefined;
  return {
    decimals: market?.underlying_decimals ?? depositDecimals(action.asset),
    unitSymbol: action.asset ?? "",
  };
}

export type AmountValidation =
  | { ok: true; smallest: string }
  | { ok: false; error: string };

/**
 * human 入力 ("1.5") → smallest unit string。§4.5: toSmallestUnit のみで変換。
 * 空 / 不正文字 / 桁超過 / 0 は error (CTA を gate する)。
 */
export function validateAmountInput(
  input: string,
  decimals: number
): AmountValidation {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, error: "金額を入力してください" };
  }
  let smallest: string;
  try {
    smallest = toSmallestUnit(trimmed, decimals);
  } catch (e) {
    if (e instanceof RangeError) {
      return { ok: false, error: `小数は ${decimals} 桁までです` };
    }
    return { ok: false, error: "数値の形式が不正です" };
  }
  if (smallest === "0") {
    return { ok: false, error: "0 より大きい金額を入力してください" };
  }
  return { ok: true, smallest };
}

/** SOL deposit の MAX で fee/rent 用に確保する lamports (0.01 SOL)。 */
export const SOL_FEE_RESERVE_LAMPORTS = 10_000_000n;

/**
 * deposit MAX の smallest 値。SOL は fee/rent 予約を差し引く (負なら "0")。
 * balanceSmallest は §4.5 の integer string (不正なら null を返す)。
 */
export function depositMaxSmallest(
  balanceSmallest: string,
  asset: string | undefined
): string | null {
  if (!/^[0-9]+$/.test(balanceSmallest)) return null;
  let v = BigInt(balanceSmallest);
  if (asset === "SOL") {
    v = v > SOL_FEE_RESERVE_LAMPORTS ? v - SOL_FEE_RESERVE_LAMPORTS : 0n;
  }
  return v.toString();
}
