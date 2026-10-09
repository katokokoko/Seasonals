/**
 * BFF entry — `pnpm dev` で起動。
 *
 * 環境変数:
 *   PORT (default 3000)
 *   HOST (default 0.0.0.0、Android emulator から 10.0.2.2 で繋ぐため bind は any)
 *   HELIUS_API_KEY (Phase 8.1、optional — 未設定なら /positions?wallet= が 500)
 *   公開 BFF 用 (SOLANA_EXECUTION_TARGET / RATE_LIMIT_MAX / ADMIN_TOKEN 等) は src/flags.ts
 *
 * `.env` は dotenv で auto-load。Node 20 の native `--env-file` が使えるように
 * なったら dotenv 依存を外して `tsx --env-file=.env` に切替可。
 */

import "dotenv/config";
import { assertProductionEnvSafe, gitSha, solanaExecutionTarget } from "./flags";

// 公開 BFF (NODE_ENV=production) で秘密鍵経路の env が残っていたら起動しない
// (docs/external-release-api-handling.md §1.3)。message は変数名のみ (値は出さない)。
try {
  assertProductionEnvSafe(process.env);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error((err as Error).message);
  process.exit(1);
}

import { buildAutonomousDeps, buildServer } from "./server";
import { startAutonomousLoop, loadPersistedRecords } from "./autonomous";
import { loadPersistedPolicy } from "./policy-store";
import { ensureWritableDataDir } from "./persistence";
import { isObjective } from "@workspace/lib/types";

// 3000 は Next.js dev server の慣例 port なので 3030 を default に。
// env var で override 可能 (CI / staging / production で別 port にする場合)。
const PORT = Number(process.env.PORT ?? 3030);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  // Phase 8.30: 最小永続化 — 既定で .data/ に policy override + 監査ログを保存
  // (再起動後も残す)。SEASONALS_DATA_DIR で場所を上書き可。テストは main() を
  // 通らず SEASONALS_DATA_DIR も設定しないので、disk に触れず hermetic なまま。
  if (!process.env.SEASONALS_DATA_DIR) process.env.SEASONALS_DATA_DIR = ".data";
  // saveJson は失敗を握りつぶすので、書けない data dir (volume の mount 漏れ等) は
  // 起動時に検出する。production は plan / 承認 token が黙って消えるので起動しない
  const dataDir = process.env.SEASONALS_DATA_DIR;
  if (!ensureWritableDataDir(dataDir)) {
    const msg = `[persistence] SEASONALS_DATA_DIR (${dataDir}) is not writable`;
    if (process.env.NODE_ENV === "production") {
      // eslint-disable-next-line no-console
      console.error(`${msg} — refusing to start in production`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.warn(`${msg} — state will not survive a restart`);
  }
  loadPersistedPolicy();
  loadPersistedRecords();

  const app = await buildServer({ logger: true });
  try {
    await app.listen({ port: PORT, host: HOST });
    const executionTarget = solanaExecutionTarget();
    // eslint-disable-next-line no-console
    console.log(
      `Seasonals BFF listening on http://${HOST}:${PORT} ` +
        `(executionTarget=${executionTarget}, version=${gitSha() ?? "dev"})`
    );

    // Phase 8.29: 自律 scheduler は opt-in (AUTONOMOUS_LOOP_MS)。buildServer 外
    // で起動するため test は timer を生まない。flag/devnet/kill は各 cycle が判定。
    // plans-only サーバ (SOLANA_EXECUTION_TARGET=disabled) では起動しない。
    const loopMs = Number(process.env.AUTONOMOUS_LOOP_MS ?? 0);
    if (loopMs > 0 && executionTarget === "disabled") {
      // eslint-disable-next-line no-console
      console.log("Autonomous loop not started: SOLANA_EXECUTION_TARGET=disabled");
    } else if (loopMs > 0) {
      const objective = isObjective(process.env.AUTONOMOUS_OBJECTIVE)
        ? process.env.AUTONOMOUS_OBJECTIVE
        : "safety_first";
      // dry_run 既定は安全側 (fail-closed)。実 broadcast は
      // AUTONOMOUS_LOOP_DRY_RUN=false を明示した時のみ opt-in。
      const loopDryRun = process.env.AUTONOMOUS_LOOP_DRY_RUN !== "false";
      startAutonomousLoop(buildAutonomousDeps(app), loopMs, {
        objective,
        asset: process.env.AUTONOMOUS_ASSET,
        dry_run: loopDryRun,
      });
      // eslint-disable-next-line no-console
      console.log(
        `Autonomous loop enabled (${loopMs}ms, ${objective}, dry_run=${loopDryRun})`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start BFF:", err);
    process.exit(1);
  }
}

main();
