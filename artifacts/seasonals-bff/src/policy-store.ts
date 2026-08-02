/**
 * policy-store — 編集可能な UserPolicy の in-memory override (Phase 8.29)
 *
 * §17/§25 の永続化前段。fixtureUserPolicyDefault をベースに、PATCH /user-policy
 * が上書きした差分を in-memory で保持する。override が無いときは fixture と
 * byte 一致するため、GET /user-policy の既存挙動は回帰しない。
 *
 * §4.5: max_tx_amount / min_tvl は USD 8-dec string を検証して受ける (Number 不使用)。
 */

import { isApprovalMode, isPositionCategory } from "@workspace/lib/types";
import type { PositionCategory, UserPolicy } from "@workspace/lib/types";
import { fixtureUserPolicyDefault } from "@workspace/lib/__fixtures__";
import { isValidUsdAmount } from "@workspace/lib/utils/numeric";

import { loadJson, saveJson } from "./persistence";

const PERSIST_KEY = "policy-override";

let override: Partial<UserPolicy> | null = null;

/** test 用: override クリア */
export function _resetPolicyForTest(): void {
  override = null;
}

/**
 * 起動時に永続化された policy override をロード (Phase 8.30)。
 * SEASONALS_DATA_DIR 未設定時は no-op (loadJson が null)。index.ts から呼ぶ。
 */
export function loadPersistedPolicy(): void {
  const saved = loadJson<Partial<UserPolicy>>(PERSIST_KEY);
  if (saved) override = saved;
}

/** 現在の UserPolicy (fixture + override)。override 無しは fixture と一致。 */
export function getCurrentPolicy(): UserPolicy {
  if (!override) return fixtureUserPolicyDefault;
  return {
    ...fixtureUserPolicyDefault,
    ...override,
    updated_at: new Date().toISOString(),
  };
}

export class PolicyPatchError extends Error {
  constructor(readonly field: string) {
    super(`invalid_policy_field: ${field}`);
    this.name = "PolicyPatchError";
  }
}

function isNullableUsd(v: unknown): boolean {
  return v === null || isValidUsdAmount(v);
}
function isNullableNonNegInt(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
}

/**
 * 許可フィールドのみ検証して override を更新 (§6.4 の editable 制約)。
 * 未知/不正フィールドは PolicyPatchError。
 */
export function patchCurrentPolicy(patch: Record<string, unknown>): UserPolicy {
  const next: Partial<UserPolicy> = { ...(override ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "approval_mode":
        if (!isApprovalMode(value)) throw new PolicyPatchError(key);
        next.approval_mode = value;
        break;
      case "max_tx_amount":
      case "min_tvl": {
        if (key === "min_tvl" ? !isValidUsdAmount(value) : !isNullableUsd(value)) {
          throw new PolicyPatchError(key);
        }
        next[key] = value as UserPolicy["min_tvl"];
        break;
      }
      case "max_daily_executions":
      case "max_lock_days":
        if (!isNullableNonNegInt(value)) throw new PolicyPatchError(key);
        next[key] = value as number | null;
        break;
      case "min_risk_score":
        if (typeof value !== "number" || value < 0 || value > 1) {
          throw new PolicyPatchError(key);
        }
        next.min_risk_score = value;
        break;
      case "enabled_protocols":
      case "enabled_assets":
        if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
          throw new PolicyPatchError(key);
        }
        next[key] = value as string[];
        break;
      case "enabled_categories":
        if (!Array.isArray(value) || value.some((x) => !isPositionCategory(x))) {
          throw new PolicyPatchError(key);
        }
        next.enabled_categories = value as PositionCategory[];
        break;
      default:
        throw new PolicyPatchError(key);
    }
  }
  override = next;
  saveJson(PERSIST_KEY, override); // Phase 8.30: 再起動後も残す (no-op if disabled)
  return getCurrentPolicy();
}
