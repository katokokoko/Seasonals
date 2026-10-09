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
  if (vp.width >= 1440) check(`${vp.name} nav shows all items`, ["Overview", "Menu", "Calendar", "Agent", "Dashboard", "Learn"].every((n) => navNames.includes(n)), navNames);
  else {
    await page.getByRole("button", { name: "More", exact: true }).click();
    const more = await page.locator(".nav-more-menu a").allInnerTexts();
    check(`${vp.name} More menu holds Agent, Dashboard & Learn`, more.includes("Agent") && more.includes("Dashboard") && more.includes("Learn"), more);
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
  // 日付の帯 (上端 26px) を押す。中央は実データの event chip が重なり、chip がクリックを取る
  const dateStrip = { position: { x: 10, y: 12 } };
  await cell.click(dateStrip);
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
  await cell.click(dateStrip);
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

// Menu: Pendle は PT / YT のペア、バッジは Pendle ロゴの下、chain ロゴは上、名前は 1 行
{
  const page = await newPage(WIDTHS[0]);
  await page.goto(BASE + "/menu", { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "PT/YT", exact: true }).click({ timeout: 30_000 }).catch(() => {});
  await page.locator(".token-kind").first().waitFor({ timeout: 30_000 }).catch(() => {});
  const pt = await page.locator(".token-kind-pt").count();
  const yt = await page.locator(".token-kind-yt").count();
  check("Menu shows Pendle PT and YT cards", pt > 0 && pt === yt, `pt=${pt} yt=${yt}`);
  const order = await page.locator(".menu-media").first().evaluate((el) => [...el.children].map((c) => c.className.split(" ")[0]));
  check("chain logo above protocol logo, PT/YT badge below", JSON.stringify(order) === JSON.stringify(["menu-media-chain", "protocol-badge", "token-kind"]), order);
  const wrapped = await page.locator(".menu-item-name h3").evaluateAll((els) =>
    els.filter((h) => h.getBoundingClientRect().height > parseFloat(getComputedStyle(h).lineHeight) * 1.5).map((h) => h.textContent)
  );
  check("Pendle card names stay on one line", wrapped.length === 0, wrapped.join(", "));
  await page.close();
}

// Menu: 「Deposited only」と deposit / withdraw のプラン (公開 mainnet address を watch、fork 実行はしない)
{
  const page = await newPage(WIDTHS[0]);
  const watchlist = [{ chain: "ethereum", address: "0xA7a71E78128F6e3f6dB404ec47806E472F280ef8" }];
  await page.addInitScript((v) => localStorage.setItem("seasonals-web-session-v2", v), JSON.stringify({ state: { watchlist }, version: 0 }));
  await page.goto(BASE + "/menu", { waitUntil: "networkidle" });
  const all = await page.locator(".menu-item").count();
  await page.getByRole("button", { name: "Deposited only" }).click();
  await page.locator(".menu-holding").first().waitFor({ timeout: 60_000 }).catch(() => {});
  const shown = await page.locator(".menu-item").count();
  const heldShown = await page.locator(".menu-item .menu-holding").count();
  check("Deposited only narrows the menu to held products", shown > 0 && shown < all && heldShown === shown, `all=${all} shown=${shown} held=${heldShown}`);
  // 絞り込みを外してから sUSDe を選ぶ (watch している address の保有は mainnet 次第で変わる)
  await page.getByRole("button", { name: "Deposited only" }).click();
  const card = page.locator(".menu-item", { hasText: "sUSDe" }).first();
  await card.getByRole("button", { name: "Deposit" }).click();
  await card.getByLabel("Amount").fill("1");
  await card.getByRole("button", { name: "Build plan" }).click();
  const planOrError = await card.locator(".plan-steps, .error").first().waitFor({ timeout: 60_000 }).then(() => card.locator(".plan-steps, .error").first().innerText()).catch((e) => String(e));
  check("Menu deposit builds a plan or a clear on-chain refusal", planOrError.length > 0 && !/Timeout/.test(planOrError), planOrError.slice(0, 120));
  await page.close();
}

// Connect wallet: EIP-6963 で名乗った wallet を全部並べ、window.ethereum を奪った wallet (OKX 役) ではなく
// 選んだ wallet (MetaMask 役) に eth_requestAccounts が行く。本物の拡張は入れず、名乗る provider を偽装する
{
  const page = await newPage(WIDTHS[0]);
  await page.addInitScript(() => {
    const icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" rx="2"/></svg>');
    window.__walletCalls = [];
    const make = (name, rdns, account) => ({
      info: { uuid: rdns, name, icon, rdns },
      provider: {
        request: async ({ method }) => (window.__walletCalls.push(`${name}:${method}`), [account]),
        on() {},
        removeListener() {},
      },
    });
    const okx = make("OKX Wallet", "com.okex.wallet", "0x2222222222222222222222222222222222222222");
    const mm = make("MetaMask", "io.metamask", "0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11");
    window.ethereum = okx.provider;
    window.addEventListener("eip6963:requestProvider", () => {
      for (const w of [okx, mm]) window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze(w) }));
    });
  });
  await page.goto(BASE + "/menu", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Connect wallet/ }).click();
  const names = await page.locator(".wallet-choice-name").allInnerTexts();
  check("Connect wallet lists every EIP-6963 wallet", names.join(",") === "OKX Wallet,MetaMask", names.join(","));
  await page.screenshot({ path: ".screenshots/wallet-choices-1440.png" });
  await page.getByRole("button", { name: /MetaMask/ }).click();
  await page.locator(".wallet-button.is-active").waitFor({ timeout: 10_000 }).catch(() => {});
  const header = await page.locator(".wallet-button").innerText();
  const calls = await page.evaluate(() => window.__walletCalls);
  check(
    "choosing MetaMask connects its account, not the window.ethereum wallet",
    header.includes("0x1121…0a11") && calls.join(",") === "MetaMask:eth_requestAccounts",
    `${header.replace(/\s+/g, " ")} | ${calls.join(",")}`
  );
  await page.close();
}

