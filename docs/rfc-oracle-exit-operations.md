# RFC-001: 本人への出口操作のOracle例外（凍結）

- 作成日: 2026-09-19
- 改訂版: 0.2（2026-09-19）。本人の引出権、account owner、token authorityの検査を分離。
- 状態: **Frozen / 未採用（2026-09-20）**。ハッカソン期間中は実装・詳細改訂を停止。現行規約の例外を有効化しない。
- 対象: [spec.md](spec.md) §4.6、§6.4、§11.6、§13.2、§17.1、§24.7–10、§25.2、§29.3、§32.2、[CLAUDE.md](../CLAUDE.md) §4。
- 起点: [SKRロードマップ](skr-integration-roadmap.md)。R0とは独立。
- 初回対象: `skr_staking` の本人ATAへの単独 `ActionType.Withdraw`。他のwithdrawを自動的に対象にしない。

> **凍結中の本文は旧案であり、実装指示として使用しない。** 再開時は毎回本人承認するverified_self_exitの数量上限、exit_limit_mode、exit_limits、数量policy移行画面と対応テストを削除し、fee/rent上限・適用される非価格policyへ簡素化する。数量の実行時上限用guardは対象外。WithdrawRequiredのClock基準とready後cancel可否を実programで確認する。最新の判断は[ロードマップ §3](skr-integration-roadmap.md#3-r2の操作と検証)に置く。

## 1. 問題と変更理由

現行§4.6はOracle取得失敗でsimulate/executeを一律に止める。しかし、SKRのpending全額を同じmintのまま本人walletへ戻すwithdrawは、交換比率も投資先の選択も必要としない。価格取得障害でこの操作まで止めると、資金回収の可用性が価格サービスに依存する。

SKR/USDの登録はPythとSwitchboardで確認できたが、現環境ではPyth latestが401、Switchboardの定義取得が503、既存方式のfetch/simulateがtimeoutとなった。不存在と可用性は別問題であり、このRFCはfeedが永久に存在しないことを前提にしない。詳細な調査先・IDは連携設計§2.2を参照。

**提案:** リスクを増やす操作、交換・価格評価に依存する操作、およびUSD policyを評価する操作には現行Oracle gateを適用する。検証済みの本人への出口は、別途選択された数量建てpolicyを使えるようにする。

## 2. 例外の対象を限定する

ここからのMUSTは**RFC採用後**の要件。現行実装に適用済みとは扱わない。

| 操作 | 提案する分類 | Oracle |
|---|---|---|
| SKR単独withdraw、pending全額→本人の同mint ATA | `verified_self_exit` | 数量policyを選択済みなら価格非依存 |
| stake/deposit、cancel_unstake | `risk_increasing` | 必須 |
| unstake（新規/追加） | 初回対象外、`price_required` | 必須。追加解除には待機延長がある |
| withdraw+swap、withdraw+deposit、rotate、他人への送金 | `price_required` | 必須 |
| 借入担保のwithdraw、未知protocol、未知instruction | `price_required`または未対応 | 未検証を出口として扱わない |

cancel_unstakeは再ステークであり、withdrawと同じ出口にしない。ActionTypeの文字列だけで分類せず、server registryと実transactionの命令・account・資金フローから決定する。クライアントやAgentの `risk_effect` 自己申告は権限にならない。

### verified_self_exitの必要条件（すべてMUST）

1. program/version、mint、vault、UserStakeのPDA/関連accountを検証する。Solana accountの`owner`（データを管理するprogram）と、token accountデータ内のauthority（tokenを移動できる主体）を別の条件として検査する。
2. 本人の引出権は`UserStake.user = 認証wallet = 承認wallet = MWA署名wallet`で検査する。引き出し元は検証済みprotocol vault、宛先はそのwalletの同mint ATAである。vaultのaccount ownerやtoken authorityに利用者walletとの一致を要求しない。詳細は下表の全条件を満たすこと。
3. confirmedの単一account batchでconfig・UserStake・vault・宛先・mint・Clock等を実行直前に再取得し、pending>0、cooldown完了を検査する。R0表示cacheを実行判断へ使わない。
4. transactionは検証済みwithdrawと限定された補助命令だけ。swap、外部宛送金、approve/delegate、別protocolのCPIを持ち込まない。
5. 補助命令はBFFが構築し承認hashに含めたComputeBudgetとidempotent ATA作成のみ。SOL feeとrentをraw lamports上限内にする。既知programのevent CPI等は採用IDL/プログラムの検証範囲で確認する。
6. simulationで想定するSKR source減少・本人ATA増加を検証し、他資産の想定外流出や負債/担保変化がないことを確認する。
7. 本人の毎操作承認とMWA署名、message完全一致、単発token、job冪等性を維持する。MCPのmanual_only制約は維持する。
8. pending全額が数量上限以下。withdrawにamount引数がないため、上限超過時は一部だけに丸めず拒否する。

### 本人・program・token authorityの検査表

| 対象 | 一致させるもの / 検査 |
|---|---|
| UserStake | Solana account ownerは採用SKR program。discriminator/layoutとPDAを検証し、データ内userは認証・承認・署名wallet、config/pool参照は採用対象と一致 |
| stake_vault（source） | アドレスは検証済みconfig/PDA規則とregistryに一致。Solana account ownerは採用Token Program、データ内mintはSKR、token authorityは検証済みdeploymentのvault authorityに一致 |
| user_token_account（destination） | wallet + SKR mint + 採用Token Programから導出した本人ATAと一致。存在する場合はaccount owner=採用Token Program、データ内authority=本人wallet、mint=SKRを検証 |
| 未作成の本人ATA | 導出アドレスを固定し、承認対象に含むidempotent ATA作成とsimulation後のowner/authority/mint、rent上限を検証 |
| 署名・承認 | fee payerを本人walletに固定し、必要な本人署名と承認messageを検証。IDLの命令signer指定だけでSeasonals側の本人承認を代替しない |

公式IDLはwithdrawをstake vaultからuser token accountへの転送と記述する。[公式IDL](https://github.com/solana-mobile/react-native-samples/blob/main/skr-staking/program/idl.json)。一方、vault authorityの具体値・導出規則はIDLの名前だけから推定せず、採用programとlive accountの照合結果をregistry検証資料に固定する。未確認ならR2の出口capabilityを無効とする。通常のToken Program CPIと検証済みSKR event CPIは既知の実行経路として検証対象に含め、未知の資金移動先やCPIを許可しない。

simulationとBFF検査は、署名後・実行前の状態変化を原子的に防止するものではない。数量上限をchain実行時にも守れることは別の検証条件である。ready後のpending変更可否とtransaction有効期間を検証し、署名後に実行額が上限を超え得る場合は数量例外を有効化しない。より強い保証が必要なら別途on-chain guardを検討するが、R0には持ち込まない。未知のプログラム更新を検出したらexit capabilityを無効化する。

## 3. UserPolicyの改定案

§11.6/§25.2に次のversion付き拡張を提案する。型は `lib/types/user-policy.ts`、runtime schemaは共有libで管理する。

| フィールド案 | 型 / 意味 |
|---|---|
| `exit_policy_version` | `1`。未設定は現行のUSD policyを維持 |
| `exit_limit_mode` | `usd` / `token_amount`。初期値はusd |
| `exit_limits` | cluster + protocol_id + asset_mint ごとの制限配列 |
| `max_exit_amount` | token smallest-unit string。token_amount選択時は必須、正整数 |
| `max_exit_fee_lamports` | fee + priority feeの合計上限。必須の正整数string |
| `max_exit_rent_lamports` | ATA作成等のrent上限。必須のunsigned string |

`exit_limit_mode=token_amount`への変更は、利用者が対象mint・数量上限・fee/rent上限を表示した画面で明示的に保存した場合に限る。MCP clientに自動でpolicyを変更させない。設定変更はversionと監査記録に残す。

**既存のUSD上限を黙って無視しない。** 変更画面で「この検証済みの引き出しにはUSD上限の代わりにSKR数量上限を適用」と説明する。移行前、exit設定欠落、mint不一致、上限欠落の場合は現行Oracle gateを維持する。nullを数量無制限として移行しない。

### 既存policyとの適用関係

| 制約 | verified_self_exit + token_amount | その他 |
|---|---|---|
| max_tx_amount（USD） | 明示移行済み対象のみ数量上限へ置換 | 現行どおりOracle評価 |
| max_daily_executions | 維持。失敗/不明送信を利用した回数制限の迂回を防ぐ | 維持 |
| enabled_protocols / categories / assets | 維持。exitを許可する対応protocolも明示設定する | 維持 |
| approval_mode / client失効 / kill switch | 維持。SKR auto実行は別途未対応 | 維持 |
| min_tvl / min_risk_score / max_lock_days | 単独exitには投資先選別条件として非適用。設定移行時に明示 | 現行どおり |
| ObjectiveのUSD/投資先制約 | 非適用への明示的な定義がある場合のみexitへ移行。未分類の制約は拒否 | 現行どおり |
| fee/rent上限 | SOL lamportsで評価。SKR/USDやSOL/USDは不要 | 既存+必要な価格評価 |

この適用関係の変更もRFCの一部であり、Oracleだけ外して別のUSD制約を未評価のまま通さない。必要なら利用者がexitを許可するpolicyへ別途変更する。全policyを一律に緩和しない。

## 4. §4.6へ追加する規範文案

> Oracle gateの適用前に、serverはregistryと検証済みtransaction内容から、当該操作が価格評価を必要とするか判定する。未分類は価格評価必須とする。
>
> リスク増加、価格変換、または適用されるUSD policyの評価を伴う操作には、現行のPyth primary / Switchboard fallback、60秒、乖離閾値とfail-closedルールを適用する。
>
> 検証済みの本人への単独出口操作に限り、利用者が数量建てexit policyを選択し、対象token数量・SOL fee/rentの上限と全非価格policyを満たす場合は、価格の未取得・stale・乖離を実行停止理由にしない。価格以外の不明な状態、命令、宛先、署名、残高、policyは従来どおりfail-closedとする。
>
> 価格非依存で実行する場合、Oracle statusをhealthyに偽装せず、`oracle_requirement=not_required_verified_exit`を記録する。USD見積りは未取得ならnullとし、価格未評価の理由、適用数量上限、適用policy versionを承認画面と監査に示す。

### 判定表

| 条件 | simulate | execute |
|---|---|---|
| 価格必須、Pyth fresh | 現行どおり | 現行どおり |
| 価格必須、Pyth stale/unavailable、検証済みSwitchboard fresh | fallbackと警告 | fallbackと警告 |
| 価格必須、両stale/利用不能 | 拒否 | 拒否 |
| 価格必須、両freshで乖離>5% | 警告付き | 拒否 |
| verified_self_exit、token policy有効、価格なし/古い/乖離 | 数量・feeでsimulation | 他のMUSTが成立した場合のみ許可 |
| withdrawという名前だが内容未検証 | 未対応または価格gate | 未対応または価格gate |
| exitなのにwallet/account/数量/署名検査失敗 | 拒否 | 拒否 |

Pyth unavailable + Switchboard freshの扱いは、現行表で明文化が弱い箇所を補う提案。HTTP 401を価格0やfreshなsourceに変換しない。SwitchboardのUI価格やローカル受信時刻だけでsourceの鮮度を証明しない。

## 5. API・監査・移行の範囲

`SimulationResult`と実行監査へ `oracle_requirement`、`exit_policy_version`、対象mint、quantity/fee/rent limit、registry version、判定理由を追加する。価格がnullなのに既存consumerが数値化できないよう、runtime schemaとconsumerテストを追加する。

採用時の一括変更対象:

1. spec §4.6 / §6.4 / §11.6 / §13.2: 操作分類・policy適用・registry capability。
2. spec §17.1 / §24.7–10 / §25.2: 分類結果、数量上限、policy versionのAPI・DB・監査。
3. spec §29.3 / §32.2、CLAUDE.md §4: 「価格必須操作のOracle異常は拒否、価格非依存出口も非価格条件はfail-closed」と表現を更新。
4. `lib/types` / validation、BFF oracle gateとpolicy gate、Mobile WarningArea/承認表示、MCP tool schemaを同じ変更単位で整合させる。

初期feature flagはoff。単独SKR withdrawで検証後に対象walletへ限定公開する。flagをoffに戻した場合は現行Oracle gateへ戻し、確定待ちjobの照会・監査を継続する。すでに送信されたtxを取り消せるとは説明しない。

## 6. 採用時の受け入れテスト

| ID | 入力 / 操作 | 必須結果 |
|---|---|---|
| EXIT-01 | token policy選択済み、検証済みSKR自己withdraw、価格未取得 | USD=null、not_required_verified_exitを記録。正常simulationを返す |
| EXIT-02 | stake / cancel / 追加unstake / withdraw+swap、両価格未取得 | 例外分類されず拒否。broadcast0件 |
| EXIT-03 | 他walletのATA、別mint、未知命令、walletが命令を追加 | 拒否。broadcast0件 |
| EXIT-04 | pending全額がmax_exit_amountを1 unit超過、fee/rent超過 | 拒否。一部額に勝手に変更しない |
| EXIT-05 | 旧USD policy、exit設定未保存、上限欠落、別mint | 数量例外に移行しない。現行価格gateを適用 |
| EXIT-06 | 明示移行後でもdaily超過、client失効、manual_onlyのAgent | 拒否。token再利用やpolicy迂回なし |
| EXIT-07 | simulation後pending/config変化、期限切れ/消費済みtoken、再送不明 | 再承認または拒否。新しいtxを自動再送しない |
| EXIT-08 | 価格必須操作でfresh fallback / 両stale / >5% | fallback+警告 / 両段階拒否 / simulate警告かつexecute拒否を維持 |
| EXIT-09 | 正常なprotocol vault（account ownerもtoken authorityも本人walletではない）、本人UserStake・ATA、他条件成立 | verified_self_exitとして正常simulation。所有者誤判定による拒否なし。検証環境の実行fixtureでは承認messageを1回送信し、confirmation後のみ成功 |
| EXIT-10 | UserStake.user不一致、偽vault、vault authority不一致、宛先のaccount owner/authority/mint不一致、本人署名なしを各々注入 | 各ケースで拒否、broadcast0件。単なるsource-wallet不一致を異常fixtureとして使わない |

政策判断として残るのは、この限定出口にUSD上限を数量上限へ置換する設定を提供するかどうかである。実装検証として残るのはlive SKR命令、wallet別署名互換性、状態競合の許容範囲。いずれも本RFCの作成をもって採用済み・検証済みとはしない。
