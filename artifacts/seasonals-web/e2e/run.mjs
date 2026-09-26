/**
 * e2e/run.mjs — 画面の操作検証 + screenshot (system Chrome, headless)。
 *   WEB_URL (既定 http://localhost:5173) で起動済みの dev / preview server に対して実行する。
 *   結果は stdout に JSON、失敗があれば exit 1。screenshot は .screenshots/ (gitignore)。
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.WEB_URL ?? "http://localhost:5173";
const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
];
const ROUTES = [
  ["/", "home"],
  ["/calendar?view=month", "calendar"],
  ["/calendar?view=timeline", "timeline"],
  ["/explore", "explore"],
  ["/agent", "agent"],
  ["/dashboard", "dashboard"],
  ["/settings", "settings"],
];
mkdirSync(".screenshots", { recursive: true });
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail: String(detail) });

const args = ["--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ channel: "chrome", headless: true, args });

async function newPage(vp, opts = {}) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, ...opts });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  return page;
}

for (const vp of WIDTHS) {
  const page = await newPage(vp);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  // nav reachability (Agent / Dashboard は 1280 で More の中)
  const navNames = await page.locator("nav[aria-label=Primary] a:visible").allInnerTexts();
  if (vp.width >= 1440) check(`${vp.name} nav shows all items`, ["Overview", "Explore", "Calendar", "Agent", "Dashboard"].every((n) => navNames.includes(n)), navNames);
  else {
    await page.getByRole("button", { name: "More", exact: true }).click();
    const more = await page.locator(".nav-more-menu a").allInnerTexts();
    check(`${vp.name} More menu holds Agent & Dashboard`, more.includes("Agent") && more.includes("Dashboard"), more);
    await page.keyboard.press("Escape");
  }
  check(`${vp.name} settings gear`, (await page.getByRole("link", { name: "Settings" }).getAttribute("href")) === "/settings");
  check(`${vp.name} chain icons from config`, (await page.locator(".chain-icons li").count()) === 2);
  check(`${vp.name} Ethereum chain icon is the brand logo`, (await page.locator(".chain-icons li[aria-label='Ethereum'] img.chain-logo").count()) === 1);

  // backdrop-filter budget (≤ 2 persistent; 実装は 0)
  const blurCount = await page.evaluate(() =>
    [...document.querySelectorAll("*")].filter((el) => {
      const cs = getComputedStyle(el);
      return (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none");
    }).length
  );
  check(`${vp.name} backdrop-filter surfaces`, blurCount <= 2, blurCount);

  // toggle: 中央カード外形と header 高さが不変
  const card = page.locator(".home-card");
  const head = page.locator(".home-card-head");
  const b1 = await card.boundingBox();
  const h1 = await head.boundingBox();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.waitForTimeout(300);
  const b2 = await card.boundingBox();
  const h2 = await head.boundingBox();
  check(`${vp.name} toggle keeps card box`, JSON.stringify(b1) === JSON.stringify(b2), `${JSON.stringify(b1)} vs ${JSON.stringify(b2)}`);
  check(`${vp.name} toggle keeps header height`, h1?.height === h2?.height, `${h1?.height} vs ${h2?.height}`);
  check(`${vp.name} still on Home after toggle`, new URL(page.url()).pathname === "/");
  check(`${vp.name} timeline has no month nav`, (await page.getByRole("button", { name: "Previous month" }).count()) === 0);
  check(`${vp.name} expand → timeline`, (await page.getByRole("link", { name: "Open full timeline" }).getAttribute("href")) === "/calendar?view=timeline");
  await page.screenshot({ path: `.screenshots/home-timeline-${vp.name}.png` });
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.waitForTimeout(300);
  check(`${vp.name} expand → calendar`, (await page.getByRole("link", { name: "Open full calendar" }).getAttribute("href")) === "/calendar?view=month");

  // date click → dialog (URL 不変) → Esc で閉じて focus 復帰
  const cell = page.locator(".home-card .month-cell-hit").nth(12);
  await cell.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  check(`${vp.name} date click opens dialog`, await dialog.isVisible());
  check(`${vp.name} date click keeps URL`, new URL(page.url()).pathname === "/");
  const labelled = await dialog.getAttribute("aria-labelledby");
  check(`${vp.name} dialog labelled`, labelled && (await page.locator(`[id="${labelled}"]`).count()) === 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `.screenshots/home-detail-${vp.name}.png` });
  // focus trap: Tab を多数回押しても dialog 内に留まる
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  check(`${vp.name} focus trapped in dialog`, await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))));
  await page.keyboard.press("Escape");
  check(`${vp.name} Esc closes dialog`, (await page.getByRole("dialog").count()) === 0);
  check(`${vp.name} focus returns to date cell`, await page.evaluate(() => document.activeElement?.classList.contains("month-cell-hit")));
  // outside click
  await cell.click();
  await page.mouse.click(5, vp.height - 5);
  check(`${vp.name} outside click closes dialog`, (await page.getByRole("dialog").count()) === 0);

  // keyboard: portal card focus + Enter
  await page.locator(".portal-card.slot-agent").focus();
  await page.keyboard.press("Enter");
  await page.waitForURL("**/agent");
  check(`${vp.name} Enter on Agent card → /agent`, new URL(page.url()).pathname === "/agent");

  // workspace view switch keeps route
  await page.goto(BASE + "/calendar?view=month", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  check(`${vp.name} tier-2 switch → ?view=timeline`, new URL(page.url()).searchParams.get("view") === "timeline");

  for (const [path, name] of ROUTES) {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `.screenshots/${name}-${vp.name}.png` });
  }
  check(`${vp.name} no page errors`, page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}

