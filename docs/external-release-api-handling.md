# 外部配布に向けた API と鍵の取り扱い

- 作成日: 2026-10-09
- 状態: **運用メモ**。2026-10-10 に配布計画を承認 (web = Cloudflare Pages、BFF = Fly.io、keystore = EAS 管理、LICENSE = Apache-2.0、CLOCK IN には出さず本線)。コード側の対応は branch `release/seasonals-cafe` (§7 の各項目に (PR) 印)。運用手順は §9
- 対象: `artifacts/seasonals-bff/` の外部 API 呼び出し全部、`artifacts/seasonals/` の BFF URL 解決、[CLAUDE.md](../CLAUDE.md) §4 / §5
- 背景: web 版の公開先として `seasonals.cafe` を Porkbun で取得済み (2026-10-10)。Seeker 版も同じドメインに寄せる (MWA identity / assetlinks / privacy policy / BFF の https を 1 ドメインで賄う)
- 調査元: 2026-10-09 の repo 棚卸しと Helius / Jupiter / Solana Mobile の公式ページ (§8)

## 1. 原則

1. **鍵は BFF の env にしか置かない。** Mobile / web / MCP Server は BFF の URL しか知らない。これは既に実装どおり (`services/api.ts` 経由、`scripts/check-no-secrets.sh` が staged diff と web build を検査する)。配布のためにこの構造を崩さない
2. **「誰が BFF を動かすか」で準備が分かれる。** 自分がホストする BFF をテスターが使う (§3) と、第三者が自分の鍵で repo を動かす (§4) の 2 モデルを同時に成立させる
3. **BFF が秘密鍵を持つ経路は公開 BFF に置かない。** `AUTONOMOUS_DELEGATE_SECRET` は BFF が keypair を持つ唯一の経路 (`autonomous.ts`、devnet 固定ガード + `FEATURE_APPROVAL_MODE_AUTO` 既定 OFF)。公開 BFF ではこの 2 つの env を **設定しない** ことを運用ルールにする

## 2. 外部 API の棚卸し (2026-10-09)

Seeker 版に関係するもの。web 版だけが使う Infura / Etherscan / Uniswap / Pendle / Lido / Ethena は Seeker 配布には不要。

| API | 鍵 | 無料枠 / 単価 | 使い方 (BFF) | 備考 |
|---|---|---|---|---|
| Helius mainnet RPC / DAS / Enhanced Tx | **必須** `HELIUS_API_KEY` | Free: 月 100 万 credit、RPC 10 rps、DAS と Enhanced 2 rps、sendTransaction 1 rps。単価: RPC 1、`getProgramAccounts` 10、DAS 10、**Enhanced Transactions 100** | `helius-rpc.ts` `buildUrl()` が唯一の組み立て口。`getMultipleAccounts` 37 箇所、tx 履歴は `helius-tx.ts` が 1 ページ 100 tx = 100 credit、in-memory cache 200 entry | Enhanced Transactions は Helius 自身が legacy / maintenance mode。後継 **Parsed Events は 10 credit** (10 分の 1) |
| Jupiter `lite-api.jup.ag` (price v3 / lend v1) | 不要 | 2026-10-09 時点で鍵なし 200 | `jupiter-price.ts` (5 分 cache)、`jupiter-lend.ts` | 新 portal は `api.jup.ag`: 鍵なし 0.5 rps、無料鍵 1 rps、Developer $25 で 10 rps。lite-api は旧世代で停止時期の公式明記なし → 無料鍵を取っておき、`x-api-key` 対応を入れる余地を残す |
| RedStone gateway、Pyth push feed (Helius 経由)、DefiLlama、Sanctum、Kamino、Exponent、Orca、Meteora、Save、Marinade、Perena | 不要 | 公開 API | `rates.ts` 等に 1〜10 分 cache | 429 時は fixture / degrade に落ちる |
| Anthropic | 任意 `ANTHROPIC_API_KEY` | 従量 | 無ければ rule-based 提案 | 公開 BFF では外すか §3.3 の rate limit 必須 |
| Expo push (`exp.host`) | 不要 | Android 配信には FCM V1 (google-services.json + service account を EAS に登録) が別途必要 | `push.ts` は起動時 listener 登録のみ、token 取得は probe 画面だけ | 未設定でも release は落ちないが、テスター版は **push 承認が黙って動かない** → README に「v1 では無効」と明記 |
| `SOLANA_RPC_URL` | 不要 | devnet 既定 | autonomous の devnet ハードガード判定にだけ使う | mainnet の読み書きは全部 Helius。**devnet のまま置く** |

