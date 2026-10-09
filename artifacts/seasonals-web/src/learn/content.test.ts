import { SUPPORTED_CHAINS } from "@workspace/lib/config/chains";
import { fixtureMenuListings } from "@workspace/lib/__fixtures__/menu-listings";
import { protocolLogo } from "../ui/ProtocolBadge";
import { LEARN } from "./content";

// Solana の id = BFF が /menu-listings で返す catalog の protocol_id (Learn id ↔ Menu protocolId の契約をここで固定)
const SOLANA_IDS = fixtureMenuListings.map((p) => p.protocol_id);
const ETHEREUM_IDS = ["lido", "ethena", "pendle", "uniswap", "aqua", "aave"];

const text = (e: (typeof LEARN)[number]) =>
  [e.tagline, ...e.keyPoints, e.whatItIs, ...e.howItWorks, ...e.strengths, ...e.risks, ...e.onYourCalendar, e.inSeasonals].join("\n");

test("covers every Menu protocol on both chains: ids unique and equal to the Ethereum 6 + Solana 12, chain from SUPPORTED_CHAINS, https links", () => {
  const ids = LEARN.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual([...ETHEREUM_IDS, ...SOLANA_IDS].sort());
  const chains = SUPPORTED_CHAINS.map((c) => c.id);
  for (const e of LEARN) {
    expect(chains).toContain(e.chain);
    expect(e.chain).toBe(SOLANA_IDS.includes(e.id) ? "solana" : "ethereum");
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
  // 仕組み上の定数として許すもの: Seasonals の価格 guard の閾値 (Pendle 2% / 5%、USDe peg 0.5%)。
  // 2% / 5% は Solana の oracle gate (Pyth と RedStone の乖離、CLAUDE.md §4) の閾値も兼ねる
  const allowedPct = new Set(["2%", "5%", "0.5%"]);
  for (const e of LEARN) {
    const t = text(e);
    expect(t).not.toMatch(/\$\s?\d/);
    for (const m of t.match(/\d+(\.\d+)?\s?%/g) ?? []) expect(allowedPct.has(m.replace(/\s/g, ""))).toBe(true);
    // 肯定の断定だけを禁止 ("Swap fees are not guaranteed." のような否定は許す)
    expect(t).not.toMatch(/\brisk-free\b|(?<!not )\bguaranteed\b|\b(is|are) safe\b/i);
  }
});

test("every protocol has its logo (no monogram fallback)", () => {
  for (const e of LEARN) expect(protocolLogo(e.id)).toBeTruthy();
});

test("each card has exactly three short key points", () => {
  for (const e of LEARN) {
    expect(e.keyPoints).toHaveLength(3);
    e.keyPoints.forEach((p) => expect(p.length).toBeLessThanOrEqual(120));
  }
});

test("copy matches the chain: Solana guides never claim fork-only execution, Ethereum guides never mention a Solana wallet", () => {
  for (const e of LEARN) {
    // Solana の実行は wallet 署名で mainnet、Ethereum の実行は fork のみ (content.ts 冒頭の規則)
    if (e.chain === "solana") expect(e.inSeasonals).not.toMatch(/\bfork\b/i);
    if (e.chain === "ethereum") expect(e.inSeasonals).not.toMatch(/Solana wallet/);
  }
});
