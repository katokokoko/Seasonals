/**
 * e2e/water-shots.mjs — 水面を参照写真に寄せる調整ループ用の screenshot + 数値 + gate (docs/web/reference/water-goal.md)。
 *   WEB_URL (既定 http://localhost:5173) で起動済みの dev / preview server に対して実行する。system Chrome、headless。
 *   出力: .screenshots/water-*.png、.screenshots/water-stats.json、.screenshots/water-gates.json。gate が 1 つでも落ちたら exit 1。
 *   WATER_BASELINE=1 で実行すると、今の値を基準として docs/web/reference/water-baseline.json に書く (iteration 0 で 1 回だけ)。
 *
 * 撮るもの (1440×900、DPR 1.25):
 *   - water-home-1440.png: Home 全体
 *   - water-only-1440.png: 水面 canvas を UI なし (quiet / glass / floater 0、時刻と光は固定) で 1 回描いた描画バッファ
 *   - water-crop.png: water-only の中央 700×700 (device px) を 1:1
 *   - water-calendar-1440.png: /calendar?view=month 全体
 * 数値 (water-stats.json、合否には使わない): 参照写真と water-only を同じ 720×450 に cover で縮め、同じ式で
 *   輝度の平均 / σ / p5 / p50 / p95、16px tile の局所 σ、白飛び (> 240) の割合、彩度の平均、高周波量
 * gate (water-gates.json):
 *   - legibility: Home で文字だけ透明にした screenshot から、portal card の title / desc と top bar の link の
 *     背景の暗い側 p5 (文字が明るければ明るい側 p95) と実際の文字色のコントラスト比。各要素 ≥ min(4.5, 基準 − 0.05)
 *   - calmWork: /calendar?view=month と /menu の水面 canvas の描画バッファ輝度 σ ≤ 基準 × 1.25
 *   - stillIdentical: reduced motion で 1 秒差の描画バッファの hash が同じ
 *   - moves: 通常時に 1 秒で描画バッファが変わる
 *   - perf: 水面 + glass canvas の drawArrays + readPixels(1px) の合計 ≤ 基準 × 1.4、rafAvgMs ≤ 17.5
 *   - noPageErrors
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.WEB_URL ?? "http://localhost:5173";
const W = 1440;
const H = 900;
const DPR = 1.25;
const REF = new URL("../../../docs/web/reference/water-ref.png", import.meta.url);
const BASELINE = new URL("../../../docs/web/reference/water-baseline.json", import.meta.url);
const recordBaseline = process.env.WATER_BASELINE === "1";
const baseline = !recordBaseline && existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
mkdirSync(".screenshots", { recursive: true });
const args = ["--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ channel: "chrome", headless: true, args });
const errors = [];

async function open(path, opts = {}) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, ...opts });
  // 毎回同じ配置で撮る (キャラクターの出現位置は Math.random。採点が配置の運でぶれないように seed を固定)
  await page.addInitScript(() => {
    let a = 20261005;
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  return page;
}

/** 水面 canvas を今の uniform で 1 回描き、描画バッファの hash と輝度 σ を返す */
function bufferInfo(page) {
  return page.evaluate(() => {
    const c = document.querySelector(".water-canvas canvas");
    const gl = c.getContext("webgl");
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let h = 2166136261;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < px.length; i += 4) {
      h = Math.imul(h ^ px[i], 16777619);
      h = Math.imul(h ^ px[i + 1], 16777619);
      h = Math.imul(h ^ px[i + 2], 16777619);
      const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      s += l;
      s2 += l * l;
    }
    const n = px.length / 4;
    const m = s / n;
    return { hash: h >>> 0, mean: +m.toFixed(2), sigma: +Math.sqrt(s2 / n - m * m).toFixed(3), state: c.dataset.waterState };
  });
}

