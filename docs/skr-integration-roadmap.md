# SKR 後続ロードマップと調査記録

2026-09-20 / R0の実装指示は [専用文書](skr-r0-implementation.md)。本書の作業はR0の依存にしない。

## 1. リリースと依存

| 段階 | 成果 | 依存 |
|---|---|---|
| R1 | アプリ停止中の監視・wallet別push・復旧 | FND-01/02/03 |
| R2a | 本人による単独withdraw | FND-01/04、program/署名検証、現行Oracle規約または改定採用。R1のoutboxには依存しない |
| R2b | stake / unstake / cancel | R2a、利用可能な価格経路、各命令の検証 |
| R3 | SKR positionのMCP公開、Agent実行 | nullable会計契約と全consumer移行、権限・policy検証。event読取はR0で提供 |

| 案件 | 成果 / 検証 |
|---|---|
| FND-01 | nonce/domain/期限/署名検証、wallet scopeの認証。別userの購読・plan拒否 |
| FND-02 | Postgres、汎用cooldown_cyclesとsubscription、再起動復旧 |
| FND-03 | account購読、repair poll、outbox、lease/retry/receipt。送信直前の状態検証 |
| FND-04 | plan/token/jobの永続化、message承認束縛、token消費、署名照会、job所有権検査 |
| ORA-01 | 下記の通常curlを実際のBFF配備環境でも再実行し、認証条件、feed同定、鮮度、異常系を確認 |
| PROD-01 | 公式ポータル/Seed Vault Walletの通知をversion・permission付きで実機比較 |

## 2. R1の観測と通知

`cooldown_cycles`はprotocol_id、cluster、wallet、position_account、poolのscope、cycle_id、mint、pending量、unlock_at、status、導出に必要なprotocol_state、観測時刻/slotを持つ。open cycleはscopeあたり1件。観測上pending>0が連続した期間を1cycleとし、未観測cancel→再解除は統合され得る。lineage=observed_onlyを明示し、会計や厳密な回数には使わない。

履歴パーサ、signature backfill、wallet_indexer_cursors、別skr_snapshotsは導入しない。変更検出用revisionが必要になった時点で、本人UserStakeと導出に実際に使うconfigフィールドのみから定義する。共有vault残高・pool総量をhash入力へ含めない。

pendingはaccount購読+15分repair、activeのみは30分。unlock前後だけ境界jobで再検証し、Clock未到達時のretryは上限を設ける。状態更新とoutboxを同transactionで保存し、送信直前に最新state・予定キー・subscriptionを確認する。OS配送のexactly-onceは保証しない。

R0で省略したretry予算の永続化、時計変更への追加耐性、通知response二重処理抑止、batch中変更の競合再現試験はここで必要性を再評価する。

受け入れは他userへの送信0件、再起動後の予定復旧、取消/延期後の旧job配送0件、未観測系譜のbackfill呼出し0件。端末の受信履歴は重複を抑えるが、OS通知欄の完全な重複排除は約束しない。

## 3. R2の操作と検証

withdraw→ActionType.Withdraw、stake→Deposit、unstake→Unstake、cancel_unstake→Cancel。cancelは再ステークなので価格非依存出口にしない。withdraw/cancelに部分量UIを作らない。部分unstakeはsharesの丸めを検証する。

simulate→承認→MWA署名→broadcast→confirmationの順。承認対象にcluster/wallet、program、account順序/権限、instruction bytes、金額/shares、状態制約、fee、registry versionを束縛する。状態変更は再simulation/再承認、不明送信はsignature照会を先に行う。tokenを原子的に消費し、unknown actionを既存swap等へfallbackしない。Agentのmanual_onlyを維持する。

walletから返るmessageは完全一致を要求し、guard/compute budget追加も初期版ではwallet_message_modifiedで拒否する。署名追加のみは許可。命令を黙って除去しない。Seed Vault Wallet / Phantom / Solflare / Backpackごとにversion、MWA経路、正常署名と改変拒否を確認し、検証済みの対応一覧のみ公開する。

[RFC-001](rfc-oracle-exit-operations.md)はハッカソン期間中凍結。再開時の方針は、毎回本人承認するverified_self_exitから数量上限・exit_limit_mode・exit_limits・数量policy移行画面を除き、fee/rent上限と適用される非価格policyを残すこと。USD上限の非適用をspecで明示し、既存規約を未改定のまま迂回しない。Agent自動実行は対象外。

