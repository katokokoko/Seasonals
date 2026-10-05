/**
 * SKR staking の demo source (docs/skr-r0-implementation.md §1 P0、R0-DEMO)
 *
 * live pending を確保する前の録画 / 実機確認用。`source=demo` の時だけ使い、
 * live の失敗時に fallback として使うことは **無い** (route が source で分岐する)。
 *
 * - config / pool / vault / mint は取得済み mainnet batch の bytes をそのまま replay
 *   (cooldown 秒は config bytes から読む。固定値を持たない)
 * - UserStake (要求 wallet の PDA) と Clock だけを合成する
 * - 終了予定は BFF process 起動時の anchor + SKR_DEMO_UNLOCK_IN_SECONDS。poll 間で予定キーは不変。
 *   別の値で BFF を再起動すると「追加解除」と同じく同じ event id のまま予定が動く
 * - Clock.unix_timestamp = 現在時刻、slot は取得時 slot から 400ms/slot で単調に進める
 */
import { fixtureSkrProtocolReference as ref } from "@workspace/lib/__fixtures__/skr-staking/protocol-reference";
import { SKR_GUARDIAN_POOL, SKR_LAYOUT, SKR_STAKE_CONFIG } from "@workspace/lib/config/skr-staking";
import {
  clockAccount,
  encodeUserStake,
  programAccount,
  referenceAccounts,
  referenceClockFields,
} from "./skr-staking-encode";
import { deriveSkrAccounts, type RawAccount, type SkrRpc } from "./skr-staking";

export const SKR_DEMO_SCENARIOS = ["cooling_down", "ready", "none", "absent", "unsupported"] as const;
export type SkrDemoScenario = (typeof SKR_DEMO_SCENARIOS)[number];

export const SKR_DEMO_DEFAULT_UNLOCK_IN_SECONDS = 1800;
/** demo の合成量 (smallest unit): 1,000,000 shares 相当 / 解除待ち 250 SKR / wallet 5 SKR */
export const SKR_DEMO_SHARES = 1_000_000_000_000n;
export const SKR_DEMO_PENDING = 250_000_000n;
export const SKR_DEMO_LIQUID = "5000000";

export interface SkrDemoOptions {
  scenario: SkrDemoScenario;
  /** anchor から終了予定までの秒 (cooling_down) */
  unlockInSeconds: number;
  /** 予定の基準時刻 (ms)。BFF process で 1 回だけ決める */
  anchorMs: number;
  /** 現在時刻 (ms) */
  now: () => number;
}

/** `SKR_DEMO_FIXTURE=true` の時だけ demo source を受け付ける */
export function skrDemoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SKR_DEMO_FIXTURE === "true";
}

export function skrDemoOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  anchorMs: number = Date.now(),
  now: () => number = Date.now
): SkrDemoOptions {
  const raw = env.SKR_DEMO_SCENARIO;
  const scenario = (SKR_DEMO_SCENARIOS as readonly string[]).includes(raw ?? "")
    ? (raw as SkrDemoScenario)
    : "cooling_down";
  // 秒数 (時間) は金融値ではない
  const parsed = Number.parseInt(env.SKR_DEMO_UNLOCK_IN_SECONDS ?? "", 10);
  const unlockInSeconds = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : SKR_DEMO_DEFAULT_UNLOCK_IN_SECONDS;
  return { scenario, unlockInSeconds, anchorMs, now };
}

const CAPTURED_AT_MS = Date.parse(ref.captured_at);
const MS_PER_SLOT = 400;

function demoSlot(nowMs: number): number {
  const base = ref.rpc_response.result.context.slot;
  return base + Math.max(0, Math.floor((nowMs - CAPTURED_AT_MS) / MS_PER_SLOT));
}

/** 要求 wallet 用の demo RPC。live の RPC と同じ interface (検証も同じ経路を通る) */
export function createDemoSkrRpc(wallet: string, opts: SkrDemoOptions): SkrRpc {
  const addrs = deriveSkrAccounts(wallet);
  return {
    async getMultipleAccounts(addresses) {
      const nowMs = opts.now();
      const r = referenceAccounts();
      const cooldown = r.config.data.readBigUInt64LE(SKR_LAYOUT.stakeConfig.offsets.cooldown_seconds);
      const anchorSec = BigInt(Math.floor(opts.anchorMs / 1000));
      const unlockSec =
        opts.scenario === "ready" ? anchorSec - 60n : anchorSec + BigInt(opts.unlockInSeconds);

      let user: RawAccount | null = null;
      if (opts.scenario !== "absent") {
        const pending = opts.scenario === "none" ? 0n : SKR_DEMO_PENDING;
        user = programAccount(
          encodeUserStake({
            stake_config: SKR_STAKE_CONFIG,
            user: wallet,
            guardian_pool: SKR_GUARDIAN_POOL,
            shares: SKR_DEMO_SHARES,
            unstaking_amount: pending,
            unstake_timestamp: pending > 0n ? unlockSec - cooldown : 0n,
          })
        );
      }
      const config =
        opts.scenario === "unsupported"
          ? { owner: r.config.owner, data: r.config.data.subarray(0, r.config.data.length - 1) }
          : r.config;
      const clock = clockAccount({
        ...referenceClockFields(),
        slot: BigInt(demoSlot(nowMs)),
        unix_timestamp: BigInt(Math.floor(nowMs / 1000)),
      });

      const byAddress = new Map<string, RawAccount | null>([
        [addrs.config, config],
        [addrs.pool, r.pool],
        [addrs.userStake, user],
        [addrs.vault, r.vault],
        [addrs.mint, r.mint],
        [addrs.clock, clock],
      ]);
      return {
        slot: demoSlot(nowMs),
        accounts: addresses.map((a) => byAddress.get(a) ?? null),
      };
    },

    async getTokenAmountsByOwner() {
      return { slot: demoSlot(opts.now()), amounts: [SKR_DEMO_LIQUID] };
    },
  };
}
