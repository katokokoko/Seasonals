/**
 * e2e/water-power.mjs — 発熱対策 1〜5 (src/background/perfVariant.ts) を 1 つずつ入れた版の負荷を比べる。
 *   WEB_URL (既定 http://localhost:5173) の dev server に対して、system Chrome を **画面に出して** 実行する
 *   (headless は 60 Hz 固定で、ProMotion の 120 Hz の rAF にならない。窓が隠れると rAF が止まるので前面に置く)。
 *   出力: .screenshots/water-power.json と表 (stdout)、.screenshots/water-dpr-{1.25,1}.png (対策 3 の見た目)。
 *
 * 1 組 (版 × 画面) ごとに 3 秒待ってから 10 秒測る:
 *   - rafHz: rAF の回数 / 秒 (画面の rate)
 *   - draws: 水面 / glass canvas の drawArrays の回数 / 秒
 *   - msPerDraw: 同じ page で drawArrays + readPixels(1px) を 20 回回した 1 回の時間 (GPU 込み、scissor / DPR も反映)
 *   - gpuBusy: Σ draws × msPerDraw / 1000 (GPU が水を描いている時間の割合の目安、%)
 *   - cpu: この Chrome の GPU process / renderer の CPU 時間 / 実時間 (%)、WindowServer の CPU (%)
 * 版の順番を 2 周 (2 周目は逆順) 回して、各値は 2 回の平均。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.WEB_URL ?? "http://localhost:5173";
const WARM_MS = 3000;
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 10000);
const VARIANTS = (process.env.VARIANTS ?? "none,1,2,3,4,5,1+2+4+5,all").split(",");
const ROUTES = ["/", "/calendar?view=month"];
mkdirSync(".screenshots", { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), "water-power-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  args: ["--window-position=0,0", "--window-size=1440,1000", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
const errors = [];
await ctx.addInitScript(() => {
  const counts = { raf: 0, water: 0, glass: 0 };
  window.__waterCounts = counts;
  const orig = WebGLRenderingContext.prototype.drawArrays;
  WebGLRenderingContext.prototype.drawArrays = function (...a) {
    const host = this.canvas?.parentElement?.className ?? "";
    if (host.includes("glass")) counts.glass++;
    else counts.water++;
    return orig.apply(this, a);
  };
  const tick = () => {
    counts.raf++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

/** ps の TIME (M:SS.ss / H:MM:SS) → 秒 */
const secs = (t) => t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
function cpuTimes() {
  const out = { gpu: 0, renderer: 0, windowServer: 0 };
  const ps = execFileSync("ps", ["-Ao", "pid=,time=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[3];
    if (/\/WindowServer\b/.test(cmd)) out.windowServer += secs(m[2]);
    if (!cmd.includes(userDataDir)) continue;
    if (cmd.includes("--type=gpu-process")) out.gpu += secs(m[2]);
    else if (cmd.includes("--type=renderer")) out.renderer += secs(m[2]);
  }
  return out;
}

async function measure(variant, route) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${variant} ${route}: ${e.message}`));
  // "1+2+4+5@10" = 対策 1,2,4,5 を fps 上限 10 で
  const [set, fps] = variant.split("@");
  const q = `water-perf=${set.replaceAll("+", ",")}&water-fps=${fps ?? 0}`;
  await page.goto(`${BASE}${route}${route.includes("?") ? "&" : "?"}${q}`, { waitUntil: "networkidle" });
  await page.bringToFront();
  await page.waitForTimeout(WARM_MS);
  const c0 = await page.evaluate(() => ({ ...window.__waterCounts, t: performance.now() }));
  const p0 = cpuTimes();
  const w0 = Date.now();
  await page.waitForTimeout(SAMPLE_MS);
  const c1 = await page.evaluate(() => ({ ...window.__waterCounts, t: performance.now() }));
  const p1 = cpuTimes();
  const wall = (Date.now() - w0) / 1000;
  const sec = (c1.t - c0.t) / 1000;
  // 1 回の描画の時間 (今の scissor / DPR のまま)。計測の drawArrays は上の回数に入らないよう、回数を読んだ後に回す
  const ms = await page.evaluate(() => {
    const px = new Uint8Array(4);
    const one = (sel) => {
      const gl = document.querySelector(sel)?.getContext("webgl");
      if (!gl) return 0;
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const r = [];
      for (let k = 0; k < 5; k++) {
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) {
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        r.push((performance.now() - t0) / 20);
      }
      return r.sort((a, b) => a - b)[2];
    };
    const water = document.querySelector(".water-canvas canvas");
    return {
      water: one(".water-canvas canvas"),
      glass: one(".glass-canvas canvas"),
      size: water ? `${water.width}x${water.height}` : "",
      state: water?.dataset.waterState ?? "",
    };
  });
  await page.close();
  const draws = { water: (c1.water - c0.water) / sec, glass: (c1.glass - c0.glass) / sec };
  return {
    variant,
    route,
    rafHz: (c1.raf - c0.raf) / sec,
    draws,
    msPerDraw: { water: ms.water, glass: ms.glass },
    gpuBusy: ((draws.water * ms.water + draws.glass * ms.glass) / 1000) * 100,
    cpu: {
      gpu: ((p1.gpu - p0.gpu) / wall) * 100,
      renderer: ((p1.renderer - p0.renderer) / wall) * 100,
      windowServer: ((p1.windowServer - p0.windowServer) / wall) * 100,
    },
    canvas: ms.size,
    state: ms.state,
  };
}

const runs = [];
for (const order of [VARIANTS, [...VARIANTS].reverse()])
  for (const v of order)
    for (const r of ROUTES) {
      const m = await measure(v, r);
      runs.push(m);
      console.error(`${v.padEnd(8)} ${r.padEnd(22)} raf ${m.rafHz.toFixed(0)}Hz draws ${m.draws.water.toFixed(0)}/${m.draws.glass.toFixed(0)} gpuBusy ${m.gpuBusy.toFixed(0)}% gpu ${m.cpu.gpu.toFixed(0)}% ws ${m.cpu.windowServer.toFixed(0)}%`);
    }

// 対策 3 の見た目: DPR 1.25 と 1.0 の Home (Retina の DPR 2 で撮る)
for (const [v, name] of [["none", "1.25"], ["3", "1"]]) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?water-perf=${v}`, { waitUntil: "networkidle" });
  await page.bringToFront();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `.screenshots/water-dpr-${name}.png` });
  await page.close();
}
await ctx.close();

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rows = [];
for (const v of VARIANTS)
  for (const r of ROUTES) {
    const ms = runs.filter((x) => x.variant === v && x.route === r);
    rows.push({
      variant: v,
      route: r,
      rafHz: +avg(ms.map((m) => m.rafHz)).toFixed(0),
      drawsWater: +avg(ms.map((m) => m.draws.water)).toFixed(1),
      drawsGlass: +avg(ms.map((m) => m.draws.glass)).toFixed(1),
      msWater: +avg(ms.map((m) => m.msPerDraw.water)).toFixed(2),
      msGlass: +avg(ms.map((m) => m.msPerDraw.glass)).toFixed(2),
      gpuBusyPct: +avg(ms.map((m) => m.gpuBusy)).toFixed(1),
      cpuGpuProcPct: +avg(ms.map((m) => m.cpu.gpu)).toFixed(1),
      cpuRendererPct: +avg(ms.map((m) => m.cpu.renderer)).toFixed(1),
      cpuWindowServerPct: +avg(ms.map((m) => m.cpu.windowServer)).toFixed(1),
      canvas: ms[0].canvas,
      state: ms[0].state,
    });
  }
writeFileSync(".screenshots/water-power.json", JSON.stringify({ rows, runs, errors }, null, 1));
console.table(rows);
if (errors.length) console.error("page errors:", errors);
process.exit(errors.length ? 1 : 0);
