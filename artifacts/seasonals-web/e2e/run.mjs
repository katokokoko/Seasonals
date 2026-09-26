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
  ["/menu", "menu"],
  ["/agent", "agent"],
  ["/dashboard", "dashboard"],
  ["/settings", "settings"],
];
mkdirSync(".screenshots", { recursive: true });

/**
 * shader (GPU に upload 済みの uGlassRects を gl.getUniform で読み戻す) と DOM の glass 面の
 * 中心の最大ずれ (CSS px)。WebGL の光・縁が DOM の枠からずれていないかの検出に使う。
 * 画面に出ている frame 同士で比べるため、rAF の中 (WaterBackground の描画 callback の後) で測る
 * (evaluate の時点で直接測ると、animation 中は「次の frame の DOM」と「今の frame の shader」を比べてしまう)。
 */
async function glassDrift(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve((() => {
    // glass は glass layer (sticky) に描く。無い環境では水面 layer
    const c = document.querySelector(".glass-canvas canvas") ?? document.querySelector(".water-canvas canvas");
    const gl = c?.getContext("webgl");
    const prog = gl?.getParameter(gl.CURRENT_PROGRAM);
    if (!prog) return { max: Infinity, detail: "no WebGL program" };
    const b = c.getBoundingClientRect();
    const k = c.height / b.height;
    const n = gl.getUniform(prog, gl.getUniformLocation(prog, "uGlassCount"));
    const shader = [];
    for (let i = 0; i < n; i++) {
      const g = gl.getUniform(prog, gl.getUniformLocation(prog, `uGlassRects[${i}]`));
      shader.push([b.left + g[0] / k, b.bottom - g[1] / k]);
    }
    const dom = [...document.querySelectorAll("[data-water-glass]")]
      .filter((el) => getComputedStyle(el).opacity !== "0")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [el.className.split(" ")[0], r.left + r.width / 2, r.top + r.height / 2];
      });
    const d = dom.map(([name, x, y]) => [name, Math.min(...shader.map(([sx, sy]) => Math.hypot(sx - x, sy - y)))]);
    return { max: Math.max(0, ...d.map((x) => x[1])), detail: d.map(([nm, v]) => `${nm}:${v.toFixed(1)}`).join(" ") };
  })()))));
}
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
  if (vp.width >= 1440) check(`${vp.name} nav shows all items`, ["Overview", "Menu", "Calendar", "Agent", "Dashboard"].every((n) => navNames.includes(n)), navNames);
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

// Menu 改名 / liquid glass / 自分の予定 (custom plan)
{
  const page = await newPage(WIDTHS[0]);
  await page.goto(BASE + "/explore", { waitUntil: "networkidle" });
  check("/explore redirects to /menu", new URL(page.url()).pathname === "/menu", page.url());
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("glass surfaces = nav + droplet + 4 portal cards", (await page.locator("[data-water-glass]").count()) === 6);
  check("top bar is clear glass", (await page.locator(".global-nav").getAttribute("data-water-glass")) === "clear");
  check("top bar stays sticky under the glass class", (await page.locator(".global-nav").evaluate((el) => getComputedStyle(el).position)) === "sticky");
  check("droplet is out of the link flow", (await page.locator(".nav-droplet").evaluate((el) => getComputedStyle(el).position)) === "absolute");
  check("WebGL glass mode", (await page.evaluate(() => document.documentElement.dataset.water)) === "webgl");
  // pointer tilt が portal card に乗る
  const menuCard = page.locator(".portal-card.slot-menu");
  const box = await menuCard.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.2, { steps: 4 });
  await page.waitForTimeout(250);
  const tilt = await menuCard.evaluate((el) => el.style.getPropertyValue("--tiltY"));
  check("portal card tilts toward the pointer", tilt !== "" && Number.parseFloat(tilt) > 0, tilt);
  await page.screenshot({ path: ".screenshots/home-glass-1440.png" });
  // specular の光源角度が pointer に追従する
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
  const a1 = await page.evaluate(() => document.documentElement.style.getPropertyValue("--glass-light-angle"));
  await page.mouse.move(1400, 880, { steps: 3 });
  await page.waitForTimeout(100);
  const a2 = await page.evaluate(() => document.documentElement.style.getPropertyValue("--glass-light-angle"));
  check("glass light angle follows the pointer", a1 !== "" && a2 !== "" && a1 !== a2, `${a1} → ${a2}`);
  await page.mouse.move(5, 5);

  // 選択しずく: Overview → Menu へばねで移動し、active link の中心に止まる
  const center = async (loc) => {
    const b = await loc.boundingBox();
    return b ? b.x + b.width / 2 : NaN;
  };
  const droplet = page.locator(".nav-droplet");
  check("droplet under Overview", Math.abs((await center(droplet)) - (await center(page.locator(".nav-link.is-active").first()))) <= 2);
  await page.locator("nav[aria-label=Primary]").getByRole("link", { name: "Menu" }).click();
  await page.waitForTimeout(160);
  await page.screenshot({ path: ".screenshots/nav-droplet-moving-1440.png", clip: { x: 0, y: 0, width: 1440, height: 120 } });
  await page.waitForTimeout(700);
  const dMenu = await center(droplet);
  const lMenu = await center(page.locator("nav[aria-label=Primary] .nav-link.is-active").first());
  check("droplet settles under Menu", Math.abs(dMenu - lMenu) <= 2, `${dMenu} vs ${lMenu}`);
  await page.screenshot({ path: ".screenshots/nav-droplet-menu-1440.png", clip: { x: 0, y: 0, width: 1440, height: 120 } });
  await page.getByRole("link", { name: "Settings" }).click();
  await page.waitForTimeout(400);
  check("droplet hidden without an active nav item", (await droplet.evaluate((el) => getComputedStyle(el).opacity)) === "0");
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  await page.locator(".home-card .month-cell-hit").nth(15).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "+ Add plan" }).click();
  await dialog.getByRole("radio", { name: "TGE / launch" }).click();
  await dialog.getByLabel("What's happening").fill("E2E TGE");
  await dialog.getByRole("button", { name: "Add plan", exact: true }).click();
  check("plan appears in the day dialog", await dialog.getByText("E2E TGE").isVisible());
  await page.screenshot({ path: ".screenshots/home-plan-1440.png" });
  await page.keyboard.press("Escape");
  check("plan chip shows its emoji", ((await page.locator(".home-card .event-chip", { hasText: "E2E TGE" }).first().innerText()) ?? "").includes("🚀"));
  await page.reload({ waitUntil: "networkidle" });
  check("plan survives reload", (await page.locator(".home-card .event-chip", { hasText: "E2E TGE" }).count()) === 1);
  await page.goto(BASE + "/calendar?view=list", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: ".screenshots/calendar-list-1440.png" });
  check("no page errors (menu / glass / plan)", page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}

