/**
 * BFF entry — `pnpm dev` で起動。
 *
 * 環境変数:
 *   PORT (default 3000)
 *   HOST (default 0.0.0.0、Android emulator から 10.0.2.2 で繋ぐため bind は any)
 *   HELIUS_API_KEY (Phase 8.1、optional — 未設定なら /positions?wallet= が 500)
 *
 * `.env` は dotenv で auto-load。Node 20 の native `--env-file` が使えるように
 * なったら dotenv 依存を外して `tsx --env-file=.env` に切替可。
 */

import "dotenv/config";

import { buildAutonomousDeps, buildServer } from "./server";
import { startAutonomousLoop } from "./autonomous";
import { isObjective } from "@workspace/lib/types";

// 3000 は Next.js dev server の慣例 port なので 3030 を default に。
// env var で override 可能 (CI / staging / production で別 port にする場合)。
const PORT = Number(process.env.PORT ?? 3030);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = await buildServer({ logger: true });
  try {
    await app.listen({ port: PORT, host: HOST });
    // eslint-disable-next-line no-console
    console.log(`Seasonals BFF listening on http://${HOST}:${PORT}`);

    // Phase 8.29: 自律 scheduler は opt-in (AUTONOMOUS_LOOP_MS)。buildServer 外
    // で起動するため test は timer を生まない。flag/devnet/kill は各 cycle が判定。
    const loopMs = Number(process.env.AUTONOMOUS_LOOP_MS ?? 0);
    if (loopMs > 0) {
      const objective = isObjective(process.env.AUTONOMOUS_OBJECTIVE)
        ? process.env.AUTONOMOUS_OBJECTIVE
        : "safety_first";
      startAutonomousLoop(buildAutonomousDeps(app), loopMs, {
        objective,
        asset: process.env.AUTONOMOUS_ASSET,
      });
      // eslint-disable-next-line no-console
      console.log(`Autonomous loop enabled (${loopMs}ms, ${objective})`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start BFF:", err);
    process.exit(1);
  }
}

main();
