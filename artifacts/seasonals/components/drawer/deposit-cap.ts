/**
 * deposit-cap — 預入枠の表示ロジック (Phase 8.51)
 *
 * BFF が Kamino の reserve から読んだ預入枠 (`deposit_cap` / `deposit_used` /
 * `deposit_open`) を、メニューに出す 1 行に落とす純関数。UI から切り離してあるので
 * 単体テストできる (MenuDrawer 自体は 2000 行超で render テストが重い)。
 *
 * §4.5: cap / used は smallest unit の string。**`Number()` を使わず**
 * `formatTokenAmount` で表示用に整形し、割合の計算のみ bigint で行う。
 */
import { formatTokenAmount } from "@workspace/lib/utils/numeric";
import type { ProtocolPool } from "@workspace/lib/types";

export interface DepositCapView {
  /** 例: "107M / 1.00B USDC" */
  label: string;
  /** 使用率 0..1 (上限 0 = 停止中なら 1) */
  ratio: number;
  /** 預入を受け付けない (満杯 or 停止中) */
  closed: boolean;
  /** closed の理由。停止中と満杯で文言を変える */
  reason?: "paused" | "full";
}

/** 大きい数を 1.2K / 3.4M / 5.6B に丸める (TVL 表示と同じ語彙) */
function compact(human: string): string {
  const [intPart = "0"] = human.split(".");
  const digits = intPart.replace(/,/g, "").length;
  const units: [number, string][] = [
    [10, "B"],
    [7, "M"],
    [4, "K"],
  ];
  for (const [minDigits, suffix] of units) {
    if (digits >= minDigits) {
      const scale = suffix === "B" ? 9 : suffix === "M" ? 6 : 3;
      const whole = intPart.replace(/,/g, "");
      const head = whole.slice(0, whole.length - scale) || "0";
      const tail = whole.slice(whole.length - scale, whole.length - scale + 1);
      return `${head}.${tail}${suffix}`;
    }
  }
  return intPart;
}

/**
 * pool から預入枠の表示を作る。枠情報が無い protocol は null (何も出さない)。
 */
export function depositCapView(
  pool: Pick<
    ProtocolPool,
    "deposit_cap" | "deposit_used" | "deposit_open" | "asset"
  >,
  decimals: number
): DepositCapView | null {
  const { deposit_cap: cap, deposit_used: used } = pool;
  if (typeof cap !== "string" || typeof used !== "string") return null;
  if (!/^[0-9]+$/.test(cap) || !/^[0-9]+$/.test(used)) return null;

  const capBig = BigInt(cap);
  const usedBig = BigInt(used);
  // 上限 0 = 預入停止中。分母 0 の割り算を避けつつ「満杯」として見せる
  if (capBig === 0n) {
    return {
      label: `Deposits paused · ${compact(formatTokenAmount(used, decimals))} ${pool.asset}`,
      ratio: 1,
      closed: true,
      reason: "paused",
    };
  }
  // 割合は bigint で 4 桁精度まで出してから小数へ (Number() で桁落ちさせない)
  const permyriad = Number((usedBig * 10_000n) / capBig) / 10_000;
  const ratio = Math.max(0, Math.min(1, permyriad));
  const closed = pool.deposit_open === false || usedBig >= capBig;
  const label = `${compact(formatTokenAmount(used, decimals))} / ${compact(
    formatTokenAmount(cap, decimals)
  )} ${pool.asset}`;
  return closed
    ? { label, ratio, closed, reason: "full" }
    : { label, ratio, closed };
}
