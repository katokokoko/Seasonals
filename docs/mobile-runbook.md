# Seasonals Seeker 版 runbook (公開版)

- 作成日: 2026-10-10
- 対象: `artifacts/seasonals/` (Expo SDK 57 / React Native 0.86、package `@seasonals/mobile`)
- 関連: [外部配布と API 鍵の取り扱い](external-release-api-handling.md)、[CLAUDE.md](../CLAUDE.md) §5 / §8
- すべてのコマンドは repo root から。macOS では `PATH=/opt/homebrew/bin:$PATH` を前置する

## 1. 前提

| 必要なもの | 備考 |
|---|---|
| Node 24 (`.nvmrc`)、pnpm 10.33.4 (`packageManager`) | Node 20 以上なら動く (CI は 20、Docker は 24、開発機は 25) |
| JDK 17、Android SDK (compileSdk / targetSdk 36、minSdk 24)、`adb` | Expo SDK 57 の既定 |
| 実機: Seeker (Android 16) または Android 7 以上の arm64 端末 + MWA 対応ウォレット | Seed Vault Wallet / Phantom / Solflare。emulator でも UI は見られるが MWA 署名は実機で |
| BFF (`artifacts/seasonals-bff`) と `HELIUS_API_KEY` | onchain variant で mainnet の保有を読むのに必須。無ければ fixture variant を使う |

`docs/spec.md` と `docs/backlog.md` は local-only (gitignore) なので、CLAUDE.md の §参照が解決できない箇所は本書と `docs/backend-core-pipeline.md` を読む。

## 2. 2 つの variant

| variant | package | 中身 | 用途 |
|---|---|---|---|
| Seasonals | `app.seasonals.mobile` | BFF の fixture (鍵なしで動く) | UI 確認、鍵を持たない第三者の動作確認 |
| Seasonals (onchain) | `app.seasonals.onchain` | MWA で繋いだ wallet の mainnet 保有を BFF (Helius) 経由で表示、署名は MWA | 実機 / 配布 |

variant は `APP_VARIANT=onchain` で切り替わる (`app.config.ts`)。**expo-constants は Gradle build 中に `app.config.ts` を再評価する**ので、Metro にも EAS profile にも `APP_VARIANT` が要る。無いと APK 名は onchain のまま中身が devnet / fixture になる。

## 3. ローカル起動 (dev client)

```sh
# 1. BFF (:3030)
pnpm --filter @seasonals/bff dev

# 2. 初回だけ: dev client 入りの debug APK を Seeker に入れる (USB、developer options で USB debugging を on)
pnpm --filter @seasonals/mobile android:onchain

# 3. Metro (APP_VARIANT=onchain 必須)
cd artifacts/seasonals && APP_VARIANT=onchain EXPO_PUBLIC_USE_ONCHAIN=true pnpm exec expo start --dev-client --port 8081

# 4. 端末の localhost を Mac に転送 (スリープ / USB 抜き差しで消える → `pnpm dev:device` で常駐も可)
adb reverse tcp:3030 tcp:3030 && adb reverse tcp:8081 tcp:8081

# 5. bundle を載せる
adb shell am start -a android.intent.action.VIEW -d "seasonals://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" app.seasonals.onchain
```

- BFF の URL は `services/config.ts` が `extra.bffBaseUrl` → 無ければ `http://localhost:3030` と解決する。`BFF_BASE_URL=https://api.seasonals.cafe` を Metro の env に足すと dev client から公開 BFF に繋がる (release manifest は http 不可、dev は可)
- **Metro は起動後に増えた新規ファイルを拾わない** (watchman root の都合)。`lib/` 等にファイルを足したら Metro を再起動する。症状は `Unable to resolve "@workspace/lib/…"` で端末が古い bundle のまま動く
- 他のポートで並走する時は BFF `PORT=3031`、Metro `--port 8082` + `BFF_BASE_URL=http://localhost:3031`、`adb reverse` も同じ番号で張る
- `adb reverse --list` が空なら張り直す (別セッションの後片付けで消えることがある)

## 4. 配布用 APK (EAS Build)

| profile | 中身 | 用途 |
|---|---|---|
| `development` / `onchain` | debug + dev client、internal | ローカル開発 |
| `preview` | release、internal (fixture variant) | UI だけ見せる |
| `preview-onchain` | release、internal link、`APP_VARIANT=onchain`、`BFF_BASE_URL=https://api.seasonals.cafe`、arm64 のみ、autoIncrement | **テスターに配る APK** |
| `production-onchain` | 同上を production 設定で | dApp Store 提出 |

```sh
cd artifacts/seasonals
npx eas-cli login
npx eas-cli build -p android --profile preview-onchain     # 初回は "Generate a new Android Keystore?" → Yes
```

- 完成すると EAS の build ページに install link / QR が出る。URL を知っていれば誰でも落とせるので、絞るなら expo.dev の project settings で "Unauthenticated access to internal builds" を off にする
- ABI は `gradleCommand` で arm64-v8a に絞っている (Seeker は arm64)。`gradle.properties` の ABI は触らない (ローカル emulator の x86_64 を残すため)
- ローカルで `./gradlew assembleRelease` すると credentials が無いので **unsigned** APK になる (仕様)。配布用は EAS で作る

