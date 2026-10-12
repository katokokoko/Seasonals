# Seasonals × Hyperliquid 連携 実装設計書

- バージョン: **0.1** / 作成日: 2026-09-19
- ステータス: 実装提案。アプリコード・DB・本番設定の変更は含まない。**ハッカソン / Crypto World's Fair デモの対象は HL-R0 と HL-R1 のみ**。
- 基準: [spec.md v0.2.15](spec.md)、[CLAUDE.md](../CLAUDE.md)、[backend-core-pipeline.md](backend-core-pipeline.md)、[design-system.md](design-system.md)、ローカル HEAD `eb4f94c`。
- 起点: [プロトコル実装提案 (ChatGPT)](https://chatgpt.com/share/6aae0cc8-af60-83ee-823d-caea4d03dc08)。会話本文は全文取得済み。本書は同会話の候補評価と `ChainRef` / `ExecutionPayload` 案を引き継ぎ、実コードと公式資料で裏取りした上で再構成した。
- 姉妹文書: [skr-integration-design.md v0.2](skr-integration-design.md)。**nullable 共有型・cycle・ローカル通知・FND 案件の設計はそのまま流用する**。本書で再定義しない。

## 0. 結論

**Hyperliquid 統合は「protocol を 1 つ足す」案件ではなく、Seasonals を Solana calendar から chain 非依存の time layer へ広げる分岐点として扱う。** ただし着手順は逆で、基盤の一般化を先に完成させない。**HyperCore native staking と HLP の読取 (HL-R0) を最小スライスとして通し、その実装が要求する最小限の型拡張だけを `lib/` に入れる。**

| 判断 | 内容 |
|---|---|
| 最初に通す | HyperCore native staking (delegation lock 1 日 / unstaking queue 7 日) と HLP (最終 deposit から 4 日 lock)。公式 info endpoint が timestamp を返すので Seasonals 側の推測が要らない |
| デモの主役 | Pendle on HyperEVM の **PT-kHYPE 2026-09-24 満期** (実在確認済み、本日から 5 日後)。maturity → Redeem / Roll の一連を既存 Exponent 経路 (Phase 8.33/8.34) と同型で見せる |
| 最大の設計制約 | **Seeker の Seed Vault / MWA は EVM 署名 (secp256k1 / EIP-712) を扱えない。** HyperCore action も HyperEVM tx も EVM 鍵の署名が必要。したがって R0/R1 は読取専用、実行 (HL-R2) は外部 EVM wallet (WalletConnect) を署名者とする別経路になる |
| Oracle | HYPE/USD と kHYPE/USD は Pyth Hermes に feed が存在 (ID 確認済み)。Switchboard 側 feed は未確認。**§4.6 は変更しない**。両 feed が揃うまで HYPE 建て execute は解禁しない |
| enum | `TimeEventCategory` 8 種、`ActionType` 12 種、`PositionCategory` 10 種は**増やさない** (§32.2)。TWAP / funding は既存 category + `metadata.source` で表す (Phase 8.16 の `helius_tx` と同じ前例) |

## 1. リリース境界

| リリース | 提供する価値 | 必須依存 | 優先順位 |
|---|---|---|---|
| **HL-R0: HyperCore 読取** | 利用者が入力した EVM address の native staking (delegation lock / unstaking queue) と HLP (withdraw 可能日) を Your Positions と Calendar に表示。既存 Solana 予定と同一画面 | 既存 BFF、Hyperliquid 公開 info endpoint、`ChainRef` 最小導入、nullable view 型 (SKR 設計 §5) | **実装対象** |
| **HL-R1: HyperEVM 読取 + PT デモ** | Pendle PT (kHYPE 24SEP2026 ほか chain 999 の active market) の maturity と Kinetiq kHYPE unstake queue を Calendar に表示。Redeem / Roll は **候補表示のみ** (CTA なし) | HL-R0、BFF に `viem` (read only)、Pendle API、Kinetiq StakingManager read | 実装対象 (デモ) |
| HL-R2: 実行 | HyperCore user-signed action (cDeposit / cWithdraw / tokenDelegate) と L1 action (vaultTransfer)、HyperEVM tx (Kinetiq queue/confirm、Pendle redeem/roll) を simulate → approve → 外部 EVM wallet 署名 → broadcast | **EVM 署名経路 (WalletConnect / Reown AppKit RN)**、`ExecutionPayload` 一般化、Switchboard HYPE feed、FND-01/04 (SKR 設計 §8) | 別判断 |
| HL-R3: 時間軸の拡張 | TWAP の実行 window 表示と作成、funding / portfolio margin interest の日次集約、HyperLend health forecast、Boros | HL-R2、WebSocket 購読基盤 (FND-03)、agent wallet 方針 | 別判断 |

**HL-R0 から外す:** EVM 署名、WalletConnect、`viem`、DB、認証、server push、MCP 公開、USD 合計への算入、funding、TWAP、portfolio margin、HyperLend、Hyperbeat、Boros、`AdapterContext.chain` の破壊的変更、Solana adapter の書き換え。

### 要求の強さ

- **MUST**: 該当リリースの受け入れ条件。対応テスト ID が未達ならそのリリースを合格にしない。
- **SHOULD**: 改善推奨。省略理由を記録すればリリース可能。
- **DEFER**: 当該リリースに入れない。
- 監視間隔・cache TTL・工数は Seasonals の設計値であり、外部プロトコルの仕様ではない。

## 2. 外部仕様として確認したこと

調査日: 2026-09-19。**登録の存在・API 利用可能性・本番適合性を区別する。** 未確認項目は §2.3 に集約し、確認されるまで設計上は「不明」として扱う。

### 2.1 Hyperliquid (HyperCore / HyperEVM)

| 対象 | 確認結果 | 根拠 |
|---|---|---|
| Delegation lock | "Delegations to a particular validator have a lockup duration of 1 day." | [Staking](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/staking) |
| Unstaking queue | "Transfers from staking account to spot account have a 7 day unstaking queue." 例: 3/11 08:00:00 UTC 開始 → 3/18 08:00:01 UTC 完了 | 同上 |
| Pending withdrawal 上限 | "Each address may have at most 5 pending withdrawals in the unstaking queue." | 同上 |
| 報酬 | 毎分 accrue、毎日 distribute、同 validator へ自動再投資 | 同上 |
| HLP lock | "The deposit lock-up period is 4 days." / "you can withdraw 4 days after your most recent deposit" | [Protocol vaults](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/protocol-vaults) |
| info: `delegatorSummary` | 応答 `delegated` / `undelegated` / `totalPendingWithdrawal` / `nPendingWithdrawals` | [Python SDK info.py](https://raw.githubusercontent.com/hyperliquid-dex/hyperliquid-python-sdk/master/hyperliquid/info.py) |
| info: `delegations` | 各 delegation に `validator` / `amount` / `lockedUntilTimestamp` | 同上 |
| info: `delegatorHistory` / `delegatorRewards` | delegation / undelegation の履歴、報酬履歴 (`time` / `source` / `totalAmount`) | 同上 |
| info: `userVaultEquities` / `userNonFundingLedgerUpdates` / `userFunding` / `userTwapSliceFills` / `portfolio` | 存在する。vault 入出金は ledger updates に現れる | 同上 |
| exchange: `twapOrder` | `{type:"twapOrder", twap:{a,b,s,r,m,t}}` (`m` = minutes、`t` = randomize)、`twapCancel {a, t}` | [Exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint) |
| exchange: staking / vault action | `cDeposit` / `cWithdraw` / `tokenDelegate` は `hyperliquidChain` + `signatureChainId` + `wei` + `nonce` を持つ user-signed action。`vaultTransfer {vaultAddress, isDeposit, usd}` | 同上 |
| 署名 (L1 action) | EIP-712 domain `Exchange` / version `1` / **chainId 1337** / `Agent{source:"a"(mainnet) or "b"(testnet), connectionId}` | [Python SDK signing.py](https://raw.githubusercontent.com/hyperliquid-dex/hyperliquid-python-sdk/master/hyperliquid/utils/signing.py) |
| 署名 (user-signed action) | domain `HyperliquidSignTransaction`、chainId は action の `signatureChainId`。primary type に `HyperliquidTransaction:TokenDelegate` / `:ApproveAgent` / `:Withdraw` / `:UsdSend` 等 | 同上 |
| API wallet (agent) | `approveAgent` で最大 180 日の agent を承認。unnamed 1 + named 3。**withdraw 等の user 固有 action は実行不可** | Exchange endpoint |
| WebSocket | `twapStates` / `userTwapSliceFills` / `userTwapHistory` / `userFundings` / `clearinghouseState` / `spotState` (`isPortfolioMargin`) | [Subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions) |
| Rate limit | REST は IP 単位 **1200 weight / 分**。`clearinghouseState` / `spotClearinghouseState` は weight 2、**それ以外の info は weight 20** | [Rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits.md) |
| HyperEVM | mainnet chain ID **999**、RPC `https://rpc.hyperliquid.xyz/evm`、gas token HYPE。testnet 998 | [HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) |
| Portfolio margin | 適格条件付き段階展開 (>$10k 残高等)。借入利息は毎時 index、`portfolio_margin_ratio > 0.95` で liquidatable。遊休資産は自動で利回り | [Portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin.md) |

### 2.2 HyperEVM protocol / oracle / 署名境界

| 対象 | 確認結果 | 根拠 |
|---|---|---|
| Pendle chain 999 active markets | kHYPE **2026-09-24** (market `0xb48b0c95b2ddc464484305b7363fad5bd5b7a683`、PT `0x50fc4edc6346f36993bb30fe60e932504ed17391`)、kHYPE **2027-03-25** (market `0x697dd29eed8e926205a08400a60d1578154c1a60`、PT `0x9ccac9566fba516a5df00a23e81801b1f1cb57a8`)、他 vkHYPE / stHYPE / haHYPE / limUSD | [Pendle API](https://api-v2.pendle.finance/core/v1/999/markets/active) |
| Pendle Hosted SDK | `POST /v3/sdk/{chainId}/convert` (`tokensIn` / `tokensOut` / `amountsIn` (wei) / `receiver` / `slippage`)。満期後 PT の redeem と PT→PT roll を同一 endpoint で扱う | [Hosted SDK](https://docs.pendle.finance/pendle-v2-dev/Backend/HostedSdk) |
| Kinetiq unstake | "~8–9 days total: includes 1-day delegation lockup + 7-day unstaking queue"。DEX での即時売却が代替 | [kHYPE](https://kinetiq.xyz/docs/khype) |
| Kinetiq contracts (mainnet) | kHYPE `0xfD739d4e423301CE9385c1fb8850539D657C296D`、StakingManager `0x393D0B87Ed38fc779FD9611144aE649BA6082109`、StakingAccountant `0x9209648Ec9D448EF57116B73A2f081835643dc7A` | [Contracts](https://kinetiq.xyz/docs/contracts-and-audits) |
| Kinetiq read / write | `withdrawalRequests(user, id)` → `{hypeAmount, kHYPEAmount, kHYPEFee, timestamp, bufferUsed}`、`withdrawalDelay()` 秒、`queueWithdrawal(kHYPEAmount)`、`confirmWithdrawal(withdrawalId)`。TypeScript + viem 例あり | [Integration](https://kinetiq.xyz/docs/integration) |
| Pyth HYPE/USD | `Crypto.HYPE/USD` ID `4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b` | [Hermes](https://hermes.pyth.network/v2/price_feeds?query=HYPE&asset_type=crypto) |
| Pyth kHYPE/USD | `Crypto.KHYPE/USD` ID `2837a61ae8165c018b0e406ac32b1527270e57b81f0069260afbef71b9cf8ffe` | 同上 |
| MWA の chain | "The currently supported Solana network chains are `solana:mainnet`, `solana:testnet`, and `solana:devnet`."。他 chain は将来構想。`ERROR_CHAIN_NOT_SUPPORTED` で拒否可 | [MWA spec](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html) |
| Seed Vault | 派生 path は `m/44'/501'/...` (Solana)。Ethereum / secp256k1 / EVM の記述なし | [Integration guide](https://raw.githubusercontent.com/solana-mobile/seed-vault-sdk/main/docs/integration_guide.md) |

### 2.3 未確認 (設計上「不明」として扱う)

| 項目 | 影響 | 確認方法 |
|---|---|---|
| `vaultDetails` info type の follower 別 `lockedUntilTimestamp` | あれば HLP unlock を直接取得できる。無ければ `userNonFundingLedgerUpdates` の最終 vault deposit 時刻 + 4 日で導出 | 実 endpoint 叩き (weight 20) |
| HyperCore の HYPE `weiDecimals` (期待 8) と `vaultTransfer.usd` の単位 (期待 1e6) | smallest unit 変換の桁。**間違えると金額が 10^10 ずれる** | `spotMeta` の `tokens[].weiDecimals` を registry に固定し、実 response で assert |
| unstaking queue の個別 withdrawal 開始時刻 | `delegatorSummary` は合計と件数のみ。個別時刻は `delegatorHistory` から | 実 response の event 形状を fixture 化 |
| Switchboard HYPE/USD feed | 無ければ §4.6 の fallback が無く HYPE 建て execute は解禁不可 | Switchboard Explorer / Crossbar |
| Pendle API の user positions endpoint (chain 999 対応) | 無ければ PT 残高は viem で ERC-20 `balanceOf` を読む | OpenAPI JSON |
| Kinetiq の withdrawal request 列挙 (id 範囲) と cancel の有無 | cancel が無い前提で UI に出さない (fail-closed) | ABI / docs |
| Hyperbeat vault の withdrawal period (3 営業日?) | HL-R3 候補。本書では設計しない | 公式 docs |
| Reown AppKit RN と Seeker (Android) の実機互換 | HL-R2 の署名経路の成立条件 | 実機 |

## 3. spec / CLAUDE.md 照合と設計分岐

### 3.1 照合結果

| 仕様 | 照合結果 / 判断 |
|---|---|
| §4.4 / §5.7 / §24.9 | `ActionType` 12 種と一致。Hyperliquid のために増やさない。TWAP 作成は `deposit` ではなく **HL-R3 で `metadata.kind = "twap"` を持つ `rotate` 相当として再検討**。R0–R2 では ActionType を消費しない |
| §11.4 / §25.2 / §26.2 | `TimeEventCategory` 8 種と一致。staking lock / unstaking queue / HLP lock / Kinetiq queue → `lockup_end`、PT → `maturity`、funding・interest 日次集約 → `epoch` + `metadata.source`、TWAP window → `forecast_marker`、portfolio margin / HyperLend → `health` |
| §11.4 `agentReadable` | R0 は false (SKR 設計 §5 と同じ理由: nullable 契約が未版付け)。R1 で `schema_version` 付き DTO を固定した後 true にする |
| §4.5 | Hyperliquid info は **10 進小数 string** (`"12.34567891"`)、exchange の `wei` は整数。両方 `toSmallestUnit` / `toBigInt` 経由。`Number()` 禁止 |
| §4.6 | 変更しない。HYPE / kHYPE は Pyth feed を登録、Switchboard feed 確認まで execute は `oracle_unavailable` 相当で拒否。**not_configured の素通しに乗せない** (新 asset を意図的に gate 対象へ入れる) |
| §6.5 | "署名は必ず MWA" は **Solana の前提**。EVM 署名は MWA / Seed Vault では不可能なので、§6.5 の「制限付き委任 / セッション認証 / spending guard」枠に **外部 EVM wallet 署名**を追加する spec 改定 (HL-R2 着手条件、§8.1) |
| §11.1 Wallet | `address` は Solana base58 のみ。EVM address は `Wallet.linked_accounts` として追加し、**R0 は所有未検証の読取専用**と明示 |
| §13.2 registry | `hl_staking` / `hl_hlp` / `kinetiq` / `pendle` / (R3) `hyperlend` を追加。`chains: ChainRef[]` を持たせる。R0 では `hl_staking` / `hl_hlp` のみ enabled |
| §26 Adapter SDK | `AdapterContext.chain` は `"solana:devnet" \| "solana:mainnet"`。**R0 は触らない**。R2 で `chain_ref?: ChainRef` を追加 → 全 adapter 移行後に `chain` を廃止する 2 段階 (§4.2) |
| §32.2 "秘密鍵を保持しない" | R0–R2 で維持。HL-R3 の agent wallet (approveAgent) は BFF が鍵を持つ構造なので **DEFER、feature flag + 監査後** (Phase 8.29 と同じ枠) |
| §32.2 "One tap. No new tab." | R0/R1 は読取のみなので**訴求しない**。R2 でも外部 EVM wallet への app 切替が入るため "no new tab" を Hyperliquid には使わない |

### 3.2 署名境界の分岐 (最重要)

```text
                       Solana (既存)                 HyperCore                 HyperEVM
署名鍵                 ed25519 (Seed Vault)           secp256k1 (EVM 鍵)         secp256k1 (EVM 鍵)
署名対象               Solana tx                      EIP-712 typed data        EVM tx (eth_sendTransaction)
Seasonals の経路       MWA signTransactions           不可 (MWA/Seed Vault 非対応)  不可 (同左)
R2 の署名者            そのまま                       外部 EVM wallet (WalletConnect)  同左
agent wallet 可否      —                              L1 action のみ (TWAP / vaultTransfer)  —
                                                     staking 系は user-signed → 本人鍵必須
```

決定:

- **HL-R0 / R1 は EVM address を「読む」だけ。** 署名も、署名を促す CTA も出さない。
- **HL-R2 の署名者は利用者自身の外部 EVM wallet。** Seasonals は unsigned payload (typed data / tx) を組み、WalletConnect session 経由で署名を依頼し、署名済み payload を受け取って broadcast する。Solana の MWA と同じ「Seasonals は鍵を持たない」構造を EVM でも維持する。
- **agent wallet は staking 操作を代替できない** (`tokenDelegate` / `cDeposit` / `cWithdraw` は user-signed)。よって "agent が unstake を自動実行" は Hyperliquid の仕様上成立しない。R3 で agent wallet を検討する範囲は TWAP と vault transfer に限る。

## 4. アーキテクチャ: chain 汎用化

### 4.1 `lib/types/chain.ts` (新設、R0)

```typescript
/** §4.4 snake_case。wire では CAIP-2 風の string id も併用する (chainRefId) */
export type ChainRef =
  | { family: "solana"; network: "mainnet" | "devnet" }
  | { family: "evm"; chain_id: number }             // 999 = HyperEVM
  | { family: "hypercore"; network: "mainnet" | "testnet" };

export function chainRefId(c: ChainRef): string;  // "solana:mainnet" | "eip155:999" | "hypercore:mainnet"
export function parseChainRefId(s: string): ChainRef | null;
```

R0 で `ChainRef` を使うのは **registry entry・nullable view 型・event `metadata.chain`** の 3 か所だけ。既存 `Position` / `AdapterContext` / `Wallet.address` は変更しない。

### 4.2 `ExecutionPayload` (R2)

```typescript
export type ExecutionPayload =
  | { kind: "solana_tx"; tx_base64: string }
  | { kind: "evm_tx"; chain_id: number; to: string; data: string; value: string /* wei string */ }
  | {
      kind: "hypercore_action";
      signing: "l1" | "user_signed";
      action: Record<string, unknown>;   // exchange endpoint の action そのまま
      nonce: number;                     // ms timestamp (§4.5 適用外の整数)
      typed_data: Eip712TypedData;       // wallet に渡す完成形
    };
```

`AgentPlan.simulation_result.bundle_hash` は **payload の canonical serialization** から算出する (Solana では tx bytes、HyperCore では `typed_data` の hash、EVM では `to+data+value+chain_id`)。approval token の `bundle_hash` 照合 (§29.3) はそのまま効く。

`AdapterContext` の移行は 2 段階:

1. `chain_ref?: ChainRef` を optional で追加 (既存 adapter は無視)。
2. 全 adapter が `chain_ref` を読むようになったら `chain` を削除。同時に `lib/adapters/registry.ts` の型と BFF `server.ts` の呼び出しを一括移行し、`pnpm -r typecheck` で漏れを検出する。

### 4.3 Wallet identity

```typescript
export interface LinkedAccount {
  chain: ChainRef;
  address: string;          // EVM は EIP-55 checksum で正規化
  verified: boolean;        // R0 は常に false (所有未検証)
  added_at: string;         // ISO 8601
}
// Wallet に追加 (optional、既存 consumer 無影響)
linked_accounts?: LinkedAccount[];
```

- R0: Settings drawer から EVM address を 1 件入力。端末ローカル (`stores/wallet.ts` + AsyncStorage) に保持し、BFF へは query param として渡す。**サーバーに紐付けを保存しない**。
- R2: WalletConnect session で `personal_sign` を取り `verified = true`。verified でない address からの action 生成は拒否 (`linked_account_unverified`)。
- 任意の公開 address を読めることは所有の証明ではない。UI に「読取専用・所有未検証」を常時表示する (SKR 設計 §4.2 と同じ立場)。

### 4.4 BFF 構成 (追加分)

```text
artifacts/seasonals-bff/src/
  clients/hyperliquid-info.ts     # POST https://api.hyperliquid.xyz/info (undici、weight 予算、60s cache)
  clients/hyperevm-rpc.ts         # viem publicClient (chain 999)、R1
  clients/pendle-api.ts           # markets/active + convert (R1 read、R2 write)
  clients/kinetiq-read.ts         # StakingManager.withdrawalRequests / withdrawalDelay、R1
  hyperliquid/state.ts            # info 応答 → nullable view + PositionSnapshot[]
lib/
  types/chain.ts
  types/cooldown-position.ts      # SKR 設計 §5 の型を chain 付きで共用 (未実装なら本案件で新設)
  config/hyperliquid.ts           # protocol_id / chain / decimals / validator 表示名 / feed id
  derive/derive-time-events.ts    # 変更なし (PositionSnapshot に流し込む)
```

`derive-time-events.ts` は変更しない。Hyperliquid の状態を `PositionSnapshot` (`unlock_at` / `maturity_at` / `health` / `forecast`) に正規化して既存の決定的導出に流す。これが「Solana も HyperCore も HyperEVM も同じ `UnifiedTimeEvent` に収束する」の実体で、新しい導出関数を作らない。

## 5. Protocol 別マッピング

| protocol_id | chain | 元データ | Position 側 | TimeEventCategory | actions (R2 以降) | 備考 |
|---|---|---|---|---|---|---|
| `hl_staking` (delegation) | hypercore | `delegations[].lockedUntilTimestamp` (ms) | `unlock_at` = その時刻 | `lockup_end` | `unstake` (= `tokenDelegate isUndelegate`) | validator ごとに 1 position |
| `hl_staking` (unstaking queue) | hypercore | `delegatorSummary.totalPendingWithdrawal` / `nPendingWithdrawals` + `delegatorHistory` の開始時刻 | `pending_amount`、`unlock_at` = 開始 + 7 日 (個別時刻が取れない場合 null) | `lockup_end` | なし (queue は自動で spot へ) | 上限 5 件。到達済みは Info |
| `hl_hlp` | hypercore | `userVaultEquities` (equity) + 最終 vault deposit 時刻 (`userNonFundingLedgerUpdates` または `vaultDetails`) | `unlock_at` = 最終 deposit + 4 日 | `lockup_end` | `withdraw` (= `vaultTransfer isDeposit:false`) | **追加 deposit が unlock を後ろへ動かす**。R2 の deposit simulate は「変更後の unlock_at」を warning で返す |
| `kinetiq` | evm 999 | `withdrawalRequests(user,id).timestamp` + `withdrawalDelay()` | `unlock_at` | `lockup_end` | `withdraw` (= `confirmWithdrawal`)、`unstake` (= `queueWithdrawal`) | cancel は docs に無いので出さない |
| `pendle` | evm 999 | markets/active の `expiry`、PT `balanceOf` | `maturity_at`、`maturity_redeem` (R2 のみ) | `maturity` | `withdraw` (redeem)、`rotate` (roll to next PT) | Exponent (8.33/8.34) と同型。R1 は候補表示、R2 で CTA |
| `hl_funding` (R3) | hypercore | `userFunding` / WS `userFundings`、`predictedFundings` | position なし (perp 建玉に付随) | `epoch` + `metadata.source = "hl_funding"`、**1 日 1 件に集約** | なし | 24 件/日を Calendar に出さない |
| `hl_twap` (R3) | hypercore | `userTwapHistory` / WS `twapStates` | position なし | `forecast_marker` (開始 / 完了予定)、`agentReadable=false` | `cancel` (= `twapCancel`) | 作成は L1 action → agent wallet 可 |
| `hl_portfolio_margin` (R3) | hypercore | WS `spotState(isPortfolioMargin)` | `health_factor` 相当 = `1 - portfolio_margin_ratio` | `health` + `forecast_marker` (-10% / -20% シナリオ) | `repay` / `add_collateral` | Kamino health (8.20) と同型 |
| `hyperlend` (R3) | evm 999 | `getUserAccountData()` health factor | `health_factor` | `health` | `repay` / `add_collateral` | Aave 系。R3 |

urgency は既存 `proximityUrgency` (≤1 日 critical / ≤7 日 watch) をそのまま使う。ただし **unstaking queue と HLP の unlock は「資金が安全な待機」なので到達後も critical にしない** (既存 lockup 分岐の `unlocked ? Watch : …` と同じ)。

## 6. HL-R0 最小実装

### 6.1 読取経路

```mermaid
flowchart LR
  Settings[Settings: EVM address 入力] --> Store[stores/wallet linked_accounts]
  Store --> Q[services/api.ts getHyperliquidState]
  Q --> BFF[GET /protocols/hyperliquid/state?address=0x..]
  BFF --> Info[api.hyperliquid.xyz/info x4-5 (cache 60s)]
  BFF --> View[CooldownPositionView[] + UnifiedTimeEventDTO[]]
  View --> UI[Your Positions 専用 row / Calendar]
```

**MUST / HL-R0-READ-01:** BFF は `delegatorSummary` / `delegations` / `delegatorHistory` / `userVaultEquities` / `userNonFundingLedgerUpdates` を 1 refresh で取得し、応答の型を zod で検証する。欠損・型不一致は `unsupported`、timeout は `unavailable`、HTTP 429 は `rate_limited` として区別し、**いずれも 0 や既定日で埋めない**。

**MUST / HL-R0-READ-02:** address は EIP-55 checksum 検証を BFF 入口で行い、不正なら 400 `invalid_address`。address は path でなく query に置き、ログには先頭 6 桁 + 末尾 4 桁だけ残す。

**MUST / HL-R0-RATE-01:** info は weight 20 × 5 = 100 / refresh。BFF は address 単位 60 秒 cache と in-flight coalescing を持ち、**IP 予算 1200/分 のうち Hyperliquid 用に 600 まで**を上限として超過時は cache を返す (`data_status = stale`)。Mobile の foreground poll は 5 分 (SKR 設計 §7.2 と同じ)。

**MUST / HL-R0-NUM-01:** info の小数 string は `toSmallestUnit(value, decimals)` で smallest unit string にする。decimals は `lib/config/hyperliquid.ts` に固定 (HYPE の HyperCore `weiDecimals` は `spotMeta` で実測して確定、§2.3)。`Number()` / `parseFloat` を通さない。ms timestamp は整数として扱い ISO 8601 に変換する。

### 6.2 API

新設は `GET /protocols/hyperliquid/state?address=0x…` の 1 本。§24.2 の envelope を使う。

```text
data:
  schema_version: 1
  chain: "hypercore:mainnet"
  data_status: fresh | stale | unavailable | unsupported | rate_limited
  observed_at, cache_age_seconds
  address: "0x…" (checksum)
  verified: false
  staking:
    delegations: CooldownPositionView[]     # validator ごと、unlock_at = lockedUntilTimestamp
    pending_withdrawals: CooldownPositionView[]   # unlock_at は個別時刻が取れた時のみ
    summary: { delegated, undelegated, total_pending_withdrawal, n_pending_withdrawals }  # smallest unit string
  hlp:
    position: CooldownPositionView | null   # unlock_at = last deposit + 4d
  events: UnifiedTimeEventDTO[]             # actions = [], agentReadable = false
```

**MUST / HL-R0-API-01:** query / cache key は `chain + address`。Solana wallet の切替や EVM address の変更後に古い応答を新しい表示へ描画しない (`useWalletQuerySync` の invalidation に `linked_accounts` を含める)。

既存 `/positions/earn` と MCP resource は **R0 では変更しない**。

### 6.3 型

SKR 設計 §5 の `CooldownPositionView` (nullable、`kind = "cooldown_position"`、`Position` へ代入不可) を **chain 付きで共用**する。追加フィールド:

| フィールド | 契約 |
|---|---|
| `chain: ChainRef` | 必須。`chainRefId` で event id にも埋め込む |
| `linked_address` | EVM checksum address。Solana wallet の `wallet_address` とは別 |
| `counterparty` | validator address / vault address。UI 表示名は `lib/config/hyperliquid.ts` の表で解決、無ければ短縮 address |
| `principal_amount` / `unit_price_usd` / `deposited_at` | R0 は null。**portfolio 合計に加えない** |

SKR 設計の consumer 隔離表 (`earn-to-position.ts` / `allocation.ts` / `portfolioTimeSeries.ts` / `deposited-breakdown.ts` / MCP) はそのまま適用し、テスト ID は `HL-R0-NULL-01..04` として複製する。

### 6.4 イベント ID と決定性

**MUST / HL-R0-EVENT-01:**

```text
lockup_end:hypercore:mainnet:hl_staking:<address>:delegation:<validator>
lockup_end:hypercore:mainnet:hl_staking:<address>:queue:<index_or_start_ms>
lockup_end:hypercore:mainnet:hl_hlp:<address>:<vault_address>
```

終了時刻を ID に含めない。HLP へ追加 deposit した場合は ID を維持し `triggerAt` と revision を置き換える。pending が 0 になったらイベントを除去する。同一 snapshot + `now` で導出 2 回の DTO は deep equal (HL-R0-EVENT-02)。

### 6.5 UI

- **Your Positions** に "Hyperliquid" セクション (chain badge `HL`)。行は「Delegated / Unstaking (queue) / HLP」の 3 種。金額は HYPE / USDC 建てのみ、USD は `—`。
- **Calendar** は既存 `lockup_end` droplet。EventCard の headline は `deriveTimeEvents` が作る (`"Hl_staking lockup ends"` になるので **`metadata.headline` を snapshot 側で上書き**: `"HYPE unstaking → Spot"` / `"HLP withdrawal unlocks"`)。
- **Settings drawer** に "Linked EVM address (read-only)" 入力。保存時に checksum 正規化。削除で関連 query を invalidate。
- **MUST / HL-R0-UI-01:** `DS.color.*` / `GlassCard` / Quicksand、hex 直書きなし。fixture と live を画面上で区別 (既存 `devFallbackLog` の表示を流用)。
- portfolio 合計・時系列・allocation には算入せず、「Hyperliquid は上部評価額の対象外」と 1 行表示 (HL-R0-NULL-03)。

### 6.6 停止

環境変数 `FEATURE_HYPERLIQUID_READ` (default off)。off なら route は 404、Mobile は Settings の入力欄ごと非表示。

## 7. HL-R1: HyperEVM 読取と PT デモ

### 7.1 追加する読取

| 対象 | 取得 | Snapshot への写像 |
|---|---|---|
| Pendle active markets (chain 999) | `GET /core/v1/999/markets/active` (60 分 cache) | menu の `display_only` PT 一覧 (Exponent 8.33 と同じ表示) |
| PT 残高 | viem `balanceOf(address)` を各 PT に対して multicall | `maturity_at = expiry`、`maturity_redeem` は **付けない** (CTA なし = fail-closed) |
| Kinetiq queue | `withdrawalRequests(address, id)` を id 0..N で読む (N は `withdrawalDelay` と共に 1 日 cache)。`kHYPEAmount == 0` は空 slot | `unlock_at = timestamp + withdrawalDelay` |
| kHYPE 残高 | ERC-20 `balanceOf` | 表示のみ (staking position、unlock なし) |

**MUST / HL-R1-EVM-01:** `viem` は **BFF のみ**に追加する。Mobile / lib に EVM 依存を入れない。RPC は `HYPEREVM_RPC_URL` (default 公式 RPC)、失敗は `unavailable`。

**MUST / HL-R1-PT-01:** PT の `maturity` イベントは `actions = []` で emit する。`metadata.next_candidates` に roll 先候補 (同 underlying の後続 market: kHYPE 2027-03-25) を **表示用**として載せる。ActionModal / AgentPlan には流れない。

### 7.2 デモシナリオ (DEMO-HL-01)

本日 2026-09-19、PT-kHYPE は 2026-09-24 満期。5 日以内に HL-R1 が通らない場合は、**実 market データを fixture に写した demo address** で同じ画面を出す。fixture である旨を画面に表示し、live 署名や資金移動と説明しない。

```text
SEP 24  ◆ PT-kHYPE matures (Pendle · HyperEVM)
        Estimated redemption: 100 PT → 100 kHYPE   (表示のみ)
        Next: PT-kHYPE 25 Mar 2027 / kHYPE hold      (表示のみ)

SEP 27  ◇ HYPE unstaking → Spot (Hyperliquid)        250 HYPE
SEP 23  ◇ HLP withdrawal unlocks                     1,000 USDC
SEP 28  ◇ kHYPE withdrawal ready (Kinetiq)           100 HYPE
```

訴求は「Solana と Hyperliquid の予定を同じ Calendar で読む」。**"Redeem → Roll → Done" は R2 まで訴求しない。**

## 8. HL-R2: 実行

### 8.1 着手条件 (全て MUST)

1. **EVM 署名経路の実機成立**: Reown AppKit (WalletConnect) RN が Seeker 上で外部 EVM wallet (MetaMask / Rabby 等) と session を張り、`eth_signTypedData_v4` と `eth_sendTransaction` を往復できること (HL-R2-SIGN-01)。成立しなければ R2 全体を DEFER。
2. **spec §6.5 改定**: 「署名は MWA」を「署名は利用者の wallet (Solana: MWA、EVM: WalletConnect)。Seasonals は鍵を持たない」に更新し §32.2 対応表を改訂。
3. **Oracle**: HYPE の Switchboard feed 確認 (ORA-02)。未確認なら HYPE 建て action は `oracle_unavailable` で拒否のまま。USDC 建て (HLP deposit / withdraw) は既存 USDC feed で通せる。
4. **FND-01 / FND-04** (SKR 設計 §8): 認証と承認束縛の永続化。

### 8.2 action 行列

| UI | ActionType | protocol | payload | 署名 | 備考 |
|---|---|---|---|---|---|
| Undelegate | `unstake` | hl_staking | `tokenDelegate {isUndelegate:true, wei}` | user-signed | lock 中は simulate で拒否 (`locked_until`) |
| Delegate | `deposit` | hl_staking | `tokenDelegate {isUndelegate:false}` | user-signed | 1 日 lock を warning で提示 |
| Staking → Spot | `withdraw` | hl_staking | `cWithdraw {wei}` | user-signed | **simulate 結果に「7 日後の到着日時」と「pending 件数 (最大 5)」を必ず含める** |
| Spot → Staking | `deposit` | hl_staking | `cDeposit {wei}` | user-signed | |
| HLP withdraw | `withdraw` | hl_hlp | `vaultTransfer {isDeposit:false, usd}` | L1 | unlock 前は拒否 |
| HLP deposit | `deposit` | hl_hlp | `vaultTransfer {isDeposit:true, usd}` | L1 | **warning `unlock_shift`: 「withdraw 可能日が X → Y に動く」** を `WarningArea` 経由で表示 |
| Kinetiq queue | `unstake` | kinetiq | evm_tx `queueWithdrawal(kHYPE)` | evm tx | 8–9 日待機を提示 |
| Kinetiq confirm | `withdraw` | kinetiq | evm_tx `confirmWithdrawal(id)` | evm tx | `timestamp + delay <= block.timestamp` を simulate で確認 |
| PT redeem | `withdraw` | pendle | Convert API `tokensIn=[PT]` → evm_tx | evm tx | 満期後のみ。8.34 の `maturity_redeem` と同型 |
| PT roll | `rotate` | pendle | Convert API `tokensIn=[PT_src] tokensOut=[PT_dst]` → evm_tx | evm tx | `to_protocol = "pendle"`、metadata に dst market。slippage は既存 `slippage_bps` |

### 8.3 維持する MUST

- **HL-R2-EXEC-01:** 同一 plan で simulate → approval → 署名 → broadcast → confirmed。HyperCore は `/exchange` 応答の `status: "ok"` だけで成功にせず、info の再取得で状態変化を確認する。
- **HL-R2-EXEC-02:** `bundle_hash` は typed data / tx の canonical bytes から算出。approval 後に `nonce` だけを差し替える再構築は禁止 (nonce も hash に含める。期限切れは再 simulate)。
- **HL-R2-EXEC-03:** user-signed action の `signatureChainId` と `hyperliquidChain` は registry 固定値。wallet 側が別 chain で署名した場合は BFF が recover した署名者 address と `linked_address` を照合し不一致で拒否。
- **HL-R2-EXEC-04:** HLP deposit は simulate 結果に `unlock_at_after` を含め、`WarningArea` が「引き出し可能日が後ろへ動く」を表示し 1 秒グレーアウトを経てから承認できる。
- **HL-R2-EXEC-05:** policy (§11.6) は USD 建てで評価する。HYPE 建て action で fresh な両 oracle が無ければ `oracle_unavailable`。`max_lock_days` は unstaking queue 7 日 / Kinetiq 8–9 日 / HLP 4 日を lock として評価する。
- **HL-R2-EXEC-06:** Mobile / lib に EVM 秘密鍵・mnemonic・agent key を置かない。WalletConnect の session key は署名鍵ではない (secret grep 0 件を維持)。

## 9. HL-R3: 時間軸の拡張 (DEFER)

| 項目 | 着手条件 | 設計メモ |
|---|---|---|
| funding 日次集約 | FND-03 (WS 購読と repair poll) | 1 日 1 件の `epoch` イベント。`metadata`: `paid_so_far` / `next_at` / `est_next` / `projected_24h` (USD 8 decimals string)。24 件を個別に出さない |
| TWAP window | HL-R2 | `forecast_marker` ×2 (開始 / 完了予定 = 開始 + `m` 分)。進捗は `userTwapSliceFills` から。`agentReadable=false` |
| TWAP 作成 | HL-R2 + ActionType 方針決定 | 12 種に無い。`rotate` の `metadata.kind="twap"` で表すか、spec 改定で 13 種目にするかは**製品判断**。本書では決めない |
| agent wallet (approveAgent) | 監査 + feature flag + mainnet 方針 | BFF が agent 鍵を持つ = Phase 8.29 と同型。**withdraw 不可**という Hyperliquid 側の bounded 構造は利点だが、取引損失は bounded でない。`AUTONOMOUS_*` のハード上限を USD で流用 |
| portfolio margin / HyperLend health | HL-R1 (read) | Kamino health 分岐の `health: {ltv, liquidation_ltv}` に写像。`forecast_marker` は -10% / -20% シナリオ (§14.4 点線) |
| Boros | Boros API 実測 | hourly settlement は funding と同じ集約規則。maturity は `maturity` |

## 10. データ契約と落とし穴

| 項目 | 規則 |
|---|---|
| decimals | **同じ HYPE でも HyperCore (`weiDecimals`、期待 8) と HyperEVM (18) で桁が違う。** `lib/config/hyperliquid.ts` に chain ごとの decimals を持ち、`CooldownPositionView.decimals` は chain 側の値を使う。cross-chain 比較は human readable を経由せず、両方を USD 8 decimals に正規化してから行う |
| info の数値 | 小数 string → `toSmallestUnit`。`wei` 整数 → `assertTokenAmount` → `toBigInt` |
| timestamp | info は ms epoch (整数)。`lockedUntilTimestamp` は ms。ISO へは `new Date(ms).toISOString()`。Kinetiq / EVM は秒 |
| 7 日 queue | 公式例は「7 日 + 1 秒」。`unlock_at = start + 7d`、UI は「以降」と表示し到達判定は info の再取得で行う (端末時計で ready にしない、SKR 設計 R0-STATE-01) |
| HLP の unlock | `vaultDetails` が follower 別 `lockedUntilTimestamp` を返すならそれを正、返さなければ ledger の最終 `vaultDeposit` + 4 日。両方取れなければ `unlock_at = null` (0 や 4 日後で埋めない) |
| rate limit | address 単位 60 秒 cache、`Retry-After` 尊重、429 は `rate_limited` として UI に「更新待ち」 |
| ID | event id / position id は `chainRefId` を含める。同じ 0x address が別 chain (HyperEVM) にもあるため address だけで一意にしない |
| ログ | address は部分マスク。info 応答の raw は `raw_state` に保持するが `delegatorHistory` 全件は保持しない (直近 50 件) |

## 11. Claude Code への実装引継ぎ

### HL-R0 作業順

| 順序 | ファイル / 作業 | 合格 ID |
|---|---|---|
| 0 | `spotMeta` / `delegatorSummary` / `delegations` / `delegatorHistory` / `userVaultEquities` / `userNonFundingLedgerUpdates` / `vaultDetails` を実 address (公開・少額) で叩き **fixture 化**。decimals と HLP 時刻の取得元を確定 (§2.3) | HL-R0-READ-01 |
| 1 | `lib/types/chain.ts`、`lib/types/cooldown-position.ts` (SKR 設計 §5 の型 + `chain` / `linked_address` / `counterparty`)、`lib/types/index.ts` | HL-R0-NULL-01 |
| 2 | `lib/config/hyperliquid.ts` (protocol_id / chain / decimals / feed id / validator 表示名)、BFF `clients/hyperliquid-info.ts` (undici、zod、cache、weight 予算) | HL-R0-READ-01/02、HL-R0-RATE-01、HL-R0-NUM-01 |
| 3 | BFF `hyperliquid/state.ts` (応答 → view + `PositionSnapshot[]` → 既存 `deriveTimeEvents`)、`GET /protocols/hyperliquid/state` (feature flag) | HL-R0-EVENT-01/02、HL-R0-API-01 |
| 4 | Mobile `stores/wallet.ts` に `linked_accounts`、`SettingsDrawer` の入力欄、`services/api.ts` / `queries.ts`、`useWalletQuerySync` の invalidation | HL-R0-API-01、HL-R0-UI-01 |
| 5 | `MenuDrawer` の Hyperliquid セクション (専用 renderer、`vault-rows.ts` を通さない)、Calendar headline 上書き、portfolio 除外ラベル | HL-R0-NULL-02/03 |
| 6 | MCP 非混入テスト、fixture / live 表示の区別、Seeker で JS reload + logcat | HL-R0-NULL-04、HL-R0-SCOPE-01 |

見積り: **HL-R0 は 4–6 人日**、**HL-R1 は 4–6 人日** (viem 導入 + Pendle / Kinetiq read + デモ fixture)。HL-R2 は署名経路の実機検証が前提で、**10 人日 + wallet 検証**を別枠にする。SKR 設計と同じく FND 案件の工数をここに隠さない。

### HL-R1 作業順

| 順序 | ファイル / 作業 | 合格 ID |
|---|---|---|
| 1 | BFF `viem` 追加 (pnpm override との干渉を `pnpm -r typecheck` と `verify:tx` で確認)、`clients/hyperevm-rpc.ts` | HL-R1-EVM-01 |
| 2 | `clients/pendle-api.ts` (markets/active、60 分 cache)、menu `display_only` PT 一覧 (8.33 と同型) | HL-R1-PT-01 |
| 3 | PT `balanceOf` multicall → `maturity_at` snapshot (`maturity_redeem` なし)、`metadata.next_candidates` | HL-R1-PT-01 |
| 4 | `clients/kinetiq-read.ts` (`withdrawalRequests` / `withdrawalDelay`) → `unlock_at` snapshot | HL-R1-KQ-01 |
| 5 | demo address fixture (実 market データ)、画面上の fixture 表示、Seeker 確認 | DEMO-HL-01 |

## 12. 受け入れ条件

### HL-R0

| テスト ID | 入力 / 操作 | 期待結果 (MUST) |
|---|---|---|
| HL-R0-READ-01 | 正常応答、型不一致、timeout、429 | 正常のみ fresh。不一致は unsupported、timeout は unavailable、429 は rate_limited。fake 量 / 日付なし |
| HL-R0-READ-02 | 小文字 / 不正 checksum / 長さ違いの address | 小文字は checksum 正規化して受理、不正は 400 `invalid_address`。ログに完全 address なし |
| HL-R0-RATE-01 | 同一 address を 10 秒間に 5 回要求 | info 呼出しは 1 refresh 分 (5 request) のみ。以降は cache。予算超過で `data_status = stale` |
| HL-R0-NUM-01 | `"12.34567891"` HYPE、`weiDecimals` 8、u64 上限付近 | smallest unit string が桁落ちなく一致。`Number` / `parseFloat` の呼出し 0 件 (lint) |
| HL-R0-API-01 | address A 要求後に B へ変更、A の遅延応答 | B 画面に A 由来の position / event ID が 0 件 |
| HL-R0-STATE-01 | delegation lock 到達前 / 同時 / 後、queue 個別時刻なし | lock 到達は info 再取得でのみ判定。個別時刻なしは `unlock_at = null` で金額のみ表示 |
| HL-R0-EVENT-01 | HLP に追加 deposit (unlock が後ろへ) | event ID 不変、`triggerAt` と revision 変更。pending 0 で 0 件 |
| HL-R0-EVENT-02 | 同 snapshot / now で導出 2 回 | DTO deep equality。既存 Solana lockup event と ID 重複 0 件 |
| HL-R0-NULL-01 | null の principal / price / deposited_at | `Position` への代入は compile error。API は null を保持 |
| HL-R0-NULL-02 | Hyperliquid 専用 row | USD / ROI / 入金日は `—`。`vault-rows.ts` の一般式を呼ばない |
| HL-R0-NULL-03 | 既存 portfolio P に Hyperliquid row を追加 | 合計・時系列・allocation の入出力が P と同一。対象外ラベルあり |
| HL-R0-NULL-04 | Hyperliquid 読取成功時の MCP positions / events | 当該 ID は 0 件。イベントの `agentReadable = false` |
| HL-R0-UI-01 | Hyperliquid セクション / EventCard | hex 直書き 0 件、Pacifico 不使用、fixture と live の表示区別 |
| HL-R0-SCOPE-01 | feature flag ON で全画面 | 署名 CTA / AgentPlan 生成 / DB mutation / push 登録が 0 件。flag OFF で route 404 + 入力欄非表示 |

### HL-R1 / R2 / デモ

| テスト ID | 適用 | 機械判定 |
|---|---|---|
| HL-R1-EVM-01 | R1 | `viem` の import が BFF 以外に 0 件。RPC 失敗は unavailable、fake 残高なし |
| HL-R1-PT-01 | R1 | PT maturity event の `actions = []`。`metadata.next_candidates` は同 underlying の後続 market のみ |
| HL-R1-KQ-01 | R1 | `unlock_at = timestamp + withdrawalDelay`。空 slot は position 化しない。cancel CTA 0 件 |
| DEMO-HL-01 | R1 | Solana 予定と Hyperliquid 予定が同一 Calendar に描画。fixture 表示あり。署名 / 送金の成功表示 0 件 |
| HL-R2-SIGN-01 | R2 | Seeker 上で WalletConnect session → `eth_signTypedData_v4` → recover した address が `linked_address` と一致。不一致は broadcast 0 件 |
| HL-R2-EXEC-01..06 | R2 | §8.3 の各 MUST に対応する正常 / 拒否 fixture。reject で `/exchange` / RPC 送信 0 件 |
| HL-R2-ORA-01 | R2 | HYPE 建てで Switchboard 未設定 → simulate warning / execute 拒否。USDC 建て HLP は既存 gate で通過 |
| HL-R2-HLP-01 | R2 | HLP deposit simulate に `unlock_at_after` が含まれ、`WarningArea` 経由で表示、1 秒グレーアウト後に承認可 |

R0 合格は HL-R0-* 全件。R1 合格は HL-R1-* + DEMO-HL-01 + R0 回帰。機能実装時は `pnpm -r test` / `pnpm -r typecheck` (§8.1) と、BFF 依存追加時は `pnpm --filter @seasonals/bff verify:tx` を通す。

## 13. 停止条件と訴求ガード

- **停止:** `FEATURE_HYPERLIQUID_READ` (R0/R1)、`FEATURE_HYPERLIQUID_EXEC` (R2、action 別 sub-flag)。R2 停止後も未確定 tx の状態照会は続ける。
- **訴求してよい (R0/R1):** 「Solana と Hyperliquid の資金がいつ動かせるかを 1 つの Calendar で読む」「PT の満期を Seasonals が先に知っている」。
- **訴求しない (R2 まで):** "One tap" / "No new tab" / "Redeem → Roll → Done" / 「Hyperliquid を Seasonals から操作」。
- **訴求しない (常時):** 「agent が unstake を自動実行」 (仕様上不可能、§3.2)。
- **PROD-HL-01 (SHOULD):** 3–5 人の Hyperliquid 利用者に「Solana の予定と並べて見たいか」「HLP 追加 deposit で unlock が動くことを読み取れるか」を観察。横断利用の希望が弱ければ R2 の署名経路投資を止める。

## 14. 未決事項 (製品判断が必要)

| # | 論点 | 選択肢 | 本書の仮置き |
|---|---|---|---|
| 1 | EVM address の入力 UX | 手入力 / QR / WalletConnect で取得 | R0 は手入力 (最小)。R2 で WalletConnect 取得に統一 |
| 2 | TWAP 作成の ActionType | `rotate` + metadata / 13 種目を spec 追加 | 決めない (R3) |
| 3 | Hyperliquid の trust level | Tier S / A | native staking / HLP は A、Pendle / Kinetiq は A、HyperLend は B。registry admin 判断 |
| 4 | portfolio 合計への算入時期 | R0 から Pyth 価格で算入 / R1 まで除外 | R1 まで除外。Pyth HYPE feed 登録後に算入 |
| 5 | MCP 公開時期 | R1 (read-only) / R2 | R1 で `schema_version` 固定後に `agentReadable = true`、actions は空 |
| 6 | Phase 番号 | 9.0 系として §21 に追加 | HL-R0 = Phase 9.0、HL-R1 = 9.1、HL-R2 = 9.2 を仮置き。`docs/backlog.md` §E に経緯を移す |

本書は設計文書であり、Hyperliquid の実装、EVM 署名経路の実機成立、Switchboard feed の存在、Pendle / Kinetiq の本番適合性を完了したという記述は含めない。
