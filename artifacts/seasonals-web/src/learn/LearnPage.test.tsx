import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import LearnPage from "./LearnPage";
import { LEARN } from "./content";

const loc = { hash: "" };
function Probe() {
  loc.hash = useLocation().hash;
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

test("compact cards: logo, tagline, three key points, Details and Open site — no long sections", () => {
  renderAt("/learn");
  const cards = screen.getAllByRole("article");
  expect(cards).toHaveLength(LEARN.length);
  cards.forEach((card, i) => {
    const e = LEARN[i]!;
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
  const card = screen.getAllByRole("article")[2]!; // Pendle
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
