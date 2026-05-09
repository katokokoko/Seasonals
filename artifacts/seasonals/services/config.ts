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
 * test 環境判定。jest globals の存在で識別する。
 * Metro bundler は jest variable を知らないため dead-code elimination で
 * production bundle からは消える。
 */
export const IS_TEST_ENV: boolean = typeof jest !== "undefined";
