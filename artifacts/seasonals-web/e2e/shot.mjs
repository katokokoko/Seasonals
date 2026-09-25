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
if (process.env.WATCH) {
  const watchlist = process.env.WATCH.split(",").map((address) => ({ chain: address.startsWith("0x") ? "ethereum" : "solana", address }));
  await page.addInitScript((v) => localStorage.setItem("seasonals-web-session-v2", v), JSON.stringify({ state: { watchlist }, version: 0 }));
}
if (process.env.CLICK) {
  // CLICK="role:name" (例 "button:Timeline")
}
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + path, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1500));
if (process.env.CLICK) {
  const [role, ...rest] = process.env.CLICK.split(":");
  await page.getByRole(role, { name: rest.join(":"), exact: true }).first().click();
  await page.waitForTimeout(600);
}
const state = await page.locator("canvas").first().getAttribute("data-water-state").catch(() => null);
await page.screenshot({ path: `.screenshots/${name}.png` });
console.log(JSON.stringify({ name, state, logs }, null, 1));
await browser.close();