// WebGL の glass (光・縁) が DOM の枠に常に重なる: scroll / route 遷移 / WAAPI / しずくの移動中
{
  const page = await newPage({ width: 1512, height: 862 }, { deviceScaleFactor: 2 });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  let d = await glassDrift(page);
  check("glass aligned at rest (Home)", d.max <= 1, d.detail);
  // pointer が glass の上を動き続けても (style 書き込み → 再計算が毎 frame 走っても) 水面の描画は止まらない
  const uTime = () =>
    page.evaluate(() => {
      const c = document.querySelector(".water-canvas canvas");
      const gl = c.getContext("webgl");
      const prog = gl.getParameter(gl.CURRENT_PROGRAM);
      return gl.getUniform(prog, gl.getUniformLocation(prog, "uTime"));
    });
  const t0 = await uTime();
  for (let i = 0; i < 12; i++) await page.mouse.move(200 + i * 60, 50 + (i % 2) * 10, { steps: 3 });
  const t1 = await uTime();
  check("water keeps drawing while the pointer moves over glass", t1 - t0 > 0.1, `${t0.toFixed(2)} → ${t1.toFixed(2)}`);
  d = await glassDrift(page);
  check("glass aligned while hovering the top bar", d.max <= 1, d.detail);
  // イベントを出さない WAAPI の移動 (以前は rect が古いまま残った)
  await page.evaluate(() =>
    document.querySelector(".portal-card.slot-menu").animate([{ translate: "0 0" }, { translate: "0 30px" }], { duration: 150, fill: "forwards" })
  );
  await page.waitForTimeout(400);
  d = await glassDrift(page);
  check("glass follows an event-less WAAPI move", d.max <= 1, d.detail);
  await page.locator("nav[aria-label=Primary]").getByRole("link", { name: "Calendar" }).click();
  await page.waitForTimeout(120);
  d = await glassDrift(page);
  check("glass follows the droplet mid-animation", d.max <= 1, d.detail);
  await page.waitForTimeout(700);
  d = await glassDrift(page);
  check("glass aligned after a route change", d.max <= 1, d.detail);
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(80);
  d = await glassDrift(page);
  check("glass aligned right after scrolling", d.max <= 1, d.detail);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  d = await glassDrift(page);
  check("glass aligned after scrolling back", d.max <= 1, d.detail);
  // rubber band 対策: 水面は fixed (端に帯が出ない)、glass layer はスクロール内容の中の sticky
  // (枠と一緒に動く)。どのスクロール位置でも両方が viewport を覆い、スクロール量は増えない
  // (rubber band 自体は headless で再現できないので実機で確認)
  const cover = () =>
    page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom - innerHeight, position: getComputedStyle(el).position };
      };
      const ui = document.querySelector(".ui-layer");
      return {
        water: box(".water-canvas"),
        glass: box(".glass-canvas"),
        extra: document.documentElement.scrollHeight - (ui.offsetTop + ui.offsetHeight),
      };
    });
  await page.goto(BASE + "/calendar?view=timeline&range=all", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  let cv = await cover();
  check(
    "water layer is fixed, glass layer is sticky, both cover the viewport",
    cv.water.position === "fixed" && cv.glass.position === "sticky" && cv.water.top === 0 && cv.glass.top === 0 && Math.abs(cv.glass.bottom) <= 0.5,
    JSON.stringify(cv)
  );
  check("background layers do not add scroll height", cv.extra <= 1, JSON.stringify(cv));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  cv = await cover();
  check("glass layer still covers the viewport at the bottom", Math.abs(cv.glass.top) <= 0.5 && Math.abs(cv.glass.bottom) <= 0.5, JSON.stringify(cv)); // sub-pixel の丸めは許容
  d = await glassDrift(page);
  check("glass aligned at the bottom of a long page", d.max <= 1, d.detail);
  await page.goto(BASE + "/?glass-debug", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("glass-debug overlay renders", (await page.locator(".glass-debug-info").innerText()).includes("shader − DOM"));
  await page.screenshot({ path: ".screenshots/glass-debug-1512.png" });
  check("no page errors (glass alignment)", page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}

// Home の水面に浮かぶキャラクター 2 匹: 左右の空き水面で漂い、shader に波紋と影の位置が渡る
async function friendsState(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    const cards = [...document.querySelectorAll(".portal-card")].map((c) => c.getBoundingClientRect());
    const friends = [...document.querySelectorAll(".floater")].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r, opacity: getComputedStyle(el).opacity };
    });
    const overlap = friends.some((f) => cards.some((c) => f.r.left < c.right && f.r.right > c.left && f.r.top < c.bottom && f.r.bottom > c.top));
    const c = document.querySelector(".water-canvas canvas");
    const gl = c?.getContext("webgl");
    const prog = gl?.getParameter(gl.CURRENT_PROGRAM);
    let shader = [];
    if (prog) {
      const b = c.getBoundingClientRect();
      const k = c.height / b.height;
      const n = gl.getUniform(prog, gl.getUniformLocation(prog, "uFloaterCount"));
      for (let i = 0; i < n; i++) {
        const f = gl.getUniform(prog, gl.getUniformLocation(prog, `uFloaters[${i}]`));
        shader.push([b.left + f[0] / k, b.bottom - f[1] / k]);
      }
    }
    const drift = Math.max(0, ...friends.map((f) => Math.min(...shader.map(([sx, sy]) => Math.hypot(sx - f.x, sy - f.y)))));
    resolve({ friends: friends.map((f) => [Math.round(f.x), Math.round(f.y), f.opacity]), overlap, shaderCount: shader.length, drift });
  })));
}
for (const vp of WIDTHS) {
  const page = await newPage(vp);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const a = await friendsState(page);
  check(`${vp.name} two friends float on the Home water`, a.friends.length === 2 && a.friends.every((f) => f[2] === "1"), JSON.stringify(a.friends));
  check(`${vp.name} friends stay in the open water (no card overlap)`, !a.overlap, JSON.stringify(a.friends));
  check(`${vp.name} shader draws ripples / shadow at the friends`, a.shaderCount === 2 && a.drift <= 1, `count=${a.shaderCount} drift=${a.drift.toFixed(2)}`);
  await page.waitForTimeout(1000);
  const b = await friendsState(page);
  check(`${vp.name} friends drift`, a.friends.some((f, i) => Math.hypot(f[0] - b.friends[i][0], f[1] - b.friends[i][1]) >= 1), `${JSON.stringify(a.friends)} → ${JSON.stringify(b.friends)}`);
  if (vp.width >= 1440) await page.screenshot({ path: `.screenshots/home-friends-${vp.name}.png` });
  await page.locator("nav[aria-label=Primary]").getByRole("link", { name: "Menu" }).click();
  await page.waitForTimeout(400);
  const m = await friendsState(page);
  check(`${vp.name} no friends and no ripples off Home`, m.friends.length === 0 && m.shaderCount === 0, JSON.stringify(m));
  check(`${vp.name} no page errors (friends)`, page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}
{
  const page = await newPage(WIDTHS[0], { reducedMotion: "reduce" });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const a = await friendsState(page);
  await page.waitForTimeout(1000);
  const b = await friendsState(page);
  check("reduced motion → friends rest still", a.friends.length === 2 && JSON.stringify(a.friends) === JSON.stringify(b.friends), `${JSON.stringify(a.friends)} → ${JSON.stringify(b.friends)}`);
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

// 常時表示の scrollbar (macOS「常に表示」/ Windows): canvas と glass rect は scrollbar を除いた
// 実寸で計算する (innerWidth / innerHeight を使うと shader の glass が DOM から上にずれる)
{
  const b = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], args });
  const page = await b.newPage({ viewport: { width: 1512, height: 862 }, deviceScaleFactor: 2 });
  await page.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "html{overflow:scroll} ::-webkit-scrollbar{width:15px;height:15px}";
      document.head.append(st);
    })
  );
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const m = await page.evaluate(() => {
    const c = document.querySelector(".water-canvas canvas");
    const host = document.querySelector(".water-canvas").getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio, 1.25);
    return { cw: c.width, ch: c.height, want: [Math.round(host.width * dpr), Math.round(host.height * dpr)], hostW: host.width, clientW: document.documentElement.clientWidth };
  });
  check("canvas matches its host box (viewport minus scrollbars)", m.cw === m.want[0] && m.ch === m.want[1] && m.hostW === m.clientW, JSON.stringify(m));
  await b.close();
}

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
