/**
 * Menu 改名 / Menu セクション名 / 自分の予定 (custom plan) / List = 自分の予定表 の画面テスト。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { dayKey } from "@workspace/lib/derive/timeline";
import { PositionCategory } from "@workspace/lib/types";
import type { ProtocolMenuEntry, TimelineEvent, TimelineEventsResponse } from "@workspace/lib/types";
import { routes } from "./App";
import { useCustomEvents } from "./state/customEvents";

/** lazy route の初回 import は遅い環境がある (Node 25 + transform) */
const LAZY = { timeout: 5000 };

type Fixtures = { "/menu-listings"?: unknown; "/eth/menu"?: unknown; "/eth/public-events"?: unknown };

function renderAt(path: string, fixtures: Fixtures = {}) {
  // fixture の無い endpoint は BFF 未起動と同じく失敗させる (架空データを出さない)
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(fixtures).find(([p]) => url.endsWith(p));
    if (!hit) return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return router;
}

// store を空に戻す (persist は書き込むだけで、rehydrate は store 生成時の 1 回のみ)
beforeEach(() => {
  useCustomEvents.setState({ events: [] });
});

test("/explore redirects to /menu", async () => {
  const router = renderAt("/explore");
  expect(await screen.findByRole("heading", { name: "Menu" }, LAZY)).toBeTruthy();
  expect(router.state.location.pathname).toBe("/menu");
});

test("menu sections are named Yield-bearing stable and PT/YT", async () => {
  const listing: ProtocolMenuEntry[] = [
    {
      protocol_id: "kamino",
      display_name: "Kamino",
      primary_category: PositionCategory.Stable,
      supported_assets: ["USDC"],
      icon_id: "kamino",
      icon_bg: "transparent",
      pools: [
        { pool_id: "k1", name: "USDC Vault", category: PositionCategory.Stable, asset: "USDC", apy: 0.05, tvl_usd: 1000 },
        { pool_id: "k2", name: "PT-USDC", category: PositionCategory.PTYT, asset: "USDC", apy: 0.08, tvl_usd: 1000 },
      ],
    },
  ];
  renderAt("/menu", { "/menu-listings": listing, "/eth/menu": [] });
  expect(await screen.findByRole("tab", { name: "Yield-bearing stable" }, LAZY)).toBeTruthy();
  expect(screen.getByRole("tab", { name: "PT/YT" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Stable yield" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Fixed yield" })).toBeNull();
});

test("a plan added from a Home date shows its emoji, and can be edited and deleted", async () => {
  renderAt("/");
  const cell = screen.getAllByRole("button", { name: /\d{4}/ })[10]!;
  fireEvent.click(cell);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "+ Add plan" }));
  fireEvent.click(within(dialog).getByRole("radio", { name: "Airdrop" }));
  fireEvent.change(within(dialog).getByLabelText("What's happening"), { target: { value: "Jupiter TGE" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add plan" }));

  expect(useCustomEvents.getState().events).toMatchObject([{ title: "Jupiter TGE", emoji: "🪂" }]);
  const item = await within(dialog).findByRole("button", { name: /Jupiter TGE/ });
  expect(item.textContent).toContain("🪂");
  // month grid chip も絵文字 marker
  const chip = document.querySelector(".home-card .event-chip");
  expect(chip?.textContent).toContain("🪂");
  expect(chip?.textContent).toContain("Jupiter TGE");

  // 開くと編集できる
  fireEvent.click(item);
  fireEvent.click(await screen.findByRole("button", { name: "Edit plan" }));
  fireEvent.change(screen.getByLabelText("What's happening"), { target: { value: "Jupiter TGE (moved)" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("heading", { name: "Jupiter TGE (moved)" })).toBeTruthy();

  // 削除は 2 段階
  fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  expect(useCustomEvents.getState().events).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("List shows only your own events and plans; Timeline keeps public events", async () => {
  const now = new Date();
  const day = dayKey(new Date(now.getFullYear(), now.getMonth(), 15));
  const publicEvent: TimelineEvent = {
    id: "ethereum:cca:auction_end:x",
    chain: "ethereum",
    class: "protocol",
    kind: "auction_end",
    protocol: "cca",
    protocolName: "CCA",
    title: "Public auction ends",
    at: new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString(),
    atApprox: false,
    settled: false,
    metrics: [],
    actions: [],
    requiresWallet: false,
    links: [],
    source: "test",
    observedAt: now.toISOString(),
  };
  const res: TimelineEventsResponse = { events: [publicEvent], sources: [{ source: "test", ok: true, observedAt: now.toISOString() }] };
  act(() => {
    useCustomEvents.getState().add({ date: day, title: "My unlock", emoji: "🔓" });
  });

  renderAt(`/calendar?view=list&date=${day}`, { "/eth/public-events": res });
  await screen.findByRole("heading", { name: "Calendar" }, LAZY); // lazy route の mount 待ち
  const content = () => document.querySelector(".workspace-content") as HTMLElement;
  expect(await within(content()).findByText("My unlock")).toBeTruthy();
  expect(within(content()).getByText("Your wallet events and your own plans.", { exact: false })).toBeTruthy();
  expect(within(content()).getAllByText("All day").length).toBeGreaterThan(0);
  // 公開イベントは List に出ない (fetch 完了を待ってから確認)
  await screen.findAllByText("Public auction ends"); // DayPanel (選択日) には出る
  expect(within(content()).queryByText("Public auction ends")).toBeNull();

  // List の説明文にある Timeline リンクから切り替える
  fireEvent.click(within(content()).getByRole("button", { name: "Timeline" }));
  await screen.findByRole("heading", { name: "Timeline" }, LAZY);
  expect(await within(content()).findByText("Public auction ends")).toBeTruthy();
  expect(within(content()).getByText("My unlock")).toBeTruthy();
});
