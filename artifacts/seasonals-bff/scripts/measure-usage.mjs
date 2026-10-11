#!/usr/bin/env node
/**
 * measure-usage — local BFF の route を叩き、Helius 使用量の差分を出す (B1 計測)
 *
 * GET /admin/helius-usage (src/routes/admin.ts → src/usage.ts) を route 群の前後で読み、
 * requests / approxCredits / byApi / byMethod / rateLimited / cache stats の差分と、
 * route ごとの latency を表で出す。wallet 系 route の Helius 消費を、dashboard を
 * 待たずに before / after で比べるためのもの。
 *
 * 前提: BFF が起動していること (pnpm --filter @seasonals/bff dev)。usage counter は
 * BFF の process 内 memory なので、同じ BFF に対して測る (再起動で 0 に戻る)。
 *
 * 使い方:
 *   node scripts/measure-usage.mjs --wallet <pubkey> \
 *     [--base http://127.0.0.1:3030] [--routes positions,earn,events,history] \
 *     [--repeat 1] [--pause-ms 0] [--token <ADMIN_TOKEN>] [--json]
 *
 *   例 (cold open → 10 秒後に復帰相当):
 *     node scripts/measure-usage.mjs --wallet <W> --routes positions,earn,events,history
 *     node scripts/measure-usage.mjs --wallet <W> --routes positions,earn,events --repeat 2 --pause-ms 10000
 *
 * route:
 *   positions → GET /positions?wallet=
 *   earn      → GET /positions/earn?wallet=
 *   events    → GET /time-events/wallet?wallet=
 *   history   → GET /portfolio/history?wallet=&days=30
 *   1 回の repeat 内では指定 route を **並列** に打つ (app の cold open と同じ形)。
 *
 * 認可: ADMIN_TOKEN は env → --token → BFF の .env の順で探し、`x-seasonals-admin-token`
 * header で送る。BFF 側で ADMIN_TOKEN 未設定なら dev では header 無しで通る。
 * token / api-key は出力しない。
 *
 * --json を付けると表の代わりに差分を JSON で出す (WORKLOG への貼り付け用)。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readEnvFile() {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(path.join(HERE, "..", ".env"), "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
    );
  } catch {
    return {};
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const FILE_ENV = readEnvFile();
// 127.0.0.1 既定 — localhost だと Node が ::1 を先に解決し IPv4 listen の BFF に届かない (verify-tx-routes と同じ)
const BASE = String(arg("base", process.env.BFF_BASE_URL ?? "http://127.0.0.1:3030")).replace(/\/$/, "");
const WALLET = arg("wallet", undefined);
const ROUTES = String(arg("routes", "positions,earn,events,history"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REPEAT = Math.max(1, Number(arg("repeat", "1")) || 1);
const PAUSE_MS = Math.max(0, Number(arg("pause-ms", "0")) || 0);
const TOKEN = process.env.ADMIN_TOKEN || (typeof arg("token") === "string" ? arg("token") : "") || FILE_ENV.ADMIN_TOKEN || "";
const AS_JSON = arg("json", false) === true;

const ROUTE_PATHS = {
  positions: (w) => `/positions?wallet=${encodeURIComponent(w)}`,
  earn: (w) => `/positions/earn?wallet=${encodeURIComponent(w)}`,
  events: (w) => `/time-events/wallet?wallet=${encodeURIComponent(w)}`,
  history: (w) => `/portfolio/history?wallet=${encodeURIComponent(w)}&days=30`,
};

if (typeof WALLET !== "string") {
  console.error("usage: node scripts/measure-usage.mjs --wallet <pubkey> [--routes positions,earn,events,history] [--repeat N] [--pause-ms MS]");
  process.exit(2);
}
const unknown = ROUTES.filter((r) => !ROUTE_PATHS[r]);
if (unknown.length > 0) {
  console.error(`unknown route(s): ${unknown.join(", ")} (known: ${Object.keys(ROUTE_PATHS).join(", ")})`);
  process.exit(2);
}

async function usage() {
  const res = await fetch(`${BASE}/admin/helius-usage`, {
    headers: TOKEN ? { "x-seasonals-admin-token": TOKEN } : {},
  });
  if (res.status === 403) {
    throw new Error("403 admin_token_required — set ADMIN_TOKEN (env / --token / BFF .env) to the BFF's value");
  }
  if (!res.ok) throw new Error(`/admin/helius-usage HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function diffCounts(after = {}, before = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(after), ...Object.keys(before)])) {
    const a = after[k] ?? 0;
    const b = before[k] ?? 0;
    if (typeof a === "number" && typeof b === "number" && a - b !== 0) out[k] = a - b;
  }
  return out;
}

function diffCaches(after = {}, before = {}) {
  const out = {};
  for (const name of Object.keys(after)) {
    const a = after[name];
    const b = before[name] ?? { hits: 0, misses: 0, staleHits: 0, inflightJoins: 0, size: 0 };
    const d = {
      hits: a.hits - b.hits,
      misses: a.misses - b.misses,
      staleHits: a.staleHits - b.staleHits,
      inflightJoins: a.inflightJoins - b.inflightJoins,
      size: a.size,
    };
    if (d.hits || d.misses || d.staleHits || d.inflightJoins) out[name] = d;
  }
  return out;
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (typeof c === "number" ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

async function main() {
  const before = await usage();
  const latencies = [];
  for (let rep = 0; rep < REPEAT; rep++) {
    if (rep > 0 && PAUSE_MS > 0) await sleep(PAUSE_MS);
    const results = await Promise.all(
      ROUTES.map(async (r) => {
        const t0 = performance.now();
        let status = 0;
        let bytes = 0;
        try {
          const res = await fetch(`${BASE}${ROUTE_PATHS[r](WALLET)}`);
          status = res.status;
          bytes = (await res.arrayBuffer()).byteLength;
        } catch (e) {
          status = `ERR ${e instanceof Error ? e.name : "error"}`;
        }
        return [rep + 1, r, status, Math.round(performance.now() - t0), bytes];
      })
    );
    latencies.push(...results);
  }
  const after = await usage();

  const delta = {
    wallet: `${WALLET.slice(0, 4)}…${WALLET.slice(-4)}`,
    routes: ROUTES,
    repeat: REPEAT,
    pauseMs: PAUSE_MS,
    requests: after.requests - before.requests,
    approxCredits: after.approxCredits - before.approxCredits,
    byApi: diffCounts(after.byApi, before.byApi),
    byMethod: diffCounts(after.byMethod, before.byMethod),
    rateLimited: diffCounts(after.rateLimited, before.rateLimited),
    failed: (after.failed ?? 0) - (before.failed ?? 0),
    maxQueueDepth: after.maxQueueDepth,
    caches: diffCaches(after.caches, before.caches),
    latencyMs: latencies.map(([rep, route, status, ms, bytes]) => ({ rep, route, status, ms, bytes })),
  };

  if (AS_JSON) {
    console.log(JSON.stringify(delta, null, 2));
    return;
  }

  console.log(`BFF ${BASE}  wallet ${delta.wallet}  routes ${ROUTES.join(",")}  repeat ${REPEAT}${PAUSE_MS ? `  pause ${PAUSE_MS}ms` : ""}\n`);
  console.log(table(latencies, ["rep", "route", "status", "ms", "bytes"]));
  console.log(`\nHelius (delta): requests ${delta.requests}  approxCredits ${delta.approxCredits}  failed ${delta.failed}  maxQueueDepth(since BFF start) ${delta.maxQueueDepth}`);
  console.log(`  byApi:       ${JSON.stringify(delta.byApi)}`);
  console.log(`  rateLimited: ${JSON.stringify(delta.rateLimited)}`);
  const methods = Object.entries(delta.byMethod).sort((a, b) => b[1] - a[1]);
  if (methods.length > 0) {
    console.log("");
    console.log(table(methods.map(([m, n]) => [m, n]), ["api:method", "calls"]));
  }
  const caches = Object.entries(delta.caches);
  if (caches.length > 0) {
    console.log("");
    console.log(
      table(
        caches.map(([n, c]) => [n, c.hits, c.staleHits, c.misses, c.inflightJoins, c.size]),
        ["cache", "hits", "stale", "misses", "joins", "size"]
      )
    );
  } else {
    console.log("\n(no TtlCache activity)");
  }
}

main().catch((e) => {
  console.error(`measure-usage: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