// Solana wallet (Wallet Standard): 偽 wallet を wallet-standard:register-wallet で名乗らせ、接続 → reload で silent 再接続。
// 本物の拡張は入れない。signTransaction は常に拒否 (4001) するので、何も署名・送信されない
const SOLANA_FAKE_WALLET = () => {
  const icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>');
  const address = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  window.__solCalls = [];
  const account = { address, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: ["solana:signTransaction"] };
  const wallet = {
    version: "1.0.0",
    name: "Fake Phantom",
    icon,
    chains: ["solana:mainnet"],
    accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async (input) => (window.__solCalls.push(`connect:${input?.silent ? "silent" : "prompt"}`), { accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => {
          window.__solCalls.push(`sign:${inputs.length}`);
          // 既定は拒否。network を route で差し替えた block だけ "sign" にして、末尾に 0xff を足した bytes を返す
          if (window.__solSignMode === "sign") return inputs.map((i) => ({ signedTransaction: Uint8Array.from([...i.transaction, 0xff]) }));
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        },
      },
    },
  };
  const callback = ({ register }) => register(wallet);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  } catch {}
  window.addEventListener("wallet-standard:app-ready", ({ detail }) => callback(detail));
};
{
  const page = await newPage(WIDTHS[0]);
  await page.addInitScript(SOLANA_FAKE_WALLET);
  await page.goto(BASE + "/settings", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Connect wallet/ }).click();
  const solNames = await page.getByRole("list", { name: "Detected Solana wallets" }).locator(".wallet-choice-name").allInnerTexts();
  check("Connect wallet lists Wallet Standard Solana wallets", solNames.join(",") === "Fake Phantom", solNames.join(","));
  await page.getByRole("button", { name: /Fake Phantom/ }).click();
  await page.locator(".wallet-button.is-active").waitFor({ timeout: 10_000 }).catch(() => {});
  const header = await page.locator(".wallet-button").innerText();
  check("Solana wallet connects its base58 account", header.includes("7xKX") && !header.includes("watching"), header.replace(/\s+/g, " "));
  await page.screenshot({ path: ".screenshots/wallet-solana-1440.png" });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".wallet-button.is-active").waitFor({ timeout: 10_000 }).catch(() => {});
  const calls = await page.evaluate(() => window.__solCalls);
  const header2 = await page.locator(".wallet-button").innerText();
  check("reload reconnects the Solana wallet silently", calls.join(",") === "connect:silent" && header2.includes("7xKX"), `${calls.join(",")} | ${header2.replace(/\s+/g, " ")}`);
  check("Solana wallet pages have no errors", page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}

