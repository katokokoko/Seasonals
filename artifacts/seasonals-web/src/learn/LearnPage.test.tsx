import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import LearnPage from "./LearnPage";
import { LEARN } from "./content";

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: "/learn", element: <LearnPage /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
}

test("one large card per protocol with Open site to the official site", () => {
  renderAt("/learn");
  expect(screen.getAllByRole("article")).toHaveLength(LEARN.length);
  const sites = screen.getAllByRole("link", { name: /Open site/ }).map((a) => a.getAttribute("href"));
  expect(sites).toEqual(LEARN.map((e) => e.site));
  screen.getAllByRole("link", { name: /Open site|Docs/ }).forEach((a) => {
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer");
  });
});

test("a #hash deep link focuses that protocol's title", () => {
  Element.prototype.scrollIntoView = () => {};
  renderAt("/learn#pendle");
  expect(document.activeElement?.id).toBe("learn-pendle-title");
});
