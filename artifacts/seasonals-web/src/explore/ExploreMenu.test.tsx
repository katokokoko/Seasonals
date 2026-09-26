import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { MenuProduct } from "@workspace/lib/types";
import { EthMenuCard, noBreakHyphen } from "./ExploreMenu";

function product(p: Partial<MenuProduct>): MenuProduct {
  return {
    id: "ethereum:pendle:pt:0x1",
    chain: "ethereum",
    protocolId: "pendle",
    protocolName: "Pendle",
    name: "PT-apyUSD",
    category: "pt_yt",
    tokenKind: "pt",
    rate: { label: "Fixed APY", value: 0.1459, basis: "Fixed if held to maturity", source: "Pendle API" },
    facts: [],
    maturity: "2026-11-05T00:00:00.000Z",
    observedAt: "2026-09-26T00:00:00.000Z",
    ...p,
  };
}

function renderCard(p: MenuProduct) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ul>
        <EthMenuCard product={p} />
      </ul>
    </QueryClientProvider>
  );
}

test("PT card stacks chain logo above the Pendle logo and the PT badge below it", () => {
  const { container } = renderCard(product({}));
  const media = container.querySelector(".menu-media")!;
  const kids = [...media.children].map((el) => el.className);
  expect(kids[0]).toContain("menu-media-chain");
  expect(kids[1]).toContain("protocol-badge");
  expect(screen.getByRole("img", { name: "Principal Token" }).textContent).toBe("PT");
  expect(screen.getByText("Fixed APY")).toBeTruthy();
  expect(screen.getByText("Fixed if held to maturity · Pendle API")).toBeTruthy();
});

test("YT card shows a negative Long yield APY in the warning color", () => {
  const { container } = renderCard(
    product({ name: "YT-apyUSD", tokenKind: "yt", rate: { label: "Long yield APY", value: -0.7516, basis: "Floating; YT is worth 0 at maturity", source: "Pendle API" } })
  );
  expect(screen.getByRole("img", { name: "Yield Token" })).toBeTruthy();
  expect(container.querySelector(".menu-price-value.negative")?.textContent).toContain("-75.16%");
});

test("names keep the token prefix on one line", () => {
  expect(noBreakHyphen("PT-apyUSD")).toBe("PT‑apyUSD");
  const { container } = renderCard(product({}));
  expect(container.querySelector("h3")?.textContent).toBe("PT‑apyUSD");
});
