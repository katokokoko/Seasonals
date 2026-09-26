/**
 * optimize-characters.mjs — Home の水面に浮かべるキャラクター画像 (大きな透過 PNG) を
 * 表示用の WebP に変換する (1 回だけ手で実行する。画像処理の依存を増やさないよう
 * e2e と同じ headless Chrome の canvas で処理する)。
 *
 *   node scripts/optimize-characters.mjs <in.png> <out.webp> [longSide=360]
 *
 * - 透過の余白を alpha の bounding box で切り詰める (alpha > 8 を中身とみなし、4px の余白を残す)
 * - 長辺 longSide px に縮小 (表示 ~170px × DPR 2)
 * - WebP (quality 0.9、alpha 付き) で書き出す
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [input, output, longSideArg] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/optimize-characters.mjs <in.png> <out.webp> [longSide=360]");
  process.exit(2);
}
const longSide = Number(longSideArg ?? 360);
const src = `data:image/png;base64,${readFileSync(input).toString("base64")}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const result = await page.evaluate(
  async ({ src, longSide }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    const pad = 4;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const k = longSide / Math.max(cw, ch);
    const out = document.createElement("canvas");
    out.width = Math.round(cw * k);
    out.height = Math.round(ch * k);
    const o = out.getContext("2d");
    o.imageSmoothingQuality = "high";
    o.drawImage(c, x0, y0, cw, ch, 0, 0, out.width, out.height);
    const blob = await new Promise((r) => out.toBlob(r, "image/webp", 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    return { b64: btoa(bin), crop: [x0, y0, cw, ch], size: [out.width, out.height], type: blob.type };
  },
  { src, longSide }
);
await browser.close();
if (result.type !== "image/webp") throw new Error(`encoder returned ${result.type}`);
writeFileSync(output, Buffer.from(result.b64, "base64"));
console.log(`${output}: crop ${result.crop.join(",")} → ${result.size.join("×")}, ${Buffer.from(result.b64, "base64").length} bytes`);
