import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { SUPPORTED_CHAINS } from "@workspace/lib/config/chains";
import LearnPage from "./LearnPage";
import { LEARN } from "./content";
import { CHAIN_ORDER, learnEntries } from "./filter";

const loc = { hash: "" };
let nav: NavigateFunction = () => {};
function Probe() {
  loc.hash = useLocation().hash;
  nav = useNavigate();
  return null;
}

function renderAt(path: string) {
  Element.prototype.scrollIntoView = () => {};
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/learn" element={<LearnPage />} />
      </Routes>
      <Probe />
    </MemoryRouter>
  );
}

const chainOf = (id: string) => LEARN.find((e) => e.id === id)!.chain;
const chainChip = (name: string) => within(screen.getByRole("group", { name: "Chain" })).getByRole("button", { name });

test("compact cards for both chains: logo, tagline, three key points, Details and Open site — no long sections", () => {
  renderAt("/learn");
  const cards = screen.getAllByRole("article");
  expect(cards).toHaveLength(LEARN.length);
  const shown = learnEntries("all");
  cards.forEach((card, i) => {
    const e = shown[i]!;
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).getByRole("button", { name: "Details" })).toBeTruthy();
    const site = within(card).getByRole("link", { name: /Open site/ });
    expect(site.getAttribute("href")).toBe(e.site);
    expect(site.getAttribute("rel")).toBe("noreferrer");
  });
  expect(screen.queryByText("How it works")).toBeNull();
});

test("Details opens the full guide as a dialog; Esc closes it and focus returns to Details", async () => {
  renderAt("/learn");
  const card = screen.getByRole("article", { name: "Pendle" });
  const details = within(card).getByRole("button", { name: "Details" });
  details.focus();
  fireEvent.click(details);
  const dialog = screen.getByRole("dialog", { name: "Pendle" });
  for (const t of ["What it is", "How it works", "Strengths", "Things to know", "On your calendar", "In Seasonals"]) {
    expect(within(dialog).getByText(t)).toBeTruthy();
  }
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(details);
});

test("a #hash deep link opens that protocol's guide, and closing clears the hash", () => {
  renderAt("/learn#pendle");
  expect(screen.getByRole("dialog", { name: "Pendle" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(loc.hash).toBe("");
});

test("chain chips come from SUPPORTED_CHAINS and default to All chains", () => {
  renderAt("/learn");
  const chips = within(screen.getByRole("group", { name: "Chain" })).getAllByRole("button");
  expect(chips.map((b) => b.textContent)).toEqual(["All chains", ...SUPPORTED_CHAINS.map((c) => c.name)]);
  expect(chips.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent)).toEqual(["All chains"]);
});

test("under All chains, guides are grouped by chain in CHAIN_ORDER", () => {
  renderAt("/learn");
  const ids = screen.getAllByRole("article").map((a) => a.id);
  expect(ids).toEqual(learnEntries("all").map((e) => e.id));
  // chain ごとにまとまっている = CHAIN_ORDER 上の位置が後戻りしない
  const order = ids.map((id) => CHAIN_ORDER.indexOf(chainOf(id)));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(chainOf(ids[0]!)).toBe(CHAIN_ORDER[0]);
});

test("pressing Solana shows only Solana guides and moves aria-pressed; Ethereum likewise; All restores every guide", () => {
  renderAt("/learn");
  for (const c of SUPPORTED_CHAINS) {
    fireEvent.click(chainChip(c.name));
    expect(chainChip(c.name).getAttribute("aria-pressed")).toBe("true");
    expect(chainChip("All chains").getAttribute("aria-pressed")).toBe("false");
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(LEARN.filter((e) => e.chain === c.id).length);
    cards.forEach((a) => expect(chainOf(a.id)).toBe(c.id));
    if (c.id === "ethereum") expect(screen.getByRole("article", { name: "Pendle" })).toBeTruthy();
  }
  fireEvent.click(chainChip("All chains"));
  expect(chainChip("All chains").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByRole("article")).toHaveLength(LEARN.length);
});

test("a deep link to a guide hidden by the filter switches the filter to its chain and opens it", () => {
  renderAt("/learn");
  fireEvent.click(chainChip("Ethereum"));
  // 特定 protocol に依存しない: 最初の Solana guide を使う
  const target = LEARN.find((e) => e.chain === "solana")!;
  act(() => {
    void nav(`/learn#${target.id}`);
  });
  expect(screen.getByRole("dialog", { name: target.name })).toBeTruthy();
  expect(chainChip("Solana").getAttribute("aria-pressed")).toBe("true");
  screen.getAllByRole("article").forEach((a) => expect(chainOf(a.id)).toBe("solana"));
});