## 3. モデル A: 自分がホストする BFF をテスターが使う

### 3.1 quota の見積り

- 新規 wallet 1 回の読み込み ≈ DAS 10 + RPC 数十 + 履歴 100 × ページ数。tx 300 件の wallet で約 350 credit
- Free 100 万 credit = **月およそ 3,000 回の fresh load**。テスター 20 人 × 1 日 10 回 × 30 日 = 6,000 回で不足
- DAS / Enhanced の **2 rps** は複数人が同時に開くと 429 (読み取り RPC は `helius-rpc.ts` の 3 attempt backoff があるが、Enhanced 側は別)
- 対策の優先順:
  1. `helius-tx.ts` を Enhanced Transactions → **Parsed Events** (`POST /v1/parsed-events/transaction-history`) に移行 (単価 10 分の 1、legacy 回避)
  2. デモ日 / 審査期間は Developer plan (月 1,000 万 credit) に一時昇格
  3. 履歴 cache を in-memory 200 entry から `.data/` 永続に (再起動で消えない)

### 3.2 鍵の保護

- prod 用の Helius 鍵を **dev と分けて** 発行する (Helius 推奨)。漏洩時は dashboard で rotate、BFF の env だけ差し替え
- Helius Access Control: ホストが固定 egress IP を出せるなら **Allowed IPs**。Allowed Domains は Origin/Referer ベースで偽装可能なので server 用途には使わない
- error message / log に URL や api-key を含めない (既に `helius-rpc.ts` の方針。新規 client でも守る)

### 3.3 悪用対策 (URL を知った人が credit を燃やす)

- `@fastify/rate-limit` を IP 単位で入れる (PR: 既定 300/分、Helius を叩く読み取り 5 route は 60/分、`/tx/submit` は 10/分、`/health` は対象外。超過は 429 `{ error: "rate_limited" }`。key は Pages Function の `x-seasonals-client-ip` (secret 一致時) → `fly-client-ip` → socket)
- CORS を `origin: true` から `https://seasonals.cafe` に絞る (PR: `CORS_ALLOWED_ORIGINS`、未設定なら従来どおり any origin)
- `wallet` クエリは base58 形式を検証してから Helius に投げる (PR: `isWalletAddress`、19 箇所の inline 長さチェックを置換し `/portfolio/history` と `GET /agent-plans` にも追加)
- Anthropic を有効にするなら agent-proposals 系に別途上限。無効なら env を置かない
- APK に埋める共有トークンは抽出可能なので **抑止以上の効果を期待しない**。入れるなら「軽い抑止」と割り切る
- env で execute 系を無効化する **simulate-only モード** (PR: `SOLANA_EXECUTION_TARGET=disabled` → `/tx/submit`・`/protocols/*/*-tx`・`/agent-plans/:id/execute` が 409。Seed Vault が開く前に止まる)。テスト期間はこれで配る
- 公開 BFF では `PATCH /user-policy` と `/autonomous/kill|resume` は `ADMIN_TOKEN` 必須 (PR。production で未設定なら 403)。`/push-tokens` は `EXPO_PUSH_ENABLED` 無しで 503

### 3.4 状態と env

- plan / approval token は `.data/agent-plans.json` (`SEASONALS_DATA_DIR`)。volume を付けるか、再起動で消えることを許容するかを決める
- 公開 BFF の env 最小セット: `PORT` `HOST` `HELIUS_API_KEY` `SEASONALS_DATA_DIR`。置かないもの: `AUTONOMOUS_*` `FEATURE_APPROVAL_MODE_AUTO` `ETH_*` (Seeker 版だけなら)
- 監視: Helius dashboard の usage と BFF ログの 429 件数。無料枠 80% で通知

## 4. モデル B: 第三者が自分の鍵で repo を動かす

審査員 / contributor が動かすために足りないもの (2026-10-09 時点):