## 5. 署名鍵 (release keystore)

- **EAS が生成・保管する**。repo には置かない (`*.keystore` / `*.jks` / `credentials.json` は gitignore。tracked の `android/app/debug.keystore` は debug 専用の公開鍵)
- バックアップ: `npx eas-cli credentials -p android` → `app.seasonals.onchain` → Keystore → Download。`.jks` とパスワードはパスワード管理に保存する。**失うと以後の update を出せない**
- dApp Store の update は毎回同じ鍵が必須。Google Play にも出すなら別の鍵を使う (同じ鍵は使えない)
- SHA-256 fingerprint は同じ画面の "SHA256 Fingerprint" に出る (大文字コロン区切り)

## 6. MWA identity と assetlinks.json

`services/mwa.ts` の identity は `https://seasonals.cafe` (icon は `/icon.png`)。MWA 対応ウォレットはこの URI の `/.well-known/assetlinks.json` を読み、呼び出し元 APK の package 名と署名証明書が載っているかで dApp を検証する。載っていないと authorization を拒否するウォレットがある。

初回 EAS build の後に 1 回だけ:

1. §5 の SHA-256 を控える
2. `artifacts/seasonals-web/public/.well-known/assetlinks.json` の `REPLACE_WITH_EAS_SHA256` (2 箇所) を置き換える PR を出す → merge で Cloudflare Pages が再デプロイ
3. 確認: `curl -s https://seasonals.cafe/.well-known/assetlinks.json` と
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://seasonals.cafe&relation=delegate_permission/common.handle_all_urls`
4. **ここまで済ませてから APK を配る**

privacy policy は `https://seasonals.cafe/privacy/` (末尾スラッシュ。`/privacy` は 308 で転送されるので app 内リンクはそのままでよいが、dApp Store の listing にはスラッシュ付きを書く)

## 7. 端末へのインストール

- EAS の install link を端末の Chrome で開く → ダウンロード → 「不明なアプリのインストール」を Chrome に許可 → install
- または Mac から `adb install -r <file>.apk` (同じ package の上書きは versionCode が上がっている必要あり。`preview-onchain` は autoIncrement)
- 初回起動後: ウォレット接続 → Seed Vault / Phantom の承認画面に "Seasonals" と `seasonals.cafe` が出ることを確認

## 8. adb だけで確認する時のメモ

- RN の `testID` は `adb exec-out uiautomator dump /dev/tty` の `resource-id` に出る。`bounds` の中心を `adb shell input tap X Y`。アニメ中は dump が失敗するので 1〜2 秒待って再試行
- 通知 permission: `adb shell pm grant app.seasonals.onchain android.permission.POST_NOTIFICATIONS` (拒否は `pm revoke`)。予約は `adb shell dumpsys alarm | grep -A8 app.seasonals.onchain`、配送済みは `adb shell dumpsys notification --noredact | grep -A14 app.seasonals.onchain`
- 通知 shade: `adb shell cmd statusbar expand-notifications` / `collapse`
- BFF 停止 (stale) の再現: `adb reverse --remove tcp:<BFF port>`。keep-alive 接続が切れるまで約 72 秒かかるので 70 秒以上待ってから Refresh。戻すのは `adb reverse tcp:<port> tcp:<port>`
- cold start: HOME → `adb shell am kill app.seasonals.onchain` → 起動 / 通知 tap。`am force-stop` は app の alarm ごと消すので使わない
- ログ: `adb logcat -s ReactNativeJS` (JS エラー)、`adb logcat | grep -i seasonals` (native)

## 9. 既知の制約 (v1)

- **push 承認は配送されない**: FCM (google-services.json + service account) を EAS に登録していない。app は起動時に listener を登録するだけなので落ちないが、Agent の承認 push は来ない。公開 BFF は `EXPO_PUSH_ENABLED` 未設定で `/push-tokens` を 503 にしている
- **公開 BFF は simulate-only で始める**: `SOLANA_EXECUTION_TARGET=disabled` の間は deposit / withdraw / execute が 409 "Execution is disabled…" で止まる (Seed Vault が開く前)。運用者が `mainnet` に切り替えると実行できる
- **Agent 設定 (policy) は運用者のみ**: 公開 BFF の `PATCH /user-policy` は `ADMIN_TOKEN` 必須なので、テスターが Settings の Agent から policy を変えると 403 が表示される。policy は single-tenant のため
- `/positions?wallet=` 等の読み取り口は任意の address を受ける (本人認証ではない)
- OS 通知の時刻は保証されない (Android の inexact alarm。Seeker Android 16 で予定 +75〜385 秒を実測)
- **日本国内のテスター**: Seeker の技適取得は 2026-10 時点で確認できていない。国内で無線を使う前に総務省の技適検索で型番を確認する。これは app ではなく端末側の問題
