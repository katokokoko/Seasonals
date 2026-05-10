/**
 * Mobile runtime config — BFF base URL の解決 (CLAUDE.md §10 task #5)
 *
 * 優先順位:
 *   1. `app.json` の `extra.bffBaseUrl` (build-time / EAS で env 別に override、
 *      production では実 BFF URL を必ず指定する)
 *   2. dev default: `http://localhost:3030`
 *      - port 3030 は Seasonals BFF 専用 (3000 は Next.js dev server 慣例で衝突回避)
 *      - Android (emulator / 実機 Seeker 共通): `adb reverse tcp:3030 tcp:3030` を
 *        Mac で実行しておく必要あり (Seeker localhost:3030 → Mac localhost:3030)
 *      - iOS simulator / web: localhost で直接届く
 *
 * test 環境 (typeof jest !== 'undefined') では fixture path を強制使用するため、
 * 本層の値は test では参照されない。
 */

import Constants from "expo-constants";

function resolveBffBaseUrl(): string {
  const fromExtra = Constants.expoConfig?.extra?.bffBaseUrl;
  if (typeof fromExtra === "string" && fromExtra.length > 0) {
    return fromExtra;
  }
  return "http://localhost:3030";
}

export const BFF_BASE_URL: string = resolveBffBaseUrl();

/**
 * Local APK / device preview safety net.
 *
 * `assembleRelease` で作った端末用 APK は `__DEV__ === false` だが、未指定時の
 * BFF URL は `localhost:3030` のままになる。Android 実機で localhost は端末自身を
 * 指すため、BFF 未起動時に Menu / Calendar / Portfolio が空になってしまう。
 *
 * 実 BFF URL (`https://...` 等) が `extra.bffBaseUrl` で指定された production build
 * では false になり、HTTP error をそのまま surface する。
 */
export const SHOULD_FALLBACK_TO_FIXTURES: boolean =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(
    BFF_BASE_URL
  );

/**
 * Phase 8.1: "Seasonals (onchain)" variant 判定。
 * `app.config.ts` で `expo.extra.useOnchain = true` がセットされている APK の場合のみ
 * true。usePositions が接続済 MWA address を BFF に渡し、Helius DAS 経由で実 mainnet
 * 保有を取得するためのフラグ。
 *
 * default APK ("Seasonals") は false → 既存通り fixture/BFF fixture が返る。
 */
export const USE_ONCHAIN: boolean =
  Constants.expoConfig?.extra?.useOnchain === true;

/**
 * test 環境判定。jest globals の存在で識別する。
 * Metro bundler は jest variable を知らないため dead-code elimination で
 * production bundle からは消える。
 */
export const IS_TEST_ENV: boolean = typeof jest !== "undefined";
