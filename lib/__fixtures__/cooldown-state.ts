/**
 * Cooldown state fixtures (docs/skr-r0-implementation.md §6「入力パターンは同じfixture群で共有する」)
 *
 * すべて lib/derive/cooldown-position.ts の関数で生成する。BFF / MCP / Mobile の test が
 * 同じ fixture から同じ event を得ることで、R0-07 (Mobile と MCP の event 一致) を検査できる。
 *
 * config / Clock / slot の値は取得済み mainnet batch (skr-staking/protocol-reference-20260920.json)
 * と同じ (cooldown-position.test.ts で一致を検査)。UserStake は合成値 (P0 の live pending は未取得)。
 */

import {
  SKR_DECIMALS,
  SKR_GUARDIAN_POOL,
  SKR_MINT,
  SKR_SHARE_PRICE_SCALE,
  SKR_STAKING_CLUSTER,
  SKR_STAKING_PROTOCOL_ID,
  SKR_SYMBOL,
} from "../config/skr-staking";
import {
  failedCooldownState,
  freshCooldownState,
  type CooldownDeriveInput,
  type CooldownUserState,
} from "../derive/cooldown-position";
import {
  CooldownDataStatus,
  CooldownSource,
  type CooldownLiquidView,
  type CooldownStateResponse,
} from "../types/cooldown-position";
import { fixtureWalletMain } from "./wallets";

/** fixtureWalletMain の address */
export const FIXTURE_SKR_WALLET = fixtureWalletMain.address;
/** PDA ["user_stake", SKR_STAKE_CONFIG, FIXTURE_SKR_WALLET, SKR_GUARDIAN_POOL] (BFF test で導出と一致を検査) */
export const FIXTURE_SKR_POSITION_ACCOUNT = "91vbFLRkAgeMCzf8YgEoR4bDkuwiPYgSfvJ5rBUJHbjt";

/** 取得済み batch の値 (protocol-reference-20260920.json) */
export const FIXTURE_SKR_OBSERVED_AT = "2026-09-20T14:21:10.127Z";
export const FIXTURE_SKR_SLOT = 448756823;
export const FIXTURE_SKR_CHAIN_TIME = "1789914002";
export const FIXTURE_SKR_COOLDOWN_SECONDS = "172800";
export const FIXTURE_SKR_SHARE_PRICE = "1141844787";

/** 合成 UserStake: 1,000,000 shares 相当 / 解除待ち 250 SKR */
export const FIXTURE_SKR_SHARES = "1000000000000";
export const FIXTURE_SKR_PENDING_AMOUNT = "250000000";
/** cooling_down: 観測の 1 時間前に解除開始 → 終了まで 47 時間 */
export const FIXTURE_SKR_UNSTAKE_TS_COOLING = (BigInt(FIXTURE_SKR_CHAIN_TIME) - 3600n).toString();
/** ready: cooldown + 60 秒前に解除開始 */
export const FIXTURE_SKR_UNSTAKE_TS_READY = (
  BigInt(FIXTURE_SKR_CHAIN_TIME) -
  BigInt(FIXTURE_SKR_COOLDOWN_SECONDS) -
  60n
).toString();

export const fixtureCooldownLiquid: CooldownLiquidView = {
  amount: "5000000",
  slot: FIXTURE_SKR_SLOT + 1,
  observed_at: FIXTURE_SKR_OBSERVED_AT,
  data_status: CooldownDataStatus.Fresh,
};

/** fixture の derive 入力を作る (test は over で一部だけ変える) */
export function fixtureCooldownDeriveInput(
  over: {
    source?: CooldownSource;
    user?: CooldownUserState | null;
    chain_time?: string;
    slot?: number;
    cooldown_seconds?: string;
    share_price?: string;
  } = {}
): CooldownDeriveInput {
  return {
    scope: {
      source: over.source ?? CooldownSource.Live,
      cluster: SKR_STAKING_CLUSTER,
      wallet_address: FIXTURE_SKR_WALLET,
      protocol_id: SKR_STAKING_PROTOCOL_ID,
      position_account: FIXTURE_SKR_POSITION_ACCOUNT,
      pool: SKR_GUARDIAN_POOL,
    },
    asset: { mint: SKR_MINT, symbol: SKR_SYMBOL, decimals: SKR_DECIMALS },
    share_price_scale: SKR_SHARE_PRICE_SCALE,
    config: {
      cooldown_seconds: over.cooldown_seconds ?? FIXTURE_SKR_COOLDOWN_SECONDS,
      share_price: over.share_price ?? FIXTURE_SKR_SHARE_PRICE,
    },
    observed_at: FIXTURE_SKR_OBSERVED_AT,
    slot: over.slot ?? FIXTURE_SKR_SLOT,
    chain_time: over.chain_time ?? FIXTURE_SKR_CHAIN_TIME,
    user:
      over.user === undefined
        ? {
            shares: FIXTURE_SKR_SHARES,
            pending_amount: FIXTURE_SKR_PENDING_AMOUNT,
            unstake_timestamp: FIXTURE_SKR_UNSTAKE_TS_COOLING,
          }
        : over.user,
  };
}

const coolingUser: CooldownUserState = {
  shares: FIXTURE_SKR_SHARES,
  pending_amount: FIXTURE_SKR_PENDING_AMOUNT,
  unstake_timestamp: FIXTURE_SKR_UNSTAKE_TS_COOLING,
};

/** active と pending の両方がある、解除待ち中 */
export const fixtureCooldownStateCoolingDown: CooldownStateResponse = freshCooldownState(
  fixtureCooldownDeriveInput({ user: coolingUser }),
  fixtureCooldownLiquid
);

/** 解除待ちが終わり、withdraw 可能 (chain Clock 基準) */
export const fixtureCooldownStateReady: CooldownStateResponse = freshCooldownState(
  fixtureCooldownDeriveInput({
    user: { ...coolingUser, unstake_timestamp: FIXTURE_SKR_UNSTAKE_TS_READY },
  }),
  fixtureCooldownLiquid
);

/** stake のみ、解除待ち無し (event 0 件) */
export const fixtureCooldownStateNone: CooldownStateResponse = freshCooldownState(
  fixtureCooldownDeriveInput({
    user: { shares: FIXTURE_SKR_SHARES, pending_amount: "0", unstake_timestamp: "0" },
  }),
  fixtureCooldownLiquid
);

/** UserStake account が無い (正常な空状態) */
export const fixtureCooldownStateAbsent: CooldownStateResponse = freshCooldownState(
  fixtureCooldownDeriveInput({ user: null }),
  fixtureCooldownLiquid
);

const fixtureScope = fixtureCooldownDeriveInput().scope;

/** RPC 失敗 / timeout */
export const fixtureCooldownStateUnavailable: CooldownStateResponse = failedCooldownState(
  fixtureScope,
  CooldownDataStatus.Unavailable,
  fixtureCooldownLiquid
);

/** 必須 account の検証失敗 */
export const fixtureCooldownStateUnsupported: CooldownStateResponse = failedCooldownState(
  fixtureScope,
  CooldownDataStatus.Unsupported,
  fixtureCooldownLiquid
);

/** 録画用 demo source の解除待ち */
export const fixtureCooldownStateDemoCoolingDown: CooldownStateResponse = freshCooldownState(
  fixtureCooldownDeriveInput({ source: CooldownSource.Demo, user: coolingUser }),
  fixtureCooldownLiquid
);
