# Expo SDK 51 → 57 更新手順 (単独 phase)

> 2026-08-05 作成。実測に基づく現状: `expo ~51.0.39` / RN 0.74.5 / React 18.2 /
> `newArchEnabled: false` / Reanimated 3.10 / RNGH 2.16 / Skia 1.2.3 /
> bottom-sheet 4.6 / expo-router 3.5 / jest-expo 51。
> 影響 grep 済み: `@react-navigation/*` 直接 import **0 件**、`@expo/vector-icons` **0 件**、
> Reanimated 使用 14 ファイル (useFrameCallback / useAnimatedSensor 含む)、
> Skia は glass 2 ファイルのみ、bottom-sheet は 3 ファイル。

## 何が起きるか (6 世代分の要点)

| SDK | 主要な破壊的変更 (このアプリに効くもの) |
|---|---|
| 52 | New Architecture が default ON (opt-out 可)。RN 0.76 |
| 53 | Android edge-to-edge が default ON。RN 0.79、React 19 |
| 54 | **legacy architecture 対応の最終版**。RN 0.81 |
| 55 | **legacy architecture 廃止**。`newArchEnabled` オプション自体が削除 |
| 56 | expo-router が React Navigation を fork 内蔵 (`@react-navigation/*` 直接 import 禁止、codemod あり)。`@expo/vector-icons` が transitive でなくなる |
| 57 | RN 0.86 / React 19.2。Reanimated 4.5 + react-native-worklets 0.10 / RNGH 2.32。reanimated import で Hermes メモリ +25-30% の既知問題 (worklets bundle mode で回避) |

つまりこの更新は「バージョン上げ」ではなく **New Architecture 移行を含む**。
`newArchEnabled: false` は SDK 55 以降維持できない。

## 方針: 2 段階で上げる

一気に 51→57 も可能だが、**newArch 移行と SDK/React 19 移行を同じ diff に混ぜると
実機で壊れた時に切り分け不能**になる。2 hop に分ける:

- **Stage 1: 51 → 54** — legacy arch の最終版まで。RN 0.74→0.81 / React 18→19 /
  expo-router 3→6 を吸収。`newArchEnabled: false` のまま
- **Stage 2: 54 → 57** — newArch 移行 + Reanimated 4 + RN 0.86

各 stage で dev-client APK を作り直して実機 smoke (EAS build 2 回)。

---

## Stage 0 — 準備 (30 分)

- [ ] 手元の `phase-8.81-liquid-shader` (18 commits) を先に main へマージする。
      この上に SDK 更新を積むと PR が巨大化し、rebase も地獄になる
- [ ] clean main から新ブランチ (例 `phase-8.87-expo-sdk-57`)
- [ ] 基準線を記録: `pnpm -r test` (460 mobile / 67 lib / 22 BFF 全 green)、
      `pnpm -r typecheck` (ts-baseline 7 件)、現行 APK で一通り触って
      「更新前の姿」を確定 (glass 120Hz / gesture / keyboard / MWA 接続)
- [ ] `cd artifacts/seasonals && npx expo-doctor@latest` — 更新前の warning を控える
- [ ] 旧 APK は端末から消さない (rollback 用。onchain / 通常 variant とも)

## Stage 1 — SDK 51 → 54 (legacy arch のまま)

### 1-1. パッケージ更新
```bash
cd artifacts/seasonals
npx expo install expo@^54.0.0
npx expo install --fix        # expo-* / RN / React を SDK 54 整合へ。差分が出なくなるまで繰り返す
```
- [ ] **Reanimated だけは注意**: SDK 54 の推奨は 4.x だが **Reanimated 4 は newArch 必須**。
      legacy arch の Stage 1 では **3.19.x (3 系最終) に留める**
      (`--fix` が 4 を提案してきても受けない)
- [ ] React 19 対応 dev deps: `@types/react@~19`、`@testing-library/react-native@^13`
      (React 19 対応版)、`react-test-renderer` は React 19 で非推奨 — RTL 13 が
      依存しない構成になるので削除できるか確認
- [ ] `jest-expo@~54` / `babel-preset-expo@~54` / `typescript` は SDK 54 template に合わせる
- [ ] mobile の `@solana/web3.js ^1.95.3` → `1.98.4` (BFF と揃える。v1 系のまま)

### 1-2. 既知の地雷の再確認 (CLAUDE.md §8.3)
- [ ] `jest.config.js`: `transformIgnorePatterns: []` / `.mjs` transform / `forceExit` /
      `moduleNameMapper` を**維持** (jest-expo 54 preset で壊れていないか 460 テストで確認)。
      RNGH の `jestSetup.js` パス据え置き
