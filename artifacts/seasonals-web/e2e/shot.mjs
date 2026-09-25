/**
 * 簡易 screenshot: node e2e/shot.mjs <path> <name> [width] [height] [--reduced] [--nowebgl]
 * system の Google Chrome を使う (browser download 不要)。出力は .screenshots/ (gitignore)。
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const [path = "/", name = "shot", w = "1440", h = "900", ...flags] = process.argv.slice(2);
const base = process.env.WEB_URL ?? "http://localhost:5173";
mkdirSync(".screenshots", { recursive: true });
const args = ["--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist"];
if (flags.includes("--nowebgl")) args.push("--disable-webgl", "--disable-3d-apis");
const browser = await chromium.launch({ channel: "chrome", headless: true, args });
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  reducedMotion: flags.includes("--reduced") ? "reduce" : "no-preference",
});
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + path, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1500));
const state = await page.locator("canvas").first().getAttribute("data-water-state").catch(() => null);
await page.screenshot({ path: `.screenshots/${name}.png` });
console.log(JSON.stringify({ name, state, logs }, null, 1));
await browser.close();