- [ ] root README の env 表に `HELIUS_API_KEY` が無い (web 版 / ETHGlobal 向けの表のみ)。Solana 側の表を足す
- [ ] `.env.example` に `SEASONALS_DATA_DIR` / `FEATURE_APPROVAL_MODE_AUTO` / `AUTONOMOUS_*` が無い。「公開 BFF では置かない」注記と共に足す
- [ ] `docs/spec.md` / `docs/backlog.md` / demo runbook は gitignore (local-only)。CLAUDE.md の §参照が第三者には解決できない → 公開できる範囲の architecture 文書を 1 枚足す
- [ ] LICENSE が無く `package.json` の `license` も未設定。public repo なので決める
- [ ] Node の pin が無い (README は Node 20+、実運用は 25 統一) → `.nvmrc` を置く
- [ ] mobile 手順書が無い: JDK 17、Android SDK 36、`pnpm android:onchain`、`adb reverse tcp:3030 tcp:3030`、`APP_VARIANT=onchain` の意味、Metro 再起動の罠
- [ ] MCP は `.mcp.json` の `BFF_URL` を差し替えれば公開 BFF にも向く。その 1 行を書く
- [ ] 鍵なしの起動経路を明記: "Seasonals" variant (非 onchain) は fixture で動くので、Helius 鍵を持たない人の動作確認用

## 5. テスター本人に必要なもの

- Android 7 以上 (minSdk 24) の arm64 端末 + MWA 対応ウォレット (Seeker の Seed Vault Wallet、または Phantom / Solflare)
- mainnet の手数料分 SOL と、対応プロトコルのポジション。無いとカレンダーが空 → **web 版の「Watch an address」を mobile に移植** すると資金ゼロで本物を見せられる (審査員向けに最も効く)。間に合わなければ fixture 版 APK も並べて配る
- 事前説明: 実資金が動く、oracle の fail-closed で止まることがある、push 承認は v1 では無効
- 報告先: GitHub Issues と送ってもらう情報。crash reporting は未導入 (必要なら Sentry 相当)
- 更新: EAS のリンクを配り直す。JS 変更だけなら expo-updates を入れて OTA にする余地あり (未導入)

## 6. 公開前チェックリスト

- [ ] prod 用 Helius 鍵を新規発行、dev 鍵と分離、Access Control 設定
- [ ] Jupiter 無料鍵を取得 (lite-api 停止時の保険)
- [x] rate limit / CORS 絞り / wallet 形式検証を BFF に入れた (PR: `src/flags.ts` / `src/public-guards.ts`、env は `.env.example`)
- [x] `AUTONOMOUS_*` と `FEATURE_APPROVAL_MODE_AUTO` が公開 BFF の env に **無い** ことを確認 (PR: `NODE_ENV=production` では起動ガードが拒否)
- [ ] `ANTHROPIC_API_KEY` を置くか決めた (置くなら上限あり)
- [x] `.data/` の置き場 (volume) を決めた (PR: fly.toml `[mounts]` → `/data`、production で書けなければ起動しない)
- [ ] `scripts/check-no-secrets.sh` を配布 build に対しても走らせた
- [x] README / `.env.example` の §4 項目を埋めた (PR: README「Solana / Seeker app」、`.env.example` Public deployment 節、`docs/mobile-runbook.md`、LICENSE Apache-2.0、`.nvmrc`)
- [ ] Helius usage の通知を設定した

## 7. 関連: APK / dApp Store 配布の前提 (同日の調査から)

API 以外で配布を阻んでいた点。詳細は各ファイルのコメント参照。