競合検証はWithdrawRequiredのready判定がチェーンClock基準か、ready後のcancelが可能か、config変更で判定が変わるかに絞る。IDL上の説明だけでlive deploymentの保証にしない。出口数量上限用のon-chain guardは作業対象外。

## 4. 第2protocolと製品検証

同じCooldownPositionViewとCalendar/MCP投影を第2protocolのreaderでも使えることを示すのはSHOULD。SKRのlive readと録画が完成してから、残り1–2人日の範囲で候補を調べる。program/fixture未確認のまま対応を公称しない。型だけの合成fixtureは「契約の再利用デモ」と表示する。汎用workflow engineは作らない。

公式通知の有無にかかわらず、訴求は「他DeFi予定と同じCalendar」「人とAgentが同じeventを読む」。公式に通知がないとは実機確認前に主張しない。3〜5人の試用で横断Calendarの価値と延期の理解を観察し、価値が弱ければR1基盤投資を止める。

## 5. spec照合の基準

spec v0.2.15（SHA-256 abc118ae59062f308030b880097b6293487b07d694bc1e525f4aa31f55353cff）と共有enumを照合済み。12 ActionType、8 TimeEventCategoryは一致。agentReadableはMCP公開フラグで実行許可ではない。

triggerAtのDate/string、positionRefのnullable/optional、ActionDescriptor.riskLevelにはspec内部と共有型の差がある。R0は既存UnifiedTimeEventDTOを採用し、actions=[]、positionRef=null。本番認証、DB、監査の要求はFND案件で扱う。現行OracleはPyth primary、Switchboard fallback、60秒、両stale/未取得で拒否、>5%乖離はsimulate警告/execute拒否。

## 6. Oracle・公式通知の調査証拠


**調査日: 2026-09-19。登録の存在、API利用可能性、本番適合性を区別する。**

| 対象 | 実際の確認結果 | 設計への影響 |
|---|---|---|
| Pyth SKR/USD | Hermesの一覧検索は成功し、`Crypto.SKR/USD`、説明`SEEKER / US DOLLAR`の1件を返した | 「feed不存在の可能性」のままにしない |
| Pyth最新価格 | 見つかったIDで、認証情報なしのlatest取得はHTTP 401、bodyはunauthorized | 利用可能な価格は未取得。必要な認証/利用条件を確認し、freshness実測が終わるまでR2bの解禁条件にしない |
| Switchboard SKR/USD | 公式Explorer検索でSKR/USDと価格・更新表示、完全なfeed IDを確認 | feed候補は存在する |
| Switchboard定義/価格API | Explorerの詳細は`/v2/fetch`で503。既存BFFと同系統のv1 fetch/simulateは各20秒timeout | UI表示だけで既存BFFに接続済みとは判断しない。v1/v2・配信形態・情報源を検証する |
| 公式ポータルの引き出し通知 | FAQはready表示・手動withdrawを説明するが、OS/push通知の有無は確認できなかった | 「公式には通知がない」と宣伝しない |
| Seed Vault Walletの通知 | 公式ヘルプ検索、Seeker MR6–MR9を確認。SKR withdraw-ready通知の有無を確定する記述なし | 実機比較は未実施。有無の断定を保留する |