// Solana Menu deposit (SOL_E2E=1、BFF に HELIUS_API_KEY が要る): 実 mainnet の public address を名乗る偽 wallet で
// Jupiter Lend USDC に 0.1 USDC → BFF が unsigned tx を組む → wallet prompt → 偽 wallet が拒否 (4001)。
// 署名も送信も起きないことを /tx/submit が 0 回であることで確かめる
if (process.env.SOL_E2E === "1") {
  const page = await newPage(WIDTHS[0]);
  await page.addInitScript(SOLANA_FAKE_WALLET);
  const submits = [];
  page.on("request", (r) => r.url().includes("/tx/submit") && submits.push(r.url()));
  await page.goto(BASE + "/menu", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Connect wallet/ }).click();
  await page.getByRole("button", { name: /Fake Phantom/ }).click();
  await page.locator(".wallet-button.is-active").waitFor({ timeout: 10_000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.getByRole("group", { name: "Chain" }).getByRole("button", { name: "Solana" }).click();
  const card = page.locator(".menu-item").filter({ has: page.locator(".menu-item-protocol", { hasText: /^Jupiter/ }) }).filter({ has: page.locator("h3", { hasText: "USDC" }) }).first();
  await card.getByRole("button", { name: "Deposit" }).click();
  await card.getByText(/Wallet balance:/).waitFor({ timeout: 60_000 }).catch(() => {});
  check("Solana deposit panel reads the wallet balance", /Wallet balance: [0-9.]+ USDC/.test(await card.innerText()), (await card.innerText()).slice(0, 200));
  await card.getByLabel("Amount").fill("0.1");
  const cta = card.getByRole("button", { name: "Sign in wallet" });
  // oracle が blocked (§4.6 fail-closed) なら CTA は押せないまま。その時は「止まること」だけを確かめ、署名経路は検証済みと言わない
  await Promise.race([
    page.waitForFunction((el) => el && !el.disabled, await cta.elementHandle(), { timeout: 60_000 }),
    card.getByText(/Blocked for safety/).waitFor({ timeout: 60_000 }),
  ]).catch(() => {});
  if (await card.getByText(/Blocked for safety/).isVisible()) {
    check("Solana deposit stays fail-closed while the price oracle is blocked", await cta.isDisabled(), (await card.locator(".oracle-gate").innerText()).slice(0, 160));
    console.error("NOTE: oracle blocked on this BFF; the build → wallet prompt path was NOT exercised in this run");
  } else {
    await cta.click();
    const outcome = await card
      .locator(".sign-result")
      .getByText(/Cancelled in your wallet|Nothing was signed|failed|error/i)
      .first()
      .waitFor({ timeout: 90_000 })
      .then(() => card.locator(".sign-result").innerText())
      .catch((e) => String(e));
    const calls = await page.evaluate(() => window.__solCalls);
    check(
      "Solana deposit builds on the BFF, prompts the wallet once, and sends nothing when rejected",
      /Cancelled in your wallet/.test(outcome) && calls.includes("sign:1") && submits.length === 0,
      `${outcome.replace(/\s+/g, " ").slice(0, 160)} | ${calls.join(",")} | submits=${submits.length}`
    );
  }
  await page.screenshot({ path: ".screenshots/menu-solana-deposit-1440.png" });
  check("Solana menu deposit has no page errors", page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}

// Solana 署名 → 送信 → 確認の画面の流れ (network は page.route で差し替え。BFF にも mainnet にも触れない):
// oracle ok → deposit-tx が tx を 1 本 → 偽 wallet が署名 → /tx/submit (skipPreflight なし) → /tx/status が confirmed
{
  const page = await newPage(WIDTHS[0]);
  await page.addInitScript(SOLANA_FAKE_WALLET);
  await page.addInitScript(() => (window.__solSignMode = "sign"));
  const submits = [];
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/oracle/status**", (r) => r.fulfill(json({ asset_symbol: "USDC", status: "ok", primary: "pyth", price_usd: "1.00000000", warnings: [], block_reason: null })));
  await page.route("**/api/positions?wallet=**", (r) => r.fulfill(json([{ protocol_id: "wallet_holding", asset_symbol: "USDC", current_amount: "5000000" }])));
  await page.route("**/api/protocols/swap-earn/deposit-tx", (r) =>
    r.fulfill(json({ swapTransaction: Buffer.from([1, 2, 3, 250]).toString("base64"), lastValidBlockHeight: 1, outAmount: "1", outputMint: "x", quote: {} }))
  );
  await page.route("**/api/tx/submit", (r) => {
    submits.push(JSON.parse(r.request().postData() ?? "{}"));
    return r.fulfill(json({ signature: String(submits.length).repeat(87) }));
  });
  await page.route("**/api/tx/status**", (r) => r.fulfill(json({ signature: new URL(r.request().url()).searchParams.get("signature"), status: "confirmed", slot: 1, err: null })));
  await page.goto(BASE + "/menu", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Connect wallet/ }).click();
  await page.getByRole("button", { name: /Fake Phantom/ }).click();
  await page.locator(".wallet-button.is-active").waitFor({ timeout: 10_000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.getByRole("group", { name: "Chain" }).getByRole("button", { name: "Solana" }).click();
  const card = page.locator(".menu-item").filter({ has: page.locator(".menu-item-protocol", { hasText: /^Jupiter/ }) }).filter({ has: page.locator("h3", { hasText: "USDC" }) }).first();
  await card.getByRole("button", { name: "Deposit" }).click();
  await card.getByLabel("Amount").fill("1.5");
  const cta = card.getByRole("button", { name: "Sign in wallet" });
  await page.waitForFunction((el) => el && !el.disabled, await cta.elementHandle(), { timeout: 20_000 }).catch(() => {});
  await cta.click();
  const done = await card.getByText("Confirmed on Solana mainnet.").waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  const calls = await page.evaluate(() => window.__solCalls);
  check(
    "Solana sign → submit → confirm flow in the browser (network stubbed)",
    done && calls.includes("sign:1") && submits.length === 1 && submits[0].signedTx === Buffer.from([1, 2, 3, 250, 255]).toString("base64") && submits[0].skipPreflight === false,
    `${done} | ${calls.join(",")} | ${JSON.stringify(submits)}`
  );
  const link = await card.locator(".sign-txs a").getAttribute("href").catch(() => null);
  check("confirmed tx links to Solscan", link === `https://solscan.io/tx/${"1".repeat(87)}`, String(link));
  await page.screenshot({ path: ".screenshots/menu-solana-signed-1440.png" });
  check("Solana signed flow has no page errors", page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}

// Solana agent plan inbox (/agent、SOL_E2E=1): Agent が作った pending_user の plan を web で Approve & sign →
// BFF (route で差し替え) が token と unsigned tx 1 本を返す → 偽 wallet が拒否 (4001) → web が /failed を報告し card が Failed になる。
// network はすべて page.route で差し替える (BFF の plan store にも mainnet にも触れない)
if (process.env.SOL_E2E === "1") {
  const page = await newPage(WIDTHS[0]);
  await page.addInitScript(SOLANA_FAKE_WALLET);
  const owner = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  let plan = {
    plan_id: "plan_e2e",
    user_id: "user_e2e",
    mcp_client_id: "claude",
    objective: "max_yield",
    constraints: {},
    candidate_actions: [],
    selected_action: { wallet_id: owner, action_type: "deposit", protocol: "jupiter", asset: "USDC", amount: "1500000", metadata: { pool_id: "jupiter_usdc" } },
    simulation_result: {
      simulation_id: "sim_e2e",
      estimated_out: "1480000",
      estimated_fee: "5000",
      bundle_hash: "0x" + "cd".repeat(32),
      oracle: { primary: "pyth", primary_age_seconds: 4, divergence_pct: 0.1, warnings: [] },
    },
    status: "pending_user",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const posts = [];
  const submits = [];
  await page.route(/\/api\/agent-plans(\?|\/|$)/, (r) => {
    const req = r.request();
    const u = new URL(req.url());
    if (req.method() === "GET" && u.pathname === "/api/agent-plans") return r.fulfill(json(u.searchParams.get("wallet") === owner ? [plan] : []));
    const m = u.pathname.match(/^\/api\/agent-plans\/([^/]+)\/(approve|execute|signatures|failed|reject)$/);
    if (req.method() !== "POST" || !m || m[1] !== plan.plan_id) return r.fulfill(json({ error: "not_found" }, 404));
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    posts.push({ action: m[2], body });
    if (m[2] === "approve") {
      plan = { ...plan, status: "approved", approved_by: "user" };
      const now = new Date().toISOString();
      const token = { token_id: "tok_e2e", user_id: "user_e2e", plan_id: plan.plan_id, mcp_client_id: "claude", bundle_hash: plan.simulation_result.bundle_hash, issued_at: now, expires_at: new Date(Date.now() + 300_000).toISOString(), consumed_at: null };
      return r.fulfill(json({ ...plan, approval_token: token }));
    }
    if (m[2] === "execute") {
      plan = { ...plan, status: "executing" };
      return r.fulfill(
        json({ execution_id: "exec_e2e", status: "awaiting_signature", plan, unsigned_transactions: [{ index: 0, label: "deposit", tx_base64: Buffer.from([1, 2, 3, 250]).toString("base64") }] })
      );
    }
    if (m[2] === "failed") plan = { ...plan, status: "failed", failure_reason: body?.reason };
    if (m[2] === "signatures") plan = { ...plan, status: "broadcasted" };
    if (m[2] === "reject") plan = { ...plan, status: "rejected" };
    return r.fulfill(json(plan));
  });
  await page.route("**/api/tx/submit", (r) => {
    submits.push(r.request().postData());
    return r.fulfill(json({ error: "unexpected" }, 500));
  });
  await page.goto(BASE + "/agent", { waitUntil: "networkidle" });
  await page.locator(".wallet-button").click();
  await page.getByRole("button", { name: /Fake Phantom/ }).click();
  await page.locator(".wallet-button.is-active").waitFor({ timeout: 10_000 }).catch(() => {});
  await page.keyboard.press("Escape");
  const card = page.locator("section.proposal-card", { hasText: "Agent plan · Solana mainnet" }).first();
  await card.waitFor({ timeout: 20_000 }).catch(() => {});
  const head = await card.innerText().catch((e) => String(e));
  check("Solana agent plan card shows the pending plan", /Needs your approval/.test(head) && /Deposit 1\.5 USDC/.test(head), head.replace(/\s+/g, " ").slice(0, 200));
  await card.getByRole("button", { name: "Approve & sign" }).click().catch(() => {});
  const failedShown = await card.locator(".tag", { hasText: /^Failed$/ }).waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  const calls = await page.evaluate(() => window.__solCalls);
  const failed = posts.find((p) => p.action === "failed");
  check(
    "Solana agent plan: approve → execute → wallet declines → /failed reported, card shows Failed, nothing sent",
    failedShown &&
      posts.map((p) => p.action).join(",") === "approve,execute,failed" &&
      posts[1].body?.approval_token === "tok_e2e" &&
      posts[1].body?.via === "web" &&
      failed?.body?.execution_id === "exec_e2e" &&
      failed?.body?.reason === "user_cancelled" &&
      calls.includes("sign:1") &&
      submits.length === 0,
    `${failedShown} | ${JSON.stringify(posts)} | ${calls.join(",")} | submits=${submits.length}`
  );
  await page.screenshot({ path: ".screenshots/agent-solana-plan-failed-1440.png" });
  check("Solana agent plan inbox has no page errors", page.errors.length === 0, page.errors.join(" | "));
  await page.close();
}

// Learn: 横 3 枚のカード、/learn#pendle で詳細 dialog が開き見出しに focus、Esc で閉じる。
// chain chip (All chains / Solana / Ethereum) で絞り込み、絞り込みで隠れた guide への deep link は chip を切り替えて開く
for (const vp of WIDTHS) {
  const page = await newPage(vp);
  await page.goto(BASE + "/learn", { waitUntil: "networkidle" });
  const tops = await page.locator(".learn-card").evaluateAll((els) => els.slice(0, 3).map((e) => Math.round(e.getBoundingClientRect().top)));
  check(`${vp.name} Learn shows three cards per row`, tops.length === 3 && new Set(tops).size === 1, tops.join(","));
  await page.close();
}
{
  const page = await newPage(WIDTHS[0]);
  await page.goto(BASE + "/learn#pendle", { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "Pendle" }).waitFor({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  const focused = await page.evaluate(() => document.activeElement?.id);
  check("Learn deep link opens the guide and focuses its title", focused === "learn-pendle-title", String(focused));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("Esc closes the Learn guide and clears the hash", (await page.getByRole("dialog").count()) === 0 && !page.url().includes("#"), page.url());

  // chain chip (dialog が開いている間は chip を押せないので Esc の後)
  const chips = page.getByRole("group", { name: "Chain", exact: true });
  const chip = (name) => chips.getByRole("button", { name, exact: true });
  const chipNames = (await chips.locator("button.filter-chip").allInnerTexts()).map((t) => t.trim());
  check("Learn chain chips are All chains / Solana / Ethereum", chipNames.join(",") === "All chains,Solana,Ethereum", chipNames.join(","));
  // chip を押した後、card の入れ替わりを待ってから数える
  const cardCount = async () => {
    await page.waitForTimeout(300);
    return page.locator(".learn-card:visible").count();
  };
  const siteLinks = () => page.locator(".learn-card:visible a", { hasText: "Open site" }).evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const allHttps = (hrefs, n) => hrefs.length === n && hrefs.every((h) => h?.startsWith("https://"));
  const all = await cardCount();
  // Esc で focus が Pendle の Details に戻り page が scroll している。浮遊ナビが full-page 画像の途中に写らないよう上端へ戻す
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({ path: ".screenshots/learn-all-1440.png", fullPage: true });
  // 12 / 6 は src/learn/content.ts の Solana / Ethereum の guide 数 (protocol を足したらここも更新する)
  await chip("Solana").click();
  const sol = await cardCount();
  const solSites = await siteLinks();
  check("Learn Solana chip shows 12 guides, each with an https Open site link", sol === 12 && allHttps(solSites, sol), `${sol} | ${solSites.join(" ")}`);
  await page.screenshot({ path: ".screenshots/learn-solana-1440.png", fullPage: true });
  await chip("Ethereum").click();
  const eth = await cardCount();
  const ethSites = await siteLinks();
  check("Learn Ethereum chip shows 6 guides, each with an https Open site link", eth === 6 && allHttps(ethSites, eth), `${eth} | ${ethSites.join(" ")}`);
  await page.screenshot({ path: ".screenshots/learn-ethereum-1440.png", fullPage: true });
  // Ethereum で絞り込み中に Solana の guide へ deep link (Menu の「Learn」相当) → chip が Solana に切り替わって開く。
  // hash の変更は popstate で router に届く
  await page.evaluate(() => {
    location.hash = "#jupiter";
  });
  const jupiter = page.getByRole("dialog", { name: "Jupiter" });
  await jupiter.waitFor({ timeout: 5_000 }).catch(() => {});
  const solPressed = await chip("Solana").getAttribute("aria-pressed");
  check("Learn deep link to a filtered-out guide switches the chip and opens it", (await jupiter.count()) === 1 && solPressed === "true", `dialog=${await jupiter.count()} | Solana aria-pressed=${solPressed}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await chip("All chains").click();
  const back = await cardCount();
  check("Learn All chains shows every guide (Solana + Ethereum)", all === sol + eth && back === all, `all=${all} sol=${sol} eth=${eth} back=${back}`);
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
  // Home の portal card は水の blob (droplet glass): lens は glass layer が描き、水面 layer には集光用に droplet の rect だけが入る
  check("portal cards are droplet glass", (await page.locator(".portal-card[data-water-glass=droplet]").count()) === 4);
  const dropletLayers = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    const read = (sel) => {
      const c = document.querySelector(sel);
      const gl = c?.getContext("webgl");
      const p = gl?.getParameter(gl.CURRENT_PROGRAM);
      if (!p) return null;
      const n = gl.getUniform(p, gl.getUniformLocation(p, "uGlassCount"));
      let drops = 0;
      for (let i = 0; i < n; i++) drops += gl.getUniform(p, gl.getUniformLocation(p, `uGlassShape[${i}]`))[1] > 0.5 ? 1 : 0;
      return { n, drops, lens: gl.getUniform(p, gl.getUniformLocation(p, "uGlassLens")) };
    };
    resolve({ water: read(".water-canvas canvas"), glass: read(".glass-canvas canvas") });
  })));
  check(
    "droplet cards: glass layer draws the lenses, water layer only casts their light pools",
    dropletLayers.glass?.lens === 1 && dropletLayers.glass?.drops === 4 && dropletLayers.water?.lens === 0 && dropletLayers.water?.n === 4 && dropletLayers.water?.drops === 4,
    JSON.stringify(dropletLayers)
  );
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
  await page.waitForTimeout(2600); // 浮かび上がり (1.8 秒) の後
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
