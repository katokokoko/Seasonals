/**
 * Mobile runtime config — BFF base URL の解決 (CLAUDE.md §10 task #5)
 *
 * 優先順位:
 *   1. `app.config.ts` の `extra.bffBaseUrl` (build-time の `BFF_BASE_URL` env)
 *      - 配布 build は eas.json の `preview-onchain` / `production-onchain` profile が
 *        `BFF_BASE_URL=https://api.seasonals.cafe` (+ `APP_VARIANT=onchain`) を渡し、
 *        Gradle build 中に expo-constants が extra として APK に焼き込む。
 *        profile env に無いと localhost + fixture fallback の APK が黙ってできる
 *        (docs/external-release-api-handling.md §7)
 *      - dev で別ポートの BFF と並走する時は Metro 起動時に `BFF_BASE_URL=http://localhost:3031`
 *        を渡す (app.config.ts が extra に入れる。docs/skr-r0-demo-runbook.md §2)
 *   2. dev default: `http://localhost:3030`
 *      - port 3030 は Seasonals BFF 専用 (3000 は Next.js dev server 慣例で衝突回避)
 *      - Android (emulator / 実機 Seeker 共通): `adb reverse tcp:3030 tcp:3030` を
 *        Mac で実行しておく必要あり (Seeker localhost:3030 → Mac localhost:3030)。
 *        dev-client を使う場合は Metro の `tcp:8081` も同様に転送する。
 *        この転送は端末スリープ / USB 抜き差しで黙って消えるため、実機作業中は
 *        `pnpm dev:device` (scripts/adb-reverse-keepalive.sh) を常駐させて
 *        自動で張り直す。消えた時の症状と対処はそのヘッダに書いてある
 *      - iOS simulator / web: localhost で直接届く
 *
 * test 環境 (typeof jest !== 'undefined') では fixture path を強制使用するため、
 * 本層の値は test では参照されない。
 */

import Constants from "expo-constants";
import { CooldownSource } from "@workspace/lib/types";

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
 * BFF URL は `localhost:3030` のままになる (local の `./gradlew assembleRelease` は
 * EAS の keystore が無いので unsigned。android/app/build.gradle の signingConfigs 参照)。
 * Android 実機で localhost は端末自身を指すため、BFF 未起動時に Menu / Calendar /
 * Portfolio が空になってしまう。
 *
 * 実 BFF URL (`https://...` 等) が `extra.bffBaseUrl` で指定された配布 build
 * (`preview-onchain` / `production-onchain`) では false になり、HTTP error をそのまま
 * surface する (公開 BFF の失敗を fixture で隠さない)。
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
 * SKR staking cooldown の取得元 (docs/skr-r0-implementation.md §1 P0)。
 * Metro を `SKR_SOURCE=demo` で起動した時だけ "demo" (BFF 側も SKR_DEMO_FIXTURE=true が必要)。
 * それ以外は "live"。live の失敗を demo / fixture に差し替えることはしない。
 */
export const SKR_SOURCE: CooldownSource =
  Constants.expoConfig?.extra?.skrSource === CooldownSource.Demo
    ? CooldownSource.Demo
    : CooldownSource.Live;

/**
 * test 環境判定。jest globals の存在で識別する。
 * Metro bundler は jest variable を知らないため dead-code elimination で
 * production bundle からは消える。
 */
export const IS_TEST_ENV: boolean = typeof jest !== "undefined";

/**
 * 公開 site (docs/external-release-api-handling.md §7)。MWA dapp identity の uri
 * (services/mwa.ts DEFAULT_IDENTITY) もここを指す。wallet が dapp を検証できるよう、
 * この origin が `/.well-known/assetlinks.json` と `/icon.png` を host する。
 */
export const PUBLIC_SITE_URL = "https://seasonals.cafe";

/** privacy policy (dApp Store Publisher Policy の必須項目)。Settings > About から開く */
export const PRIVACY_POLICY_URL = `${PUBLIC_SITE_URL}/privacy`;

/** source repository。Settings > About から開く */
export const SOURCE_REPO_URL = "https://github.com/katokokoko/Seasonals";

/**
 * app.config.ts の `version` (Settings footer 表示用)。
 * versionCode は eas.json の remote autoIncrement が別管理する。
 */
export const APP_VERSION: string = Constants.expoConfig?.version ?? "0.0.0";