- **BFF URL** (PR): `services/config.ts` の既定は `http://localhost:3030`。`BFF_BASE_URL` → `extra.bffBaseUrl` の配線は commit `dc7b23d` (origin/main)。eas.json に `APP_VARIANT=onchain` + `BFF_BASE_URL=https://api.seasonals.cafe` の配布 profile を足す
- **https 必須**: cleartext 許可は debug manifest のみ。release は http の BFF に繋がらない
- **署名** (PR): `android/app/build.gradle` の release が `signingConfigs.debug`。dApp Store は debug 署名を拒否。release keystore を作り、`eas credentials` か `credentials.json` で管理、`*.keystore` / `credentials.json` を gitignore。以後の update は同じ鍵が必須、Google Play に出すなら別鍵
- **MWA identity** (PR、SHA-256 は初回 EAS build 後): `services/mwa.ts` の `https://seasonals.app` は他人のドメイン (seasonaljob.app へ redirect)。`https://seasonals.cafe` に変え、`/.well-known/assetlinks.json` に `app.seasonals.onchain` / `app.seasonals.mobile` と release 証明書の SHA-256 を置く (MWA 仕様はこれで dApp を検証し、無いと authorization 拒否を推奨)
- **versionCode**: 現在 1。dApp Store は update 毎に +1 必須。eas.json production の remote autoIncrement に寄せる
- **ABI** (PR、EAS profile の gradleCommand で arm64 のみ): 8 月の debug APK は 334 MB で x86 同梱。`reactNativeArchitectures=arm64-v8a` (+ 必要なら armeabi-v7a) に絞る
- **targetSdk 36 / minSdk 24** は Seeker (Android 16) と dApp Store 要件を満たす
- **dApp Store**: release 署名 APK、Publisher Portal で KYC/KYB、約 0.2 SOL、icon 512×512、短い説明 30 文字以内、screenshot 1080px 以上で同じ向きと比率、動画 mp4 720p 以上、privacy policy とデータ削除窓口 (Publisher Policy。URL は `https://seasonals.cafe/privacy/`、末尾スラッシュ付き。`/privacy` は Pages が 308 で転送)、審査 3〜5 営業日
- **CLOCK IN (Solana Mobile × RadiantsDAO)**: 公式ブログは 9/8 開始、10/8 締切、11 月上旬発表。X で 10/12 23:59 UTC 延長の投稿があるとの検索結果 (未確認)。提出物は APK / GitHub repo / デモ動画 / pitch deck。受賞者は dApp Store 公開が必須。2025 年の規約には「AI 生成コードは失格」があったので登録時に規約本文を確認し、README の AI usage 開示を Seeker 版にも書く

## 8. 参考リンク

