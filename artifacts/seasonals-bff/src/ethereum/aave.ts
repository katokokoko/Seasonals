/**
 * Aave V4 — context only (Ethereum v3 §3 Aave V4: 「No calendar events」)。
 *
 * - AaveKit (`@aave/client` 6.6、api.aave.com GraphQL、key 不要) の userPositions で Hub/Spoke の
 *   position を読む。v3 の open item「AaveKit が V4 Hub/Spoke を扱えるか」は 2026-09-26 に確認済み
 *   (spokes / userPositions が Spoke id・名前を返す)
 * - 金額は API が返す decimal string をそのまま 8 桁 USD string に正規化 (Number で計算しない)
 * - health factor は比率なので表示用に string のまま渡す
 * - getEvents 相当は常に [] (Aave に日付のあるイベントは無い) — calendar には載せない
 */
import { sanitizeError } from "./client";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const aave = require("@aave/client") as typeof import("@aave/client");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require("@aave/client/actions") as typeof import("@aave/client/actions");

export interface AavePositionView {
  spokeName: string;
  spokeAddress: string;
  totalSuppliedUsd: string | null;
  totalDebtUsd: string | null;
  netBalanceUsd: string | null;
  /** 比率 (例 "3.15")。借入なしなら null */
  healthFactor: string | null;
  /** 0..1 の比率 */
  netApy: number | null;
  source: "aavekit";
  observedAt: string;
}

/** AaveKit は decimal を BigDecimal object で返す (Number() は throw)。toString() で文字列化する */
export function decimalString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof (v as { toString?: unknown }).toString === "function") {
    const s = String(v);
    return /^-?[0-9]+(\.[0-9]+)?$/.test(s) ? s : null;
  }
  return null;
}

/** "5112220.983" → "5112220.98300000" (8 桁、切り捨て)。負値・不正は null */
export function decimalTo8(value: unknown): string | null {
  const s = decimalString(value);
  if (s === null || !/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  value = s;
  const [i, f = ""] = (value as string).split(".");
  return `${i}.${(f + "00000000").slice(0, 8)}`;
}

let client: ReturnType<typeof aave.AaveClient.create> | null = null;
const getClient = () => (client ??= aave.AaveClient.create());

type Amount = { current?: { value?: unknown } } | { value?: unknown } | null | undefined;
const amountOf = (a: Amount) => decimalTo8(a && "current" in a ? a.current?.value : (a as { value?: unknown } | null | undefined)?.value);

export async function getAavePositions(address: string): Promise<AavePositionView[]> {
  const r = await actions.userPositions(getClient(), { user: aave.evmAddress(address), filter: { chainIds: [aave.chainId(1)] } } as never);
  if (r.isErr()) throw new Error(sanitizeError(r.error));
  const observedAt = new Date().toISOString();
  return (r.value as unknown as Array<Record<string, unknown>>).map((p) => {
    const spoke = p.spoke as { name?: string; address?: string };
    const hf = p.healthFactor as { current?: unknown } | null;
    const apy = p.netApy as { value?: unknown } | null;
    const apyStr = decimalString(apy?.value);
    // APY は比率 (0..1) なので表示用に number へ (CLAUDE.md §3 の適用外)
    const apyNum = apyStr !== null ? Number(apyStr) : NaN;
    return {
      spokeName: spoke?.name ?? "Spoke",
      spokeAddress: spoke?.address ?? "",
      totalSuppliedUsd: amountOf(p.totalSupplied as Amount),
      totalDebtUsd: amountOf(p.totalDebt as Amount),
      netBalanceUsd: amountOf(p.netBalance as Amount),
      healthFactor: decimalString(hf?.current),
      netApy: Number.isFinite(apyNum) ? apyNum : null,
      source: "aavekit",
      observedAt,
    };
  });
}