/** UI なしの水: quiet / glass / floater を 0 に、時刻と光を固定して 1 回描き、PNG (base64) で返す。uniform は戻す */
function waterOnly(page) {
  return page.evaluate(() => {
    const c = document.querySelector(".water-canvas canvas");
    const gl = c.getContext("webgl");
    const prog = gl.getParameter(gl.CURRENT_PROGRAM);
    const L = (n) => gl.getUniformLocation(prog, n);
    const keep = ["uQuietCount", "uGlassCount", "uFloaterCount", "uTime", "uLight"].map((n) => [n, gl.getUniform(prog, L(n))]);
    gl.uniform1i(L("uQuietCount"), 0);
    gl.uniform1i(L("uGlassCount"), 0);
    gl.uniform1i(L("uFloaterCount"), 0);
    gl.uniform1f(L("uTime"), 37);
    gl.uniform2f(L("uLight"), -0.6, 0.8);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const w = c.width;
    const h = c.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (const [n, v] of keep) {
      if (n === "uLight") gl.uniform2f(L(n), v[0], v[1]);
      else if (n === "uTime") gl.uniform1f(L(n), v);
      else gl.uniform1i(L(n), v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // readPixels は下から上。2D canvas に上下を戻して PNG に
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    return { png: out.toDataURL("image/png").split(",")[1], w, h };
  });
}

/** 2 枚の PNG (base64) を同じ 720×450 に cover で縮め、同じ式で数値を出す */
function imageStats(page, pngs) {
  return page.evaluate(async (list) => {
    const out = {};
    for (const [name, b64] of Object.entries(list)) {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const w = 720;
      const h = 450;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      const k = Math.max(w / img.width, h / img.height);
      ctx.drawImage(img, (w - img.width * k) / 2, (h - img.height * k) / 2, img.width * k, img.height * k);
      const d = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      let sat = 0;
      const rgb = [0, 0, 0];
      for (let i = 0; i < w * h; i++) {
        const r = d[i * 4];
        const g = d[i * 4 + 1];
        const b = d[i * 4 + 2];
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        sat += mx ? (mx - mn) / mx : 0;
        rgb[0] += r;
        rgb[1] += g;
        rgb[2] += b;
      }
      const n = w * h;
      const sorted = Float32Array.from(lum).sort();
      const pct = (p) => +sorted[Math.floor(p * (n - 1))].toFixed(1);
      let s = 0;
      let s2 = 0;
      let white = 0;
      for (const l of lum) {
        s += l;
        s2 += l * l;
        if (l > 240) white++;
      }
      const mean = s / n;
      let tiles = 0;
      let tileSum = 0;
      for (let ty = 0; ty + 16 <= h; ty += 16)
        for (let tx = 0; tx + 16 <= w; tx += 16) {
          let a = 0;
          let a2 = 0;
          for (let y = ty; y < ty + 16; y++)
            for (let x = tx; x < tx + 16; x++) {
              const l = lum[y * w + x];
              a += l;
              a2 += l * l;
            }
          const m = a / 256;
          tileSum += Math.sqrt(Math.max(a2 / 256 - m * m, 0));
          tiles++;
        }
      let hp = 0;
      let hpn = 0;
      for (let y = 2; y < h - 2; y++)
        for (let x = 2; x < w - 2; x++) {
          const i = y * w + x;
          hp += Math.abs(lum[i] - (lum[i - 2] + lum[i + 2] + lum[i - 2 * w] + lum[i + 2 * w]) / 4);
          hpn++;
        }
      out[name] = {
        meanRGB: rgb.map((v) => +(v / n).toFixed(1)),
        meanL: +mean.toFixed(1),
        sigmaL: +Math.sqrt(s2 / n - mean * mean).toFixed(1),
        p5: pct(0.05),
        p50: pct(0.5),
        p95: pct(0.95),
        localSigma16: +(tileSum / tiles).toFixed(2),
        whitePct: +((white / n) * 100).toFixed(2),
        saturation: +(sat / n).toFixed(3),
        highPass: +(hp / hpn).toFixed(2),
      };
    }
    return out;
  }, pngs);
}

/** 文字の読みやすさ: 文字だけ透明にした screenshot の、各文字 box の背景と文字色のコントラスト比 */
async function legibility(page) {
  const SEL = ".portal-title, .portal-desc, .global-nav a";
  const boxes = await page.evaluate((sel) => {
    const rel = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return [...document.querySelectorAll(sel)]
      .filter((el) => el.textContent.trim() && el.getClientRects().length)
      .map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        const m = getComputedStyle(el).color.match(/[\d.]+/g).map(Number);
        const textL = 0.2126 * rel(m[0]) + 0.7152 * rel(m[1]) + 0.0722 * rel(m[2]);
        const kind = el.matches(".global-nav a") ? "nav" : el.className.split(" ")[0].replace("portal-", "");
        return { name: `${kind}:${el.textContent.trim().slice(0, 24)}`, x: r.left, y: r.top, w: r.width, h: r.height, textL };
      })
      .filter((b) => b.w > 2 && b.h > 2);
  }, SEL);
  const style = await page.addStyleTag({
    content: `${SEL} { color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important; }`,
  });
  await page.waitForTimeout(120);
  const shot = (await page.screenshot()).toString("base64");
  await style.evaluate((el) => el.remove());
  return page.evaluate(
    async ({ b64, boxes, dpr }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const rel = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return boxes.map((b) => {
        const d = ctx.getImageData(Math.round(b.x * dpr), Math.round(b.y * dpr), Math.round(b.w * dpr), Math.round(b.h * dpr)).data;
        const ls = [];
        for (let i = 0; i < d.length; i += 4) ls.push(0.2126 * rel(d[i]) + 0.7152 * rel(d[i + 1]) + 0.0722 * rel(d[i + 2]));
        ls.sort((a, z) => a - z);
        const mid = ls[Math.floor(ls.length / 2)];
        // 文字が背景より暗ければ、背景の暗い側 (p5) が最悪。明るければ明るい側 (p95)
        const worst = b.textL < mid ? ls[Math.floor(ls.length * 0.05)] : ls[Math.floor(ls.length * 0.95)];
        const hi = Math.max(worst, b.textL);
        const lo = Math.min(worst, b.textL);
        return { name: b.name, ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2) };
      });
    },
    { b64: shot, boxes, dpr: DPR },
  );
}