- Helius: [rate limits](https://www.helius.dev/docs/billing/rate-limits) / [credits](https://www.helius.dev/docs/billing/credits) / [protect your keys](https://www.helius.dev/docs/rpc/protect-your-keys.md) / [plans](https://helius.dev/docs/billing/plans)
- Jupiter: [rate limits](https://developers.jup.ag/docs/portal/rate-limits) / [setup](https://developers.jup.ag/docs/portal/setup.md)
- Solana Mobile: [publishing checklist](https://docs.solanamobile.com/dapp-store/checklist) / [build and sign an APK](https://docs.solanamobile.com/dapp-store/build-and-sign-an-apk) / [submit a new app](https://docs.solanamobile.com/dapp-store/submit-new-app) / [listing page guidelines](https://docs.solanamobile.com/dapp-store/listing-page-guidelines) / [publisher policy](https://legal.solanamobile.com/publisher-policy-web) / [MWA spec: dapp identity verification](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html)
- CLOCK IN: [公式ブログ](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)
- Expo: [internal distribution](https://docs.expo.dev/build/internal-distribution/) / [app credentials](https://docs.expo.dev/app-signing/app-credentials/) / [Android build process](https://docs.expo.dev/build-reference/android-builds/) / [FCM credentials](https://docs.expo.dev/push-notifications/fcm-credentials/)

## 9. 運用手順 (2026-10-10 承認版、PR merge 後にユーザーが実行)

構成: web = Cloudflare Pages (`seasonals.cafe`、`/api/*` は Pages Function が BFF へ proxy)、BFF = Fly.io (`api.seasonals.cafe`、volume 付き 1 machine、固定 egress IP)、APK = EAS `preview-onchain`。鍵は Fly の secrets と Pages の encrypted secret にだけ置く。

```sh
brew install flyctl && fly auth login
openssl rand -hex 32   # BFF_PROXY_SECRET (Fly と Pages の両方に同じ値)
openssl rand -hex 32   # ADMIN_TOKEN
```

1. **Cloudflare zone**: Add a site → `seasonals.cafe` (Free) → 表示される nameserver 2 つを Porkbun の Nameservers に設定 (Porkbun 側の DNSSEC は先に off)。"Active" のメールを待つ
2. **Pages**: Workers & Pages → Create → Pages → Connect to Git → `katokokoko/Seasonals`。production branch `main`、Root directory `artifacts/seasonals-web`、Build command `cd ../.. && pnpm install --frozen-lockfile --filter @seasonals/web... && pnpm --filter @seasonals/web build`、Output `dist`。project 名は **`seasonals-web`** (`wrangler.toml` の `name` と一致させる)。build 変数 `SKIP_DEPENDENCY_INSTALL=1` / `NODE_VERSION=24` / `PNPM_VERSION=10.33.4` は `wrangler.toml` の `[vars]` に入れてある (wrangler file がある project は dashboard で同じ項目を編集できない)。**初回 build log で自動 install が skip され Node 24 で動いたか確認**し、効いていなければ `SKIP_DEPENDENCY_INSTALL` だけ dashboard の secret として入れる。Settings → Environment variables に **secret** `BFF_PROXY_SECRET` (production / preview、または `npx wrangler@4 pages secret put BFF_PROXY_SECRET --project-name seasonals-web`)。Custom domains に `seasonals.cafe` (`www` も付けるなら追加)
3. **Fly**:
```sh
fly apps create seasonals-bff
fly volumes create seasonals_data --app seasonals-bff --region nrt --size 1
fly secrets set --app seasonals-bff HELIUS_API_KEY=<prod 用に新規発行した鍵> CORS_ALLOWED_ORIGINS=https://seasonals.cafe \
  SOLANA_EXECUTION_TARGET=disabled ADMIN_TOKEN=<hex> BFF_PROXY_SECRET=<Pages と同じ hex> RATE_LIMIT_MAX=300
fly ips allocate-v4 --shared --app seasonals-bff && fly ips allocate-v6 --app seasonals-bff
fly ips allocate-egress --app seasonals-bff -r nrt      # 固定 egress IP ($3.60/月)。Helius Allowed IPs 用
pnpm deploy:bff                                          # = fly deploy (remote builder、GIT_SHA を注入)
fly status --app seasonals-bff                           # machine が 1 台
fly certs add api.seasonals.cafe --app seasonals-bff && fly ips list --app seasonals-bff
```
   volume は root 所有で mount されるが、`docker-entrypoint.sh` が起動時に `/data` を node に渡してから権限を落とすので手作業は不要。`fly logs` に `SEASONALS_DATA_DIR ... is not writable` が出たら mount 先 (`/data`) と `[mounts]` を見る
4. **DNS** (Cloudflare): `A api → <v4>`、`AAAA api → <v6>` を **DNS only (灰色雲)** で作る。`fly certs check api.seasonals.cafe` → `curl -s https://api.seasonals.cafe/health` に `version` と `solana.executionTarget` が出る
5. **Helius**: dashboard → prod 鍵 → Access Control → Allowed IPs に egress IP。`/positions?wallet=<任意の address>` が 200 を返す
6. **web 経由**: `curl -s https://seasonals.cafe/api/health` → `WEB_URL=https://seasonals.cafe node artifacts/seasonals-web/e2e/run.mjs`
7. **EAS**: `cd artifacts/seasonals && npx eas-cli login && npx eas-cli build -p android --profile preview-onchain` (keystore 生成 = Yes)。`npx eas-cli credentials -p android` で SHA-256 fingerprint を控え、keystore をダウンロードしてパスワード管理に保存
8. **assetlinks**: `artifacts/seasonals-web/public/.well-known/assetlinks.json` の `REPLACE_WITH_EAS_SHA256` 2 箇所を置き換える PR → merge → Pages 再デプロイ。`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://seasonals.cafe&relation=delegate_permission/common.handle_all_urls` で statement を確認。**ここまで済ませる前に APK を配らない**
9. **Seeker**: EAS の install link か `adb install -r` → MWA connect で `seasonals.cafe` の identity → Portfolio が api.seasonals.cafe 経由で載る → `adb logcat -s ReactNativeJS` にエラー無し。実行を開けるなら `fly secrets set SOLANA_EXECUTION_TARGET=mainnet`

### 9.1 公開後に見るもの

- Helius dashboard の credit 消費 (無料枠 80% で通知)、BFF ログの 429
- `fly logs` に起動ガード / data dir のエラーが無い
- rate limit smoke: `/tx/submit` に 15 連投 → 400 の後 429 (disabled なら 409)
- `curl -X POST https://api.seasonals.cafe/autonomous/kill` → 403
