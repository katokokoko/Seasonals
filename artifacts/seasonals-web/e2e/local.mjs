/**
 * e2e/local.mjs — BFF + vite を空き port で自前に立てて e2e/run.mjs を回し、終わったら止める。
 *   pnpm e2e:local (cwd = artifacts/seasonals-web)。他 session の 3030 / 5173 には触らない。
 *   BFF は artifacts/seasonals-bff を cwd に起動するので .env (Helius key 等) と .data/ はそこのものを使う。
 *   server の log は e2e/.out/bff.log / vite.log (gitignore)。stdout には run.mjs の JSON だけが出る。
 *   exit code は run.mjs のもの (0 全 pass / 1 check 失敗 / 2 環境)、Ctrl-C は 130。
 *   tsx / vite は node-linker=hoisted なので repo root の node_modules/.bin から直接起動する (pnpm を挟まない)。
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(e2eDir, "..");
const root = join(e2eDir, "../../..");
const bffDir = join(root, "artifacts/seasonals-bff");
const bin = join(root, "node_modules/.bin");
const outDir = join(e2eDir, ".out");
const bffLog = join(outDir, "bff.log");
const viteLog = join(outDir, "vite.log");

for (const tool of ["tsx", "vite"]) {
  if (!existsSync(join(bin, tool))) {
    console.error(`e2e:local: ${join(bin, tool)} が無い。repo root で pnpm install を先に`);
    process.exit(2);
  }
}

/** OS に空き port を選ばせる (listen(0) → port を読んで閉じる) */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** detached で起動 (自前の process group を持たせ、tsx とその子 node をまとめて止められるように) */
function spawnServer(label, cmd, args, { cwd, env, logFd }) {
  const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", logFd, logFd], detached: true });
  proc.label = label;
  proc.exited = new Promise((resolve) => {
    proc.once("exit", (code, signal) => resolve(code ?? signal));
    proc.once("error", (err) => resolve(err.message));
  });
  return proc;
}

/** url が 2xx を返すまで 500 ms 毎に poll。先に process が死ぬか期限切れなら log の場所付きで throw */
async function waitFor(url, { label, timeoutMs, exited, log }) {
  let dead = null;
  exited.then((code) => (dead = { code }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (dead) throw new Error(`${label} exited early (code ${dead.code}); see ${log}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return res;
    } catch {
      // まだ listen していない
    }
    if (Date.now() > deadline) throw new Error(`${label} did not answer ${url} within ${timeoutMs / 1000} s; see ${log}`);
    await Promise.race([new Promise((r) => setTimeout(r, 500)), exited]);
  }
}

/** process group ごと SIGTERM → 3 秒待って残っていれば SIGKILL */
async function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
    const done = await Promise.race([proc.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 3_000))]);
    if (!done) process.kill(-proc.pid, "SIGKILL");
  } catch {
    // 既に居ない
  }
}

mkdirSync(outDir, { recursive: true });
const fds = [];
let bff = null;
let vite = null;
let run = null;
let interrupted = false;
// 2 回目以降の呼び出しも同じ promise を待つ (signal と main の finally が競っても server を止め切ってから exit する)
let cleaning = null;
function cleanup() {
  cleaning ??= (async () => {
    console.error("e2e:local: stopping servers…");
    await killTree(vite);
    await killTree(bff);
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        // 閉じ済み
      }
    }
  })();
  return cleaning;
}

// spawn より前に登録する (起動途中の Ctrl-C でも server を残さない)
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    interrupted = true;
    // terminal の Ctrl-C は group 全体に届くが、kill -INT <pid> の時は run.mjs に転送する
    if (run && run.exitCode === null && run.signalCode === null) run.kill(sig);
    await cleanup();
    process.exit(130);
  });
}
const crash = async (err) => {
  console.error(`e2e:local: ${err?.stack ?? err}\n  logs: ${bffLog} ${viteLog}`);
  await cleanup();
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

let code = 1;
try {
  const p1 = await freePort();
  let p2 = await freePort();
  while (p2 === p1) p2 = await freePort();

  const bffFd = openSync(bffLog, "w");
  fds.push(bffFd);
  bff = spawnServer("BFF", join(bin, "tsx"), ["src/index.ts"], {
    cwd: bffDir,
    env: { PORT: String(p1), HOST: "127.0.0.1" },
    logFd: bffFd,
  });
  const health = await (await waitFor(`http://127.0.0.1:${p1}/health`, { label: "BFF", timeoutMs: 60_000, exited: bff.exited, log: bffLog })).json();
  console.error(`e2e:local: bff: http://127.0.0.1:${p1} (heliusConfigured=${health.solana?.heliusConfigured})`);

  const viteFd = openSync(viteLog, "w");
  fds.push(viteFd);
  vite = spawnServer("vite", join(bin, "vite"), ["--port", String(p2), "--strictPort", "--host", "127.0.0.1"], {
    cwd: webDir,
    env: { BFF_URL: `http://127.0.0.1:${p1}` },
    logFd: viteFd,
  });
  await waitFor(`http://127.0.0.1:${p2}/`, { label: "vite", timeoutMs: 30_000, exited: vite.exited, log: viteLog });
  console.error(`e2e:local: vite: http://127.0.0.1:${p2}`);

  // detached にしない (Ctrl-C を run.mjs にも届ける)。cwd = webDir で .screenshots/ は今まで通りの場所
  run = spawn(process.execPath, [join(e2eDir, "run.mjs")], {
    cwd: webDir,
    stdio: "inherit",
    env: { ...process.env, WEB_URL: `http://127.0.0.1:${p2}` },
  });
  code = await new Promise((resolve) => {
    run.once("exit", (c) => resolve(c ?? 1));
    run.once("error", () => resolve(1));
  });
  if (code !== 0 && !interrupted) console.error(`e2e:local: run.mjs exited ${code}; server logs: ${bffLog} ${viteLog}`);
} catch (err) {
  console.error(`e2e:local: ${err.message}\n  logs: ${bffLog} ${viteLog}`);
  code = 2;
} finally {
  await cleanup();
}
process.exit(interrupted ? 130 : code);