// protocol ロゴ: 公開 mainnet address を watch → Pendle 行の badge が monogram でなく img
{
  const page = await newPage(WIDTHS[0]);
  const watchlist = [{ chain: "ethereum", address: "0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11" }];
  await page.addInitScript((v) => localStorage.setItem("seasonals-web-session-v2", v), JSON.stringify({ state: { watchlist }, version: 0 }));
  await page.goto(BASE + "/calendar?view=timeline", { waitUntil: "networkidle" });
  await page.locator(".tl-row").first().waitFor({ timeout: 30_000 }).catch(() => {});
  const pendleRow = page.locator(".tl-row", { hasText: "Pendle" }).first();
  const badge = await pendleRow.locator(".protocol-badge").first().evaluate((el) => ({ tag: el.tagName, w: el.getBoundingClientRect().width })).catch(() => null);
  check("Pendle row shows the Pendle logo", badge?.tag === "IMG" && badge.w > 0 && badge.w <= 24, JSON.stringify(badge));
  await page.close();
}

// Explore: Pendle は PT / YT のペア、バッジは Pendle ロゴの下、chain ロゴは上、名前は 1 行
{
  const page = await newPage(WIDTHS[0]);
  await page.goto(BASE + "/explore", { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "PT/YT", exact: true }).click({ timeout: 30_000 }).catch(() => {});
  await page.locator(".token-kind").first().waitFor({ timeout: 30_000 }).catch(() => {});
  const pt = await page.locator(".token-kind-pt").count();
  const yt = await page.locator(".token-kind-yt").count();
  check("Explore shows Pendle PT and YT cards", pt > 0 && pt === yt, `pt=${pt} yt=${yt}`);
  const order = await page.locator(".menu-media").first().evaluate((el) => [...el.children].map((c) => c.className.split(" ")[0]));
  check("chain logo above protocol logo, PT/YT badge below", JSON.stringify(order) === JSON.stringify(["menu-media-chain", "protocol-badge", "token-kind"]), order);
  const wrapped = await page.locator(".menu-item-name h3").evaluateAll((els) =>
    els.filter((h) => h.getBoundingClientRect().height > parseFloat(getComputedStyle(h).lineHeight) * 1.5).map((h) => h.textContent)
  );
  check("Pendle card names stay on one line", wrapped.length === 0, wrapped.join(", "));
  await page.close();
}

// reduced motion → 静止画
{
  const page = await newPage(WIDTHS[0], { reducedMotion: "reduce" });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("reduced motion → still background", (await page.locator(".water-canvas canvas").getAttribute("data-water-state")) === "still");
  await page.close();
  const anim = await newPage(WIDTHS[0]);
  await anim.goto(BASE + "/", { waitUntil: "networkidle" });
  await anim.waitForTimeout(800);
  check("default → animating background", (await anim.locator(".water-canvas canvas").getAttribute("data-water-state")) === "animating");
  await anim.close();
}
await browser.close();

// WebGL 無し → fallback
{
  const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-webgl", "--disable-3d-apis"] });
  const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check("no WebGL → fallback", (await page.locator(".water-canvas canvas").getAttribute("data-water-state")) === "fallback");
  await page.screenshot({ path: ".screenshots/home-nowebgl-1280.png" });
  await b.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
process.exit(failed.length ? 1 : 0);
