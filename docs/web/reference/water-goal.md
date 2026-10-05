# Water background tuning loop (/goal)

Plan: `~/.claude/plans/lexical-crunching-shell.md`。参照写真 (`water-ref.png`、local-only) は **浅い海を真上から撮ったもの**。
レンズ状の膨らみや blob ではない (2026-10-05 ユーザー訂正)。水面の shader (`renderB`) そのものを寄せる。
実装は Opus、採点は毎回 fresh な Opus subagent (`water-judge.md` の固定文面)。

## 1 iteration

1. 採点の `top_fix` と `water-stats.json` から仮説を 1 文。変更は最大 2 点 (`water.frag.glsl` の定数 / 式、`waterDefaults.ts`)。
   iteration 1 だけは構造変更 (砂 / 光の保存 / 集光の線 / 水面の筋 / 星 / 泡) をまとめて入れてよい
2. `background.test.ts` の sha256 と `docs/web/water-background-spec.md` の shader 全文を同期 → `pnpm typecheck && pnpm test`
3. `node e2e/water-shots.mjs` (dev server :5173)。gate が落ちたら採点せずに直す
4. `water-judge.md` の文面のまま fresh な Opus subagent (Read のみ) で採点
5. `water-tuning-log.md` に追記、`water iter N: …` で commit (一時 index で自分のファイルだけ。作業ツリーは別セッションと共有)

## gate (`water-shots.mjs`、基準は iteration 0 の `water-baseline.json`)

- legibility: portal card の title / desc、top bar の link の背景と文字色のコントラスト比が各 ≥ min(4.5, 基準 − 0.05)
- calmWork: `/calendar?view=month` と `/menu` の水面の輝度 σ ≤ 基準 × 1.25
- stillIdentical (reduced motion)、moves、perf (syncDraw ≤ 基準 × 1.4、raf ≤ 17.5 ms)、noPageErrors

## 制約

- GLSL ES 1.00、texture と微分なし (spec の移植規則)。動きはどれも 15 秒未満で 1 周しない
- `renderB` の呼び出し回数を増やさない。droplet card / glass は水の窓なのでそのまま追従させる

## 完了条件

- 採点で全軸 4 以上を 2 回連続 (2 回目は同じ commit で撮り直し)
- `water-shots.mjs` の gate が全部 true
- web の `pnpm typecheck` / `pnpm test` exit 0、最終 commit で `node e2e/run.mjs` 全 pass
- iteration は最大 10 回 (iteration 1 を含む)。未達なら最低軸の点が一番高い commit に戻して報告