Pyth ID: `38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9`。
一覧の`min_channel=fixed_rate@200ms`も記録したが、401の原因や料金をこの属性だけで断定しない。
根拠: [Hermes一覧クエリ](https://hermes.pyth.network/v2/price_feeds?query=SKR&asset_type=crypto)、[latest取得先](https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9)。

Switchboard ID: `595535537cc4c9faab659af2a7b303857b0f1d981d97be1679ca8a464931e75f`。
根拠: [公式ExplorerのSKR候補](https://explorer.switchboardlabs.xyz/?search=SKR&feed=595535537cc4c9faab659af2a7b303857b0f1d981d97be1679ca8a464931e75f)、[Crossbar API](https://docs.switchboard.xyz/tooling/crossbar/api-endpoints.md)。custom feedを作れることと、既存の信頼できるSKR feedが利用可能なことは別である。

通知調査の根拠: [Staking FAQ](https://stake.solanamobile.com/)、[公式Walletヘルプ](https://wallet-help.solanamobile.com/en/)、[MR6](https://docs.solanamobile.com/seeker/release-notes/mr6)、[MR7](https://docs.solanamobile.com/seeker/release-notes/mr7)、[MR8](https://docs.solanamobile.com/seeker/release-notes/mr8.md)、[MR9](https://docs.solanamobile.com/seeker/release-notes/mr9.md)。OSリリースノートはWallet単体の全機能一覧ではなく、不記載は「存在しない」証拠にならない。

### 2026-09-20: 通常curlによる開発ホストの再検証

エージェントのファイルsandbox外で、macOS開発ホストのBFFディレクトリから認証headerなしのcurlを実行。BFFと同じHermes/latest、Crossbar/simulateのURLを使用。curlはHTTP失敗と接続timeoutを別に記録し、各要求の上限は20秒。

| 要求 | 結果 |
|---|---|
| Hermes SKR一覧 | 200。SKR/USDの同じ登録IDを確認 |
| Hermes SKR latest | 401 unauthorized、約0.07秒 |
| Hermes SOL latest（対照） | 401 unauthorized、約0.05秒 |
| Crossbar /simulate/<SKR候補ID> | HTTP000、curl exit28、約20秒、0bytes |
| Crossbar /fetch/<SKR候補ID> | HTTP000、curl exit28、約20秒、0bytes |

同ホストのLISTEN一覧ではBFFのdefault 3030等の稼働を確認できなかった。したがってこれは**BFF開発ホストの通常ネットワークでの再現**であり、稼働中BFFコンテナ/本番配備環境の検証完了ではない。sandboxだけに原因を帰す根拠は弱まったが、ホスト側ネットワーク制限とサービス側条件は未分離。ORA-01は配備環境でこの比較を再実行するところから始める。

再現コマンド（feed IDは上記。shellのURLは必ずquoteする）:

```sh
curl --silent --show-error --max-time 20 --output /tmp/skr-pyth.body --write-out 'HTTP=%{http_code} elapsed=%{time_total}\n' 'https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=38846ec4d0dbe808091817f5c0d6ab8058e25422348ddf97db52b6c378a93bf9'
curl --silent --show-error --max-time 20 --output /tmp/skr-crossbar.body --write-out 'HTTP=%{http_code} elapsed=%{time_total}\n' 'https://crossbar.switchboard.xyz/simulate/595535537cc4c9faab659af2a7b303857b0f1d981d97be1679ca8a464931e75f'
```

Pythの公式資料はfixed_rate@200msをProの配信channelと説明し、access tokenにasset/channel/feedごとの権限があることを示す。[配信channel](https://docs.pyth.network/price-feeds/pro/subscribe-to-prices)、[認証・権限FAQ](https://docs.pyth.network/price-feeds/pro/faq)。このため契約/endpoint/認証条件の確認をORA-01へ含める。ただし、SKRに特定の有償契約が必須か、今回のHermes 401の直接原因かは未確定。SOL対照も401であり、SKR固有問題と断定しない。

### 2026-10-05 追記: Oracle 前提の更新 (R0 には影響なし)

上の調査 (Hermes REST / Switchboard Crossbar) は前提が変わった。Seasonals の oracle gate は 2026-10 から Solana 上の push feed account を Helius RPC で読む構成に移った (CLAUDE.md §4、`lib/config/oracle-feeds.ts`)。Pyth Hermes REST は 2026-08-26 に API key 必須となり、上の 401 はこれと整合する (SOL 対照も 401)。Switchboard は 2026-09-25 にサポート終了。

- R0 は価格を使わない (元本 / 収益 / USD は null) ので、Oracle の状態は R0 の合否に関係しない
- R2b 以降で SKR の価格が必要になったら、Pyth sponsored push feed (shard 0) と RedStone push feed に SKR/USD があるかを調べ、`oracle-feeds.ts` の tier (A〜D) で宣言する。ORA-01 はこの調査に置き換える
- SKR は Menu registry に載せていないので、現時点で tier 宣言は不要 (oracle-feeds.test.ts は registry の mint だけを検査する)