/** GPU 込みの描画コスト: 水面 + glass canvas を今の uniform で描いて readPixels(1px) で完了を待つ */
function perf(page) {
  return page.evaluate(async () => {
    const raf = await new Promise((resolve) => {
      const ts = [];
      const tick = (t) => {
        ts.push(t);
        if (t - ts[0] < 2000) requestAnimationFrame(tick);
        else resolve((ts[ts.length - 1] - ts[0]) / (ts.length - 1));
      };
      requestAnimationFrame(tick);
    });
    const gls = [".water-canvas canvas", ".glass-canvas canvas"]
      .map((s) => document.querySelector(s)?.getContext("webgl"))
      .filter(Boolean);
    const px = new Uint8Array(4);
    const once = () => {
      for (const gl of gls) {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
    };
    once();
    // 3 回測って中央値 (thermal / scheduler のぶれを均す)
    const runs = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      for (let i = 0; i < 30; i++) once();
      runs.push((performance.now() - t0) / 30);
    }
    runs.sort((a, b) => a - b);
    return { rafAvgMs: +raf.toFixed(2), syncDrawMs: +runs[1].toFixed(3) };
  });
}

const gates = {};
const shots = {};

// 1. Home (animating): 全体、文字の読みやすさ、UI なしの水、動き、perf
{
  const page = await open("/");
  await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 4500));
  await page.screenshot({ path: ".screenshots/water-home-1440.png" });
  gates.legibility = await legibility(page);
  const wo = await waterOnly(page);
  writeFileSync(".screenshots/water-only-1440.png", Buffer.from(wo.png, "base64"));
  shots.waterOnly = wo.png;
  const a = await bufferInfo(page);
  await page.waitForTimeout(1000);
  const b = await bufferInfo(page);
  gates.moves = a.hash !== b.hash && b.state === "animating";
  gates.perf = await perf(page);
  // water-only の中央を 1:1 で (device px)
  const crop = await page.evaluate(
    async ({ b64, size }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      c.getContext("2d").drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, size, size);
      return c.toDataURL("image/png").split(",")[1];
    },
    { b64: wo.png, size: 700 },
  );
  writeFileSync(".screenshots/water-crop.png", Buffer.from(crop, "base64"));
  const stats = await imageStats(page, { reference: readFileSync(REF).toString("base64"), waterOnly: wo.png });
  writeFileSync(".screenshots/water-stats.json", JSON.stringify(stats, null, 1));
  gates.stats = stats;
  await page.close();
}

// 2. reduced motion: 同じ絵のまま
{
  const page = await open("/", { reducedMotion: "reduce" });
  await page.waitForTimeout(1500);
  const a = await bufferInfo(page);
  await page.waitForTimeout(1000);
  const b = await bufferInfo(page);
  gates.stillIdentical = a.hash === b.hash && a.state === "still";
  await page.close();
}

// 3. 作業画面: calm preset のまま静か
gates.calm = {};
for (const path of ["/calendar?view=month", "/menu"]) {
  const page = await open(path);
  await page.waitForTimeout(1500);
  if (path.startsWith("/calendar")) await page.screenshot({ path: ".screenshots/water-calendar-1440.png" });
  gates.calm[path] = (await bufferInfo(page)).sigma;
  await page.close();
}
await browser.close();

const now = {
  legibility: Object.fromEntries(gates.legibility.map((l) => [l.name, l.ratio])),
  calm: gates.calm,
  syncDrawMs: gates.perf.syncDrawMs,
};
if (recordBaseline) {
  writeFileSync(BASELINE, `${JSON.stringify(now, null, 1)}\n`);
  console.log(`baseline written to ${BASELINE.pathname}`);
}
const ref = recordBaseline ? now : baseline;
if (!ref) {
  console.error("no baseline: run once with WATER_BASELINE=1 on the iteration 0 shader");
  process.exit(2);
}
const legFails = gates.legibility.filter((l) => l.ratio < Math.min(4.5, (ref.legibility[l.name] ?? 4.5) - 0.05));
const calmFails = Object.entries(gates.calm).filter(([p, s]) => s > (ref.calm[p] ?? Infinity) * 1.25);
const checks = {
  legibility: legFails.length === 0,
  calmWork: calmFails.length === 0,
  stillIdentical: gates.stillIdentical,
  moves: gates.moves,
  syncDraw: gates.perf.syncDrawMs <= ref.syncDrawMs * 1.4,
  raf: gates.perf.rafAvgMs <= 17.5,
  noPageErrors: errors.length === 0,
};
const result = { ok: Object.values(checks).every(Boolean), checks, legFails, calmFails, baseline: ref, now, gates, errors };
writeFileSync(".screenshots/water-gates.json", JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ok: result.ok, checks, legFails, calmFails, now, perf: gates.perf, stats: gates.stats }, null, 1));
process.exit(result.ok ? 0 : 1);