- [ ] `metro.config.js`: `watchFolders` + `nodeModulesPaths` 2 段は維持。
      **`unstable_enableSymlinks` は Metro 0.80+ で default 化されオプションが消えている
      可能性** — 起動時 warning が出たら行を消すだけ (機能は残る)。
      emulator で `@workspace/lib` が解決できることを必ず確認
- [ ] edge-to-edge: SDK 53+ で default ON。自前 plugin `./plugins/with-edge-to-edge` と
      **二重適用にならないか** `npx expo prebuild --platform android` の出力 diff で確認。
      standard 化された分 (decorFitsSystemWindows 等) は plugin から削れるはず。
      `androidStatusBar` / `androidNavigationBar` config の非推奨 warning も見る
- [ ] expo-router 3→6: 画面は 4 route のみ (index / autonomous / approval/[planId] / _layout)。
      `expo-router/entry` (package.json main) / `Link asChild` / deep link
      (`seasonals://approval/...`) の挙動確認
- [ ] expo-notifications: dev-client なので Expo Go 系の制限は無関係だが、
      push token 取得 API の変更有無を確認 (`services/push.ts`)

### 1-3. 検証
```bash
pnpm test && pnpm typecheck          # mobile
pnpm -r test && pnpm -r typecheck    # 全 workspace
pnpm build:dev                       # EAS で dev-client APK #1
```
- [ ] 実機 smoke: カレンダー gesture (swipe commit / cancel) / glass 120Hz
      (`dumpsys gfxinfo` 99p) / bottom sheet 位置 (890dp 基準の snapPoint) /
      キーボード回避 (8.86) / MWA 接続 + devnet 署名 round-trip / daily view
- [ ] ts-baseline 増減を記録、意図的なら refresh
- [ ] **commit** (Stage 1 単独で rollback 可能な状態にする)

## Stage 2 — SDK 54 → 57 (New Architecture 移行)

### 2-1. パッケージ更新
```bash
npx expo install expo@^57.0.0
npx expo install --fix
```
- [ ] `app.config.ts` から **`newArchEnabled: false` を削除** (オプション自体が SDK 55 で廃止)
- [ ] 主要どころの期待値: RN 0.86 / React 19.2 / `react-native-reanimated@~4.5` +
      `react-native-worklets@~0.10` / `react-native-gesture-handler@~2.32` /
      `react-native-screens@4.x` / `react-native-safe-area-context@5.x` /
      `react-native-svg@16.x` / `@shopify/react-native-skia@2.x`

### 2-2. Reanimated 3 → 4 (このステージ最大の作業)
- [ ] babel plugin を差し替え: `react-native-reanimated/plugin` →
      **`react-native-worklets/plugin`** (babel.config.js)
- [ ] 使用 API の残存確認: `useSharedValue` / `withSpring` / `withTiming` /
      `useAnimatedStyle` / `runOnJS` / `useFrameCallback` / `useAnimatedSensor` —
      v4 でいずれも存続。deprecated 警告が出たものだけ対処
- [ ] **SDK 57 既知問題**: reanimated を import するだけで Hermes メモリ +25-30%
      (RN 0.85 の Hermes 変更由来)。**worklets bundle mode を有効化**して回避
- [ ] jest: reanimated v4 の jest setup (jest-expo 57 preset が面倒を見るか確認)。
      `GlassLayer.test.tsx` の frame callback 系 mock が通ること

### 2-3. 追随が要る依存
- [ ] `@gorhom/bottom-sheet` 4 → **5** (Reanimated 4 対応は v5 のみ)。
      **v5 は `enableDynamicSizing` が default true** — 数値 snapPoints
      (PortfolioSummary の calendarBottomY 連動) を維持するため
      **`enableDynamicSizing={false}` を明示**。`BottomSheetTextInput` /
      `keyboardBehavior="extend"` (8.86) の挙動を実機確認
- [ ] `@solana-mobile/mobile-wallet-adapter-protocol-web3js`: newArch + RN 0.86 対応版
      (2.2.x 以降) へ。**MWA は署名経路そのもの** — 実署名 round-trip
      (docs/confirm.md §A) をこの stage の smoke に必ず含める
- [ ] Skia 2.x: SkSL RuntimeEffect (`liquid-shader.ts`) の API 互換確認。
      **Mali の `continue`=break バグ patch (nested if) は維持**。
      before/after screenshot + zoom で泡の描画数と AA を比較 (前セッションの手順)
- [ ] expo-router の React Navigation fork (SDK 56): 直接 import は 0 件 grep 済み
      なので codemod 不要。念のため build error が出たら
      `npx expo-codemod sdk-56-expo-router-react-navigation-replace`
