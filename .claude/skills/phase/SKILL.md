---
name: phase
description: Seasonals の §21 phase / multi-file タスクを実装し、完了ゲート (全 workspace の jest + typecheck) を必ず走らせてから完了報告する。"run a phase", "phase を実装", "次の phase", "Phase X.Y をやって", "implement phase" 等で起動。
---

# /phase — Phase 実装 + 完了ゲート

引数で指定された phase またはタスクを実装し、CLAUDE.md §8.1 の **完了ゲート**を自動で担保する skill。
「toolchain を実際に走らせる前に done と言わない」を仕組みで保証する。

## 手順

1. **実装** — CLAUDE.md §11 チェックリストに従う:
   - 型は `@workspace/lib/types` から import (mobile 内ローカル定義しない)
   - 金融値は `@workspace/lib/utils/numeric` の helper 経由 (`Number()`/`parseInt` 禁止)
   - enum はリテラルでなく `lib/types/enums.ts` から
   - 色は `DS.color.*` token (hex 直書き禁止)、Pacifico は logo 専用
   - API 通信は `services/api.ts` 経由、server state は TanStack Query
   - 秘密鍵を扱う API を新設しない

2. **完了ゲート (green まで done としない)** — 変更した workspace を判定して走らせる:
   - `lib/` を触ったら 3 workspace に波及 → `pnpm -r test` と `pnpm -r typecheck`
   - 単一 workspace のみなら該当 workspace の `pnpm test` / `pnpm typecheck`
   - 失敗したらログを提示して修正し、**再実行**。pass するまで繰り返す。

3. **新規 TS エラーの扱い** — ts-guard baseline (`.claude/ts-baseline/*.txt`) に無い新規エラーは修正する。pre-existing (mobile 7 / lib 1) は §8.3 の既知パターンなので触らない。

4. **実機確認** — UI / MWA / tx に関わる変更は Seeker onchain APK で JS reload → logcat エラーなしまで確認 (§5)。署名フローは手動介入が要るので半自動 (screenshot + logcat) で見る。

5. **整合性チェック** — pitch claim に関わる変更は CLAUDE.md §9 / §32.2 の該当行を self-check。

## 完了報告フォーマット

token 上限対策として**全文貼り付けはしない**。以下を簡潔に:

- 変更ファイルの 1 行サマリー (file ごとに何を変えたか)
- test 結果 (workspace 毎の pass 数。例: `150 mobile / 67 lib / 22 BFF 全 pass`)
- 新規 typecheck エラーの有無
- 実機確認の要否と結果
