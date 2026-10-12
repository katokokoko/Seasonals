/**
 * Calendar の Solana event action — DTO の metadata から全量 withdraw を組み、接続 wallet でだけ署名させる。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { UnifiedTimeEventDTO } from "@workspace/lib/types";
import { fromUnifiedTimeEventDTO } from "@workspace/lib/derive/timeline";
import { useSession } from "../state/session";
import { installFakeBff } from "../testing/fakeBff";
import { SOL_OTHER, SOL_OWNER } from "../testing/fakeSolanaWallet";
import { ActionPreview } from "./ActionPreview";

const POSITION = "PosB1111111111111111111111111111111111111111";
const claimDto = (metadata: Record<string, unknown>, wallet = SOL_OWNER): UnifiedTimeEventDTO => ({
  id: "claim_orca_1",
  protocol: "orca",
  category: "claim",
  triggerAt: "2026-10-05T00:00:00.000Z",
  urgency: "watch",
  walletAddress: wallet,
  positionRef: null,
  actions: [{ actionType: "withdraw", label: "Withdraw & claim", requiresApproval: true, riskLevel: "medium" }],
  agentReadable: true,
  metadata,
});
const FULL = {
  source: "claimable",
  protocol_id: "orca",
  share_mint: POSITION,
  shares: "1",
  share_decimals: 0,
  underlying_decimals: 6,
  underlying_amount: "2500000",
  asset_symbol: "USDC",
};

function renderPreview(dto: UnifiedTimeEventDTO) {
  const event = fromUnifiedTimeEventDTO(dto, "2026-10-05T00:00:00.000Z");
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActionPreview event={event} action={event.actions[0]!} onBack={() => {}} />
    </QueryClientProvider>
  );
  return event;
}

beforeEach(() => {
  installFakeBff((path) => (path.startsWith("/oracle/status") ? { json: { status: "ok", warnings: [], block_reason: null } } : undefined));
  useSession.setState({ watchlist: [], connected: { solana: { address: SOL_OWNER, wallet: { name: "Phantom", icon: "", rdns: "Phantom" } } } });
});
afterEach(cleanup);

test("claim event は position の全量 withdraw として開き、fee も回収することを添える", () => {
  const event = renderPreview(claimDto(FULL));
  expect(event.actions[0]!.availability).toBe("available");
  expect(screen.getByText("Withdraw & claim")).toBeTruthy();
  expect(screen.getByText(/also collects its unclaimed fees/)).toBeTruthy();
  // Orca の position は registry 外なので metadata の decimals (0) と asset で入力する
  expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("1");
  expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeTruthy();
  expect(screen.queryByText(/Seeker app/)).toBeNull();
});

test("withdraw 用 metadata が欠けた event は実行させず理由を出す (fail-closed)", () => {
  const { share_mint: _omit, ...partial } = FULL;
  const event = renderPreview(claimDto(partial));
  expect(event.actions[0]!.availability).toBe("unsupported");
  expect(screen.getByRole("alert").textContent).toMatch(/cannot build a transaction/);
  expect(screen.queryByRole("button", { name: /Sign in wallet/ })).toBeNull();
});

test("watch 中 (未接続) の wallet の event は接続を案内し、署名させない", () => {
  renderPreview(claimDto(FULL, SOL_OTHER));
  expect(screen.getByText(/Connect 9WzDXw…AWWM in a Solana wallet to sign/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Sign in wallet/ })).toBeNull();
});