- [ ] zustand 4.5: React 19 で動くが、warning が出たら v5 へ (小規模 API 変更のみ)

### 2-4. 検証 (newArch の実機検証が本丸)
```bash
pnpm -r test && pnpm -r typecheck
pnpm build:dev                       # APK #2
```
- [ ] **性能実測**: これがこの phase の動機。旧アーキの固定費
      (sharedValue→再記録 pipeline、フレーム中央値 ~12ms) が newArch で
      どれだけ縮むか — `dumpsys gfxinfo <pkg> reset` → 操作 → percentiles、
      `logcat | grep "queueBuffer: fps"` で 120Hz 張り付き確認
- [ ] glass: 泡描画数 / dither / AA が Stage 0 のスクリーンショットと一致
- [ ] tilt (`useAnimatedSensor`) / shake が newArch で動く
- [ ] MWA 実署名 round-trip (部分署名保持まで見るなら confirm.md §A と一体で)
- [ ] キーボード回避: edge-to-edge 下の JS-side 回避 (8.86) が SDK 57 の
      edge-to-edge fixes と干渉しないこと
- [ ] deep link (`seasonals://approval/...`) → PushCard
- [ ] ts-baseline refresh (React 19.2 型で数件動く想定)

## Stage 3 — 後片付け

- [ ] `eas-cli` 更新 + `eas.json` の `cli.version` 引き上げ
- [ ] root `pnpm-lock` 差分レビュー — **`rpc-websockets@7.10.0` override は BFF 経路。
      触らない** (packaging 回帰、backlog.md §E)
- [ ] `pnpm --filter @seasonals/bff verify:tx` — mobile 更新の巻き添えで
      lockfile 経由の BFF 依存が動いていないことの確認 (23 経路)
- [ ] CLAUDE.md §10 の「①Expo SDK 51→57」を消す。native module 群 (②) も
      この phase で一緒に上がったなら②も消す。backlog.md §E / confirm.md 更新
- [ ] PR → merge は実機 smoke green 後

## 規模感

- Stage 1: 半日 (EAS build 待ち含む)
- Stage 2: 1〜2 日 (newArch 実機検証と Reanimated 4 移行が主)
- 詰まりやすい順: Reanimated 4 / bottom-sheet v5 の dynamic sizing /
  Skia 2.x の shader 互換 / metro symlink / MWA newArch

---

## 実施記録 (2026-08-05, Phase 8.87)

計画からの変更と、実際に踏んだ地雷:

1. **「Stage 1 は legacy arch のまま」は不成立** — GlassLayer の
   `uniforms={SharedValue}` (Skia↔Reanimated interop) が Skia 2.x では
   Reanimated 4 (= newArch 専用) を要求。Stage 1 から SDK 54 正規構成
   (newArch + Reanimated 4.1 + bottom-sheet v5) を採用した
2. **Node**: /usr/local/bin/node が 2023 年 .pkg の v18 で brew の v25 を隠していた
   (Metro が `toReversed` で死ぬ)。暫定は PATH 先頭に /opt/homebrew/bin
3. **EAS**: 過去の dev APK はローカル `expo run:android` 製で、EAS アカウント自体が
   未作成だった。新規作成 + expo-dev-client 追加 + projectId を app.config.ts に手書き
   (dynamic config は eas init が書けない)
4. **stale husk**: artifacts/seasonals/node_modules/react-native (中身は
   utf-8-validate の入れ子だけ) が autolinking を壊す。根治は root override
   `"utf-8-validate": "6.0.6"`
5. **SDK 54 splash**: 新 SplashScreenManager は logo drawable を必須参照 →
   expo-splash-screen plugin に image (アイコン) を指定
6. **SDK 57 で消えた API**: `StyleSheet.absoluteFillObject` (→ absoluteFill) /
   ExpoConfig の `androidNavigationBar` と top-level `splash`
7. **worklets 0.10 × jest**: 同梱 resolver (`react-native-worklets/jest/resolver.js`)
   を jest.config に指定しないと reanimated import の全 suite が落ちる
8. **skia 2.6 × pnpm 10**: libskia が postinstall ダウンロードになり、pnpm の
   build script ブロックに引っかかる → `onlyBuiltDependencies` 許可
9. TS 6.0 は `expo.install.exclude` で保留 (major 跨ぎ phase へ)

結果: テスト 1004 全 green / verify:tx 23 経路 green / Seeker 実機で
50p 12ms / 99p 27ms / janky 0% (SDK 51 旧アーキ比で 99p 32→27ms)。
