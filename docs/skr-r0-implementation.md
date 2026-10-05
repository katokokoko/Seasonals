# Seasonals × SKR R0 実装指示書

- バージョン: 0.4 / 2026-09-20。ハッカソンの実装対象は本書。
- 規約: [CLAUDE.md](../CLAUDE.md)、[spec.md](spec.md)、[design-system.md](design-system.md)。型・schemaは共有lib、金融値はnumeric helper、UIは既存DSを使う。
- [後続ロードマップ](skr-integration-roadmap.md)はR0の完了条件に含めない。[変更履歴](skr-integration-changelog.md)は規範ではない。

## 1. 作る範囲と優先順位

SKRの解除予定を他DeFi予定と同じCalendarに載せ、Agentも同じBFF導出のeventを読む。読取、Your Positionsの専用行、現在のpendingに対応するlockup_end、端末の確認通知、追加解除による時刻更新まで。解除・withdrawは公式ポータルを使う。

MUSTは下記の受け入れ条件。SHOULDは省略理由を残せばデモ可能。DEFERはR0の作業対象外。

| 優先度 | 作業 |
|---|---|
| P0 / MUST | 利用者の手動unstakeとlive read fixtureの確保を実装と並行して進める。BFF読取、nullable専用行、Calendar、fresh eventのMCP読取、確認通知とtap再取得 |
| P1 / SHOULD | retry予算の永続化、端末時計変更への追加耐性、通知response二重処理抑止、batch中変更の競合再現fixture。R0に入らなければR1で扱う |
| P1 / SHOULD | 2つ目のcooldown protocolを同じ型で読むデモ。SKRのlive read後、残り工数で判断 |
| DEFER | SIWS/JWT新設、DB、outbox、background監視、plan/token永続化、命令履歴復元、元本/収益/USD集計、MCPのSKR position公開・実行、独自コントラクト |

見積りはread fixture準備・Seeker確認を含め**6–9人日を計画枠**とする。SHOULD、2つ目のprotocol、Oracle/RFCは別枠。実装序盤のread成功時に残りを更新し、3–5人日の完了を約束しない。

### P0: 録画に使うpendingを先に用意する

