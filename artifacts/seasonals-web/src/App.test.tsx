import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { routes } from "./App";

function renderAt(path: string) {
  // BFF 未起動を模擬: fetch は常に失敗 (架空データを出さないことを確認)
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return router;
}

test("global nav reaches every workspace", () => {
  renderAt("/");
  const nav = screen.getByRole("navigation", { name: "Primary" });
  for (const name of ["Overview", "Menu", "Calendar", "Agent", "Dashboard"]) {
    expect(within(nav).getAllByRole("link", { name }).length).toBeGreaterThan(0);
  }
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
});

test("top bar is clear liquid glass with one decorative selection droplet", () => {
  renderAt("/");
  const header = document.querySelector(".global-nav")!;
  expect(header.getAttribute("data-water-glass")).toBe("clear");
  const drops = header.querySelectorAll(".nav-droplet");
  expect(drops).toHaveLength(1);
  expect(drops[0]!.getAttribute("aria-hidden")).toBe("true");
  expect(drops[0]!.getAttribute("data-water-glass")).toBe("clear");
});

test("portal cards are single links to their workspaces", () => {
  renderAt("/");
  expect(screen.getByRole("link", { name: /Agent\s*Your seasonal companion/ }).getAttribute("href")).toBe("/agent");
  expect(screen.getByRole("link", { name: /Menu\s*Explore Seasonals/ }).getAttribute("href")).toBe("/menu");
  expect(screen.getByRole("link", { name: /Setting\s*Make it yours/ }).getAttribute("href")).toBe("/settings");
  expect(screen.getByRole("link", { name: /Dashboard\s*Your seasonal snapshot/ }).getAttribute("href")).toBe("/dashboard");
});

test("calendar/timeline toggle stays on Home and expand follows the mode", () => {
  const router = renderAt("/");
  expect(screen.getByRole("link", { name: "Open full calendar" }).getAttribute("href")).toBe("/calendar?view=month");
  fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
  expect(router.state.location.pathname).toBe("/");
  expect(screen.getByRole("link", { name: "Open full timeline" }).getAttribute("href")).toBe("/calendar?view=timeline");
  expect(screen.queryByRole("button", { name: "Previous month" })).toBeNull();
  expect(screen.getByText("Connect your wallet to see your own positions here.", { exact: false })).toBeTruthy();
});

test("clicking a date opens the detail dialog without navigating, Esc closes it", () => {
  const router = renderAt("/");
  const cell = screen.getAllByRole("button", { name: /\d{4}/ })[10]!;
  fireEvent.click(cell);
  expect(router.state.location.pathname).toBe("/");
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Nothing scheduled.")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
