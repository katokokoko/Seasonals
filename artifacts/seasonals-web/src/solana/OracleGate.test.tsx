/**
 * OracleGate — 複数 mint (funding deposit の [underlying, funding]) を lib mergeOracleResults で 1 つにまとめ、
 * どれか 1 本でも blocked / 取得失敗なら CTA を止める (§4.6 fail-closed)。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { installFakeBff } from "../testing/fakeBff";
import { OracleGate } from "./OracleGate";

const A = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ok = (asset_symbol: string) => ({
  asset_symbol,
  status: "ok",
  primary: "pyth",
  price_usd: "1.00000000",
  tier: "A",
  secondary: { source: "redstone", available: true, price_usd: "1.00000000", age_seconds: 10 },
  warnings: [],
  block_reason: null,
});

function renderGate(mints: string[]) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OracleGate mints={mints}>{(enabled) => <button disabled={!enabled}>Sign</button>}</OracleGate>
    </QueryClientProvider>
  );
}
const cta = () => screen.getByRole("button", { name: "Sign" }) as HTMLButtonElement;

afterEach(cleanup);

test("両方 ok なら通し、両 asset を確認したことを出す", async () => {
  const calls = installFakeBff((p) => (p.includes(A) ? { json: ok("JupUSD") } : p.includes(B) ? { json: ok("USDC") } : undefined));
  renderGate([A, B]);
  await waitFor(() => expect(cta().disabled).toBe(false));
  expect(screen.getByText("Price checked for JupUSD / USDC.")).toBeTruthy();
  expect(calls.filter((c) => c.path.startsWith("/oracle/status"))).toHaveLength(2);
});

test("2 本目だけ blocked でも止める (最悪値に merge)", async () => {
  installFakeBff((p) =>
    p.includes(A) ? { json: ok("JupUSD") } : { json: { ...ok("USDC"), status: "blocked", price_usd: null, block_reason: "oracle_divergence_too_large" } }
  );
  renderGate([A, B]);
  await screen.findByText(/Blocked for safety: Price sources disagree by more than 5%/);
  expect(cta().disabled).toBe(true);
});

test("片方の warning は両方の分を出し、1 秒後に押せる", async () => {
  installFakeBff((p) =>
    p.includes(A)
      ? { json: { ...ok("JupUSD"), status: "warning", warnings: [{ kind: "oracle_secondary_stale", secondaryAgeSeconds: 120 }] } }
      : { json: { ...ok("USDC"), status: "warning", warnings: [{ kind: "oracle_secondary_stale", secondaryAgeSeconds: 95 }] } }
  );
  renderGate([A, B]);
  await waitFor(() => expect(screen.getAllByText(/Secondary price source is stale/)).toHaveLength(2));
  expect(cta().disabled).toBe(true);
  await waitFor(() => expect(cta().disabled).toBe(false), { timeout: 2000 });
});

test("片方の取得に失敗したら止める", async () => {
  installFakeBff((p) => (p.includes(A) ? { json: ok("JupUSD") } : { status: 502, json: { error: "upstream" } }));
  renderGate([A, B]);
  // hook は retry 1 (既定 1 秒後) なので待つ
  await screen.findByText("The price oracle could not be checked, so signing is blocked.", undefined, { timeout: 4000 });
  expect(cta().disabled).toBe(true);
});

test("mints = [] は gate 対象外として通す", () => {
  const calls = installFakeBff(() => undefined);
  renderGate([]);
  expect(cta().disabled).toBe(false);
  expect(calls).toHaveLength(0);
});
