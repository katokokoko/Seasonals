import { protocolLogo } from "../ui/ProtocolBadge";
import { LEARN } from "./content";

const text = (e: (typeof LEARN)[number]) =>
  [e.tagline, e.whatItIs, ...e.howItWorks, ...e.strengths, ...e.risks, ...e.onYourCalendar, e.inSeasonals].join("\n");

test("covers the six Ethereum protocols, each with official https links and sources", () => {
  expect(LEARN.map((e) => e.id)).toEqual(["lido", "ethena", "pendle", "uniswap", "aqua", "aave"]);
  for (const e of LEARN) {
    expect(e.site).toMatch(/^https:\/\//);
    expect(e.docs).toMatch(/^https:\/\//);
    expect(e.sources.length).toBeGreaterThan(0);
    e.sources.forEach((s) => expect(s).toMatch(/^https:\/\//));
  }
});

test("every guide lists risks and what appears on the calendar", () => {
  for (const e of LEARN) {
    expect(e.risks.length).toBeGreaterThan(0);
    expect(e.onYourCalendar.length).toBeGreaterThan(0);
    expect(e.howItWorks.length).toBeGreaterThanOrEqual(3);
  }
});

test("no live figures in the copy: no dollar amounts, and percentages only for Seasonals' own guard thresholds", () => {
  // 仕組み上の定数として許すもの: Seasonals の価格 guard の閾値 (Pendle 2% / 5%、USDe peg 0.5%)
  const allowedPct = new Set(["2%", "5%", "0.5%"]);
  for (const e of LEARN) {
    const t = text(e);
    expect(t).not.toMatch(/\$\s?\d/);
    for (const m of t.match(/\d+(\.\d+)?\s?%/g) ?? []) expect(allowedPct.has(m.replace(/\s/g, ""))).toBe(true);
    // 肯定の断定だけを禁止 ("Swap fees are not guaranteed." のような否定は許す)
    expect(t).not.toMatch(/\brisk-free\b|(?<!not )\bguaranteed\b|\b(is|are) safe\b/i);
  }
});

test("logos resolve for every protocol except Aave (no logo supplied; monogram)", () => {
  for (const e of LEARN) {
    if (e.id === "aave") expect(protocolLogo(e.id)).toBeNull();
    else expect(protocolLogo(e.id)).toBeTruthy();
  }
});