1. 今日、利用者が検証用walletと自分で許容できる量を決め、[公式ポータル](https://stake.solanamobile.com/)で手動unstakeを行う。既にpendingがあればそれを使う。
2. 公開wallet、tx signature、対象pool、録画予定日時を記録し、直後にread-onlyでaccount batchを保存する。秘密鍵・seedは扱わない。
3. 初回解除の終了予定前に、利用者が追加解除を実施する場面を録画する。前後のreadを保存し、実チェーンのunlock_at変更をCalendarとMCPで示す。待機時間は固定48時間で予定を決めず、取得したconfig/Clockから逆算する。追加解除で待機が延びることを本人が確認する。
4. 録画時に既にreadyなら追加解除可能とは仮定しない。日程を組み直すかfixtureと明示した補足を使う。アシスタントは量未指定の資金操作を代行しない。

fixtureは`lib/__fixtures__/skr-staking/`へ、IDL識別値、cluster、wallet、対象accountのアドレス/owner/raw bytes、context.slot、Clock、取得時刻を保存する。RPC URLのAPI keyは記録しない。導出した値だけでなくraw batchを残し、read実装で再生できる形にする。pending未確保は外部条件として放置せずP0未完了と記録する。

2026-09-20の着手状況: [共通account資料](../lib/__fixtures__/skr-staking/README.md)を取得済み。config/poolのIDL decode、PDA、mint/vault参照等11項目を確認。利用者のUserStakeはまだ含まず、公開walletの提示を待ってpending fixtureを取得する。

## 2. SKR読取の根拠


| 対象 | 値 |
|---|---|
| Seasonals protocol_id（提案） | `skr_staking` |
| mint | `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` |
| Program | `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ` |
| Stake Config | `4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw` |
| Stake Vault | `8isViKbwhuhFhsv2t8vaFL74pKCqaFPQXo1KkeQwZbB8` |
| 初期対応Guardian Pool | `DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr` |

公式説明のcooldownは48時間、staking epochは2日。解除分は報酬対象から外れ、終了後もwithdrawが必要。終了予定は固定timerでなく、検証済みconfigの`cooldown_seconds`とUserStakeの`unstake_timestamp`から求める。[公式SKR資料](https://docs.solanamobile.com/solana-mobile-stack/skr)

待機中の追加解除はpendingを合算して時刻を更新し、取消は再ステークになる。報酬は自動複利のため、通常のstaking報酬を別claimとして通知しない。[公式FAQ](https://stake.solanamobile.com/)

公式サンプルのSKR decimalsは6、share price scaleは1e9。UserStake PDAは`user_stake`、config、user、poolから導出する。Kit/Codamaのサンプルを既存MWA web3jsへそのまま移植する必要はない。[公式サンプル](https://github.com/solana-mobile/react-native-samples/blob/main/skr-staking/README.md)

IDLではstakeはu64 amount、unstakeはu128 shares、withdraw/cancelは金額引数なし。`WithdrawRequired`はready後の追加解除より先にwithdrawが必要なことを示す。configは変更可能、commission関連のフィールドもある。[公式IDL](https://github.com/solana-mobile/react-native-samples/blob/main/skr-staking/program/idl.json)

取得IDLのSHA-256は`6e71d7a36ee9ea4410394ec69d9007dca4fb05ad902741004f1d3746b607df03`。これは資料の識別値で、live deploymentとの一致証明ではない。R0読取で必要なaccount layout/PDAの照合と、R2の命令simulationを分けて実施する。

## 3. 読取と共有契約

### BFFの1本のread口

`GET /protocols/skr-staking/state?wallet=...`。公開チェーン情報のみ、既存の入力検証・rate limitを使う。任意walletを読めることは本人認証済みという意味ではない。R0は既存のデモ/開発環境で使用する。

config・pool・導出UserStake・vault・mint・Clockを`commitment=confirmed`の単一`getMultipleAccounts`で読み、owner program、discriminator、長さ、PDA、user/config/pool/mint/vault参照を検証する。account種別ごとにowner/layoutを検査し、Token ProgramのaccountやClockにSKR discriminatorを要求しない。[RPC仕様](https://solana.com/docs/rpc/http/getmultipleaccounts)

応答のcontext.slotを採用し、個別fetchの古い値を混ぜない。BFF cacheなし、HTTP no-store、read全体のtimeoutは10秒、BFF内部retryなし。液体SKRは別のgetTokenAccountsByOwnerで対象mintのATA・非ATAを合算し、別slot・取得時刻を付ける。液体読取の失敗でstaking状態を変えない。

activeとpendingは独立。pendingはnone / cooling_down / ready / unknown。`unlock_at = unstake_timestamp + 検証済みcooldown_seconds`、readyは同batchのClock >= unlock_atのときだけ。config不明を48時間やshare_price=1で補わない。正常なUserStake不在は空状態、RPC失敗はunavailable、必須accountの検証失敗はunsupportedとする。

### APIのdata部分

```text
schema_version: 1
source: live | demo
cluster, wallet_address, protocol_id, position_account, pool
commitment: confirmed
observed_at: UTC ISO string | null
slot: safe integer | null
chain_time: signed seconds string | null
data_status: fresh | unavailable | unsupported
coverage: configured_pool_only
position: CooldownPositionView | null
liquid: { amount: smallest-unit string | null, slot, observed_at, data_status }
events: CooldownEventDTO[]
```

`CooldownStateResponse`、`CooldownPositionView`、`CooldownEventDTO`、`CooldownReminderPayload`とruntime schemaを`lib/types/cooldown-position.ts`へ追加し、barrelからimportする。

```typescript
export interface CooldownEventDTO {
  event: UnifiedTimeEventDTO;
  schedule_revision: string;
}
```

`CooldownPositionView`はkind=cooldown_position。scope識別子、asset_mint/symbol/decimals、shares/share_price、active_amount_estimate、pending_amount、unlock_at、pending_status、data_status、observed_at/chain_time/slotを持つ。元本、収益、USD/SOL価格、deposited_atはR0ではnull、available_actionsは空。取得不能な量もnull。

`active_amount_estimate = floor(shares * share_price / 1e9)`は推定。金融値はsmallest-unit string、numeric helper経由でbigint演算する。u128 sharesは範囲検査する。既存Positionへのcast・ゼロplaceholder変換はしない。生のaccountは検証/fixtureに使い、APIのrevisionには使わない。

### schedule_revisionだけを使う

イベントIDは`lockup_end:<cluster>:<protocol_id>:<wallet>:<position_account>`。現在のpendingにつき1件で、pending=0またはunlock_at不明なら0件。時刻をIDに入れず、次の解除でも同じcurrent-event IDを再利用する。

BFFは`schedule_revision = "v1:" + unstake_timestamp + ":" + cooldown_seconds`を生成する。2つの値は正規化済みの整数文字列。比較キーはsource + cluster + wallet + event_id + schedule_revision。Mobileは再計算せず、同じ予定かを比較するだけ。SHA-256や正規化JSONの専用実装は不要。

他人の操作でvault残高・pool総shares・share_priceが変わっても、本人の解除時刻と適用cooldownが同じならschedule_revisionは不変。本人の追加解除または適用cooldown変更で変わる。Clockがreadyになっただけでは不変。共有share_priceの変化によるactive推定額の再描画は通常のquery更新で行う。

R0にsnapshot_revision、event revision、position.state_hashは設けない。R1の変更検出が必要になった場合だけ、本人UserStakeと実際に導出へ影響するconfigフィールドから別途定義する。

### 鮮度とcache

freshは今回のread検証成功を示す観測値。Mobileの表示期限は300秒、app復帰/cold start/再取得失敗でstaleとし、観測時刻と更新待ちを表示する。tap・復帰・手動refreshはBFFを再取得する。端末日時変更への追加対策はSHOULDで、R0の合格条件に含めない。

scopeごとにquery/cacheを分離し、wallet/source/cluster切替後の旧応答を破棄する。slot後退も上書きせずstale。liveエラーをfixtureへ自動fallbackしない。stale/unsupportedをpending取消済みと解釈せず、現在readyと断定しない。

## 4. UIとMCP

Your Positionsに専用rowを追加し、「ステーク中（推定）」「解除待ち / 引き出し可能」を表示する。元本/収益/USD/ROIは—。staking行はportfolio合計・履歴へ入れず、評価対象外ラベルを付ける。DS token、GlassCard、Quicksand、既存dropletを使う。readyは期限切れのCriticalにしない。

既存consumer（earn-to-position、MenuDrawer/vault-rows、allocation/PortfolioSummary、portfolioTimeSeries、deposited-breakdown）へ専用型を既存Positionとして渡さない。型テストとnull fixtureでゼロ埋め・集計への混入を検出する。

Calendarにはwrapper.eventをfromDTOで変換して渡す。日時はtimezone付き、actions=[]。詳細はそのevent IDに対応するread responseのpositionを直接解決する。全consumerで`positionRef=null`とし、MCPに存在しないpositionへの参照を作らない。公式ポータルへのリンクを示し、復帰時に再取得する。

**MCPはeventのみ公開する。** 正常に導出できたfresh eventはagentReadable=true。既存`seasonals://events/{wallet}` resourceからBFFのSKR read口を呼び、既存eventと重複排除して返す。MCP独自に日時や状態を導出しない。取得失敗/unsupportedはSKR eventを0件にし、resourceに取得失敗の補足テキストを返す。古い成功cacheやfixtureをliveの代わりに返さない。既存のMCPアクセス制御・wallet検証は維持する。

MobileとMCPは同じread応答のeventを投影する。id/triggerAt/category/actions/agentReadable/metadataは同じ入力で一致する。取得タイミング差による別slotの状態差は許容する。event metadataはsource、取得時刻、slot、pending_statusのみとし、量、元本、価格、raw accountを含めない。MCPのpositionsには追加せず、AgentのSKR実行候補も生成しない。

## 5. 端末の確認通知

文言は「SKRの引き出し状況を確認してください」。readyや金額を断定しない。fresh取得時にだけ予定を予約・置換し、同scheduleは1件。OS notification IDと予定キーだけをAsyncStorageに保存する。正常なpending=0、wallet/source/cluster切替、切断で旧予約を取消す。起動時はOS予約一覧と照合する。

payloadの必須欄はtype=cooldown_reminder、schema_version=1、source、cluster、wallet_address、protocol_id、position_account、event_id、schedule_revision。金額、ready、外部URL、plan/tokenを含めない。共有schemaでscopeとIDを検査する。別wallet/source/clusterなら表示せず、walletや署名を自動操作しない。

cold startとforeground listenerは同じ再取得handlerへつなぐ。古いscheduleのtapでも最新readで取消・延期を解決する。同一responseの二重処理抑止はSHOULD。R0では再取得が2回走っても許容し、副作用は持たせない。

app停止中の外部変更は追跡できず、古い確認通知が届き得る。tap後は必ず再取得し、失敗なら更新待ち。permission拒否でもCalendarは使える。過去の予定を初めて検出した場合に遡って通知を発火しない。OS配送時刻・再インストール復元は保証しない。

表示中のpollは5分、app復帰・手動refreshでも読む。終了予定にforegroundで1回再取得し、まだreadyでなければ15→30→60→120→300→600秒で最大6回、経過20分以内の追加retry。RPC失敗も予算を使い、予定変更/取消で旧retryを終了する。

retry状態はメモリだけに置く。同app起動中は同scheduleを再開せず、終了後は5分pollへ戻る。cold startで過去の境界retryを復元せず、通常read/pollから始める。AsyncStorageへのretry予算保存はSHOULD（R1で再検討）。

## 6. 実装順と受け入れ

1. P0のpending準備とraw fixture確保。共有型/schema・SKR registry値を追加。
2. BFF `clients/skr-staking.ts`とread route、共有のevent導出関数。
3. Mobile api/queries、専用row、Calendar詳細。
4. MCP events resourceのread-only投影、端末予約・tap再取得。
5. SeekerでCalendarとAgentの同じ予定、追加解除による更新を録画。

MUSTテストは次の10件にまとめる。入力パターンは同じfixture群で共有する。

| ID | 合格条件 |
|---|---|
| R0-01 読取 | 正常だけfresh。owner/PDA/mint/layout不一致はunsupported、timeoutはunavailable、UserStake不在は正常な空状態。偽の量/日付なし |
| R0-02 batch | config/UserStake/Clock等は同一batch、個別fetch0件。液体SKRの別slot/失敗はstaking判定に影響なし。途中変更の競合再現fixtureはSHOULD |
| R0-03 状態 | active>0かつpending>0、Clock=unlock−1/同時/+1、追加解除、取消、config不明の結果が期待どおり。端末時刻だけでreadyにならない |
| R0-04 予定キー | 他人の操作を模したvault/pool/share_price変更とClock変化でschedule_revision不変、本人timestamp/cooldown変更で変化。event IDは同じ、pending=0は0件 |
| R0-05 契約・UI | 専用型をPositionに代入できず、nullは—、ROI/入金日/portfolio合計を捏造しない。u128最大値を精度を落とさず扱う |
| R0-06 鮮度・scope | 300秒または復帰/失敗でstale、tapはHTTP再取得、旧wallet/古いslotは上書きしない。live→fixture自動fallback0件 |
| R0-07 MCP | 同fixtureからMobileとMCPのeventが一致、freshのみ公開、stale/失敗はSKR event0件。actions空、positionRef=null、positionsと実行候補にSKRが0件 |
| R0-08 通知 | t1→t2観測で旧予約取消・新予約1件。取消/切替後旧予約0件。不正/別scope payloadは表示なし、古いtapは再取得、全ケース署名0件 |
| R0-09 retry | 同app起動の同scheduleで最大6回・20分以内、変更/取消で終了。cold startは通常readへ。予算永続化テストは不要 |
| R0-10 実機デモ | Seekerでdemo識別、permission拒否でもCalendar表示、cold start/tapの再取得を確認。MCPと同じ予定が読める |

| 判定 | 必須証拠 |
|---|---|
| R0-DEMO | 上記MUST合格、fixtureにはdemo表示。live対応完成とは説明しない |
| R0-LIVE | R0-DEMO + LIVE-01/02。fixture代替不可 |
| LIVE-01 | pending実accountのraw batchと取得情報を保存し、採用IDLに基づくdecodeでPDA/user/config、pending/unlock/Clockを照合。独立decoderの新規開発は不要、別ツールでの二重decodeはSHOULD |
| LIVE-02 | Seeker live表示とBFFを照合。tap/復帰でread、失敗時は更新待ち。実装検証による自動署名/送金0件 |

各結果はpass / fail / not_run、実行commit・端末version・証拠パスを記録する。現時点では機能テストは未実施。live pending確保はP0として追跡し、録画前に解消する。追加解除のlive録画を優先し、fixture代替ならその場面を明記する。

共有型変更時は`pnpm -r test`と`pnpm -r typecheck`、Seeker実機確認を行う。既存失敗と新規失敗を分けて記録する。R1基盤やOracle、RFCの未完了をR0の不合格理由にしない。
