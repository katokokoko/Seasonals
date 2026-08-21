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
  /** 預入を受け付けない (満杯 / 停止中 / 上流都合) */
  closed: boolean;
  /**
   * closed の理由。文言を変えるために使う:
   *   paused      … 上限 0 = protocol 側が預入を止めている
   *   full        … 枠が埋まった
   *   blocked     … 上流不具合で必ず失敗する market (BFF の
   *                 deposit_closed_reason="blocked"、8.91。残高不足とは別物)
   *   unavailable … 理由不明のまま BFF が閉じた (数値も理由も無い時の fallback)
   */
  reason?: "paused" | "full" | "blocked" | "unavailable";
}

/**
 * 大きい数を 1.2K / 3.4M / 5.6B / 7.8T に丸める (TVL 表示と同じ語彙)。
 * **切り捨て** (四捨五入しない) — 枠の表示なので残量を過大に見せない側に倒す。
 */
function compact(human: string): string {
  const [intPart = "0"] = human.split(".");
  const digits = intPart.replace(/,/g, "").length;
  const units: [number, string][] = [
    [13, "T"],
    [10, "B"],
    [7, "M"],
    [4, "K"],
  ];
  for (const [minDigits, suffix] of units) {
    if (digits >= minDigits) {
      const scale =
        suffix === "T" ? 12 : suffix === "B" ? 9 : suffix === "M" ? 6 : 3;
      const whole = intPart.replace(/,/g, "");
      const head = whole.slice(0, whole.length - scale) || "0";
      const tail = whole.slice(whole.length - scale, whole.length - scale + 1);
      return `${head}.${tail}${suffix}`;
    }
  }
  return intPart;
}

/**
 * pool から預入枠の表示を作る。枠情報が無く、かつ預入可能な protocol は null
 * (何も出さない)。
 *
 * 8.52: **`deposit_open === false` を先に見る**。枠の数値が取れていなくても
 * (BFF の on-chain 読みが失敗した日など)「押せない理由」は必ず出す — さもないと
 * 赤くも何ともない行がタップに無反応になる。
 */
export function depositCapView(
  pool: Pick<
    ProtocolPool,
    "deposit_cap" | "deposit_used" | "deposit_open" | "deposit_closed_reason" | "asset"
  >,
  decimals: number
): DepositCapView | null {
  const { deposit_cap: cap, deposit_used: used } = pool;
  const blocked = pool.deposit_open === false;
  // 8.91: BFF が理由を明示した場合はそれを優先 (数値の有無と独立に効く)
  const bffReason = pool.deposit_closed_reason;
  const valid =
    typeof cap === "string" &&
    typeof used === "string" &&
    /^[0-9]+$/.test(cap) &&
    /^[0-9]+$/.test(used);
  if (!valid) {
    // 数値は無いが「閉じている」ことだけは分かる場合 (§4.5: 不正な値は無視する)。
    // 8.91: BFF の理由があれば文言を具体化する (取れない日でも理由は出す、8.52 と同じ発想)
    if (!blocked) return null;
    if (bffReason === "blocked") {
      return { label: "Deposits blocked · upstream issue", ratio: 1, closed: true, reason: "blocked" };
    }
    if (bffReason === "suspended") {
      return { label: "Deposits paused", ratio: 1, closed: true, reason: "paused" };
    }
    if (bffReason === "full") {
      return { label: "Deposits full", ratio: 1, closed: true, reason: "full" };
    }
    return { label: "Deposits unavailable", ratio: 1, closed: true, reason: "unavailable" };
  }

  const capBig = BigInt(cap);
  const usedBig = BigInt(used);
  const amounts = `${compact(formatTokenAmount(used, decimals))} / ${compact(
    formatTokenAmount(cap, decimals)
  )} ${pool.asset}`;
  // 割合は bigint で 4 桁精度まで出してから小数へ (Number() で桁落ちさせない)。
  // 上限 0 (預入停止中) は分母 0 を避けて満杯 (1) 扱い
  const ratio =
    capBig === 0n
      ? 1
      : Math.max(0, Math.min(1, Number((usedBig * 10_000n) / capBig) / 10_000));
  // 8.91: 上流不具合 (blocked) は満杯/停止より根本原因なので最優先で出す
  // (BFF 側も blocked を full/suspended より優先して上書きする)
  if (bffReason === "blocked") {
    return {
      label: "Deposits blocked · upstream issue",
      ratio,
      closed: true,
      reason: "blocked",
    };
  }
  // 上限 0 = 預入停止中
  if (capBig === 0n) {
    return {
      label: `Deposits paused · ${compact(formatTokenAmount(used, decimals))} ${pool.asset}`,
      ratio: 1,
      closed: true,
      reason: "paused",
    };
  }
  if (usedBig >= capBig) {
    return { label: `Deposits full · ${amounts}`, ratio, closed: true, reason: "full" };
  }
  // 枠に空きがあるのに閉じている = 上限以外の理由 (上流の不具合等)。
  // 残量は情報として併記しつつ、押せない理由を先頭に出す
  if (blocked) {
    return {
      label: `Deposits unavailable · ${amounts}`,
      ratio,
      closed: true,
      reason: "unavailable",
    };
  }
  return { label: amounts, ratio, closed: false };
}
