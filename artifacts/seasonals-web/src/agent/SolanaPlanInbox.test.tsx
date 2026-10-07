/**
 * SolanaPlanInbox — Agent の Solana plan を web で承認 = 実行する流れ。
 * approve (token) → execute (unsigned tx) → 偽 wallet で一括署名 → /tx/submit → /signatures または /failed。
 * BFF は fetch の差し替え (契約どおりの応答を状態つきで返す)。mainnet には何も送らない。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentPlanStatus, ActionType, Objective, type AgentPlan } from "@workspace/lib/types";
import { depositAction, UNSUPPORTED_MARKET_MESSAGE } from "@workspace/lib/derive/solana-action";
import { useSession } from "../state/session";
import { _resetSolanaWalletsForTest, connectSolanaWallet } from "../services/solanaWallet";
import { fakeSolanaWallet, signedMarker, SOL_OTHER, SOL_OWNER, type FakeWalletOptions } from "../testing/fakeSolanaWallet";
import { b64, installFakeBff, type FakeHandler } from "../testing/fakeBff";
import { SolanaPlanInbox } from "./SolanaPlanInbox";

const SIG1 = "1".repeat(87);
const SIG2 = "2".repeat(87);
const HASH = `0x${"cd".repeat(32)}`;

function plan(over: Partial<AgentPlan> = {}, wallet = SOL_OWNER): AgentPlan {
  return {
    plan_id: "plan_1",
    user_id: "user_1",
    mcp_client_id: "claude",
    objective: Objective.MaxYield,
    constraints: {},
    candidate_actions: [],
    selected_action: { ...depositAction("jupiter", "USDC", "jupiter_usdc"), action_type: ActionType.Deposit, wallet_id: wallet, amount: "1500000" },
    simulation_result: {
      simulation_id: "sim_1",
      estimated_out: "1480000",
      estimated_fee: "5000",
      bundle_hash: HASH,
      oracle: { primary: "redstone", primary_age_seconds: 12, divergence_pct: 3.2, warnings: ["oracle_pyth_stale"] },
    },
    status: AgentPlanStatus.PendingUser,
    created_at: "2026-10-06T00:00:00.000Z",
    updated_at: "2026-10-06T00:00:00.000Z",
    expires_at: "2026-10-07T00:00:00.000Z",
    ...over,
  };
}

/** 契約どおりの状態つき fake BFF。over は path の prefix で差し替える */
function agentBff(initial: AgentPlan[], over: Partial<Record<string, FakeHandler>> = {}): FakeHandler {
  let plans = [...initial];
  let submits = 0;
  const patch = (id: string, p: Partial<AgentPlan>) => {
    plans = plans.map((x) => (x.plan_id === id ? { ...x, ...p } : x));
    return plans.find((x) => x.plan_id === id)!;
  };
  return (path, body, method) => {
    for (const [prefix, h] of Object.entries(over)) if (path.startsWith(prefix)) return h!(path, body, method);
    if (path.startsWith("/agent-plans?wallet=")) return { json: plans };
    const m = path.match(/^\/agent-plans\/([^/]+)\/(approve|execute|signatures|failed|reject)$/);
    if (m && method === "POST") {
      const id = m[1]!;
      switch (m[2]) {
        case "approve":
          return {
            json: {
              ...patch(id, { status: AgentPlanStatus.Approved, approved_by: "user" }),
              approval_token: { token_id: "tok_1", user_id: "user_1", plan_id: id, mcp_client_id: "claude", bundle_hash: HASH, issued_at: "", expires_at: "", consumed_at: null },
            },
          };
        case "execute":
          return {
            json: {
              execution_id: "exec_1",
              status: "awaiting_signature",
              plan: patch(id, { status: AgentPlanStatus.Executing }),
              // index 順に並べ直して署名することを確かめるため、わざと逆順
              unsigned_transactions: [
                { index: 1, label: "deposit", tx_base64: b64([4, 5]) },
                { index: 0, label: "setup", tx_base64: b64([1, 2, 3]) },
              ],
            },
          };
        case "signatures": {
          const b = body as { execution_id: string; signatures: string[] };
          return {
            json: patch(id, {
              status: AgentPlanStatus.Broadcasted,
              execution: { execution_id: b.execution_id, signatures: b.signatures, submitted_at: "2026-10-06T00:05:00.000Z", via: "web" },
            }),
          };
        }
        case "failed":
          return { json: patch(id, { status: AgentPlanStatus.Failed, failure_reason: (body as { reason: string }).reason }) };
        case "reject":
          return { json: patch(id, { status: AgentPlanStatus.Rejected }) };
      }
    }
    if (path === "/tx/submit") return { json: { signature: ++submits === 1 ? SIG1 : SIG2 } };
    if (path.startsWith("/tx/status")) return { json: { signature: path.split("=")[1], status: "confirmed", slot: 1, err: null } };
    return undefined;
  };
}

async function connect(opts: FakeWalletOptions = {}) {
  const w = fakeSolanaWallet(opts);
  await connectSolanaWallet({ name: w.name, icon: w.icon, wallet: w });
  useSession.setState({ connected: { solana: { address: SOL_OWNER, wallet: { name: w.name, icon: "", rdns: w.name } } } });
  return w;
}

function renderInbox() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SolanaPlanInbox />
    </QueryClientProvider>
  );
}

const tags = () => [...document.querySelectorAll(".tag")].map((t) => t.textContent);
const posts = (calls: Array<{ method: string; path: string }>) => calls.filter((c) => c.method === "POST").map((c) => c.path);

beforeEach(() => useSession.setState({ watchlist: [], connected: {}, lastSolanaWallet: null }));
afterEach(() => {
  cleanup();
  _resetSolanaWalletsForTest();
});

test("shows the plan: amount in human units, estimated out, oracle summary, bundle hash and expiry", async () => {
  await connect();
  installFakeBff(agentBff([plan()]));
  renderInbox();
  expect((await screen.findByRole("heading", { level: 3 })).textContent).toBe("Deposit 1.5 USDC");
  expect(tags()).toEqual(["Needs your approval"]);
  const text = document.body.textContent!;
  expect(text).toContain("Estimated out: 1.48 USDC");
  // 旧形式の fee (mock の lamports を入力 asset 建てと取り違えた値) は出さない
  expect(text).not.toContain("Estimated fee");
  expect(text).toContain("Price at simulation: redstone, 12s old · using secondary source · sources differ by 3.2%");
  expect(text).toContain("Pyth is returning a stale price: Pyth is stale · using the secondary source");
  expect(text).toContain(`${HASH.slice(0, 14)}…`);
  expect(text).toContain("expires");
});

/** 新形式の simulate 結果 (estimate_kind あり、fee 無し、oracle 無し) の plan */
function newFormatPlan(sim: Partial<NonNullable<AgentPlan["simulation_result"]>>): AgentPlan {
  return plan({ simulation_result: { simulation_id: "sim_2", bundle_hash: HASH, ...sim } });
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test("quote: estimated and minimum out in the received token's units, no fee line", async () => {
  await connect();
  installFakeBff(
    agentBff([
      newFormatPlan({ estimate_kind: "quote", estimated_out: "940000", estimated_out_symbol: "jlUSDC", estimated_out_decimals: 6, min_out: "935300" }),
    ])
  );
  renderInbox();
  await screen.findByRole("heading", { level: 3 });
  const text = document.body.textContent!;
  expect(text).toContain("Estimated out: ≈ 0.94 jlUSDC");
  expect(text).toContain("Minimum out: 0.9353 jlUSDC");
  expect(text).not.toContain("Estimated fee");
});

test("no estimate: the failure reason is shown once, in the warning style", async () => {
  await connect();
  installFakeBff(agentBff([newFormatPlan({ estimate_kind: "none", failure_reason: "unsupported_market" })]));
  renderInbox();
  await screen.findByRole("heading", { level: 3 });
  const text = document.body.textContent!;
  expect(count(text, UNSUPPORTED_MARKET_MESSAGE)).toBe(1);
  expect(screen.getByText(UNSUPPORTED_MARKET_MESSAGE).className).toContain("hf-warn");
  expect(text).not.toContain("Estimated out");
  expect(text).not.toContain("Simulation: unsupported_market");
});

test("non-oracle warnings are shown as sentences", async () => {
  await connect();
  installFakeBff(
    agentBff([
      newFormatPlan({
        estimate_kind: "exchange_rate",
        estimated_out: "95000000",
        estimated_out_symbol: "cSOL",
        estimated_out_decimals: 9,
        warnings: ["fair_value_unavailable"],
      }),
    ])
  );
  renderInbox();
  expect(await screen.findByText("Couldn't verify the redemption value")).toBeTruthy();
  expect(document.body.textContent).toContain("Estimated out: ≈ 0.095 cSOL");
});

test("lp_position: no single output amount", async () => {
  await connect();
  installFakeBff(agentBff([newFormatPlan({ estimate_kind: "lp_position" })]));
  renderInbox();
  await screen.findByRole("heading", { level: 3 });
  expect(document.body.textContent).toContain("Estimated out: LP position (no single output)");
});

test("Approve & sign: approve → execute (token, via web) → one wallet prompt → /tx/submit in index order → /signatures", async () => {
  const w = await connect();
  const calls = installFakeBff(agentBff([plan()]));
  renderInbox();
  fireEvent.click(await screen.findByRole("button", { name: "Approve & sign" }));
  await waitFor(() => expect(tags()).toEqual(["Sent"]));

  expect(posts(calls)).toEqual([
    "/agent-plans/plan_1/approve",
    "/agent-plans/plan_1/execute",
    "/tx/submit",
    "/tx/submit",
    "/agent-plans/plan_1/signatures",
  ]);
  expect(calls.find((c) => c.path.endsWith("/approve"))!.body).toBeUndefined();
  expect(calls.find((c) => c.path.endsWith("/execute"))!.body).toEqual({ approval_token: "tok_1", via: "web" });
  expect(w.signFn).toHaveBeenCalledTimes(1);
  const submits = calls.filter((c) => c.path === "/tx/submit").map((c) => c.body);
  expect(submits).toEqual([
    { signedTx: b64([...signedMarker(Uint8Array.from([1, 2, 3]))]), skipPreflight: false },
    { signedTx: b64([...signedMarker(Uint8Array.from([4, 5]))]), skipPreflight: true },
  ]);
  expect(calls.find((c) => c.path.endsWith("/signatures"))!.body).toEqual({ execution_id: "exec_1", signatures: [SIG1, SIG2] });
  const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
  expect(links).toEqual([`https://solscan.io/tx/${SIG1}`, `https://solscan.io/tx/${SIG2}`]);
  expect(screen.queryByRole("button", { name: "Approve & sign" })).toBeNull();
});

test("wallet declines → reports /failed with a reason, nothing is sent", async () => {
  await connect({ sign: async () => Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 })) });
  const calls = installFakeBff(agentBff([plan()]));
  renderInbox();
  fireEvent.click(await screen.findByRole("button", { name: "Approve & sign" }));
  await waitFor(() => expect(tags()).toEqual(["Failed"]));
  expect(posts(calls)).toEqual(["/agent-plans/plan_1/approve", "/agent-plans/plan_1/execute", "/agent-plans/plan_1/failed"]);
  expect(calls.find((c) => c.path.endsWith("/failed"))!.body).toEqual({ execution_id: "exec_1", reason: "user_cancelled" });
  expect(screen.getByText("Reason: user_cancelled")).toBeTruthy();
});

test("/execute refused by the oracle gate (409) → shown as declined, wallet not opened, no /failed", async () => {
  const w = await connect();
  const calls = installFakeBff(
    agentBff([plan()], {
      "/agent-plans/plan_1/execute": () => ({ status: 409, json: { error: "oracle_blocked", message: "Price sources are stale.", block_reason: "oracle_both_stale" } }),
    })
  );
  renderInbox();
  fireEvent.click(await screen.findByRole("button", { name: "Approve & sign" }));
  const alert = await screen.findByText(/Declined by safety gate: Price sources are stale\./);
  expect(alert.textContent).toContain("Try again later, reject, or ask your Agent to re-simulate.");
  expect(w.signFn).not.toHaveBeenCalled();
  expect(posts(calls)).toEqual(["/agent-plans/plan_1/approve", "/agent-plans/plan_1/execute"]);
  // 承認したのはこの画面なので「別の端末で承認」とは言わない。Reject は残す
  expect(screen.queryByText(/Approved elsewhere/)).toBeNull();
  expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
});

test("Reject posts to the reject route and the card leaves the pending state", async () => {
  await connect();
  const calls = installFakeBff(agentBff([plan()]));
  renderInbox();
  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
  await waitFor(() => expect(tags()).toEqual(["Rejected"]));
  expect(posts(calls)).toEqual(["/agent-plans/plan_1/reject"]);
  expect(screen.queryByRole("button", { name: /Approve & sign|Reject/ })).toBeNull();
});

test("a plan for another wallet cannot be signed here and says why", async () => {
  await connect();
  installFakeBff(agentBff([plan({}, SOL_OTHER)]));
  renderInbox();
  expect(await screen.findByText(/This plan is for 9WzDXw…AWWM\. Connect that wallet to sign it\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve & sign" })).toBeNull();
});

test("a plan approved elsewhere (Seeker) offers Sign & send, which re-approves for a fresh token and then executes", async () => {
  await connect();
  const calls = installFakeBff(agentBff([plan({ status: AgentPlanStatus.Approved, approved_by: "user" })]));
  renderInbox();
  expect(await screen.findByText("Approved on another device. Signing here sends it from this wallet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve & sign" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign & send" }));
  await waitFor(() => expect(tags()).toEqual(["Sent"]));
  expect(posts(calls).slice(0, 2)).toEqual(["/agent-plans/plan_1/approve", "/agent-plans/plan_1/execute"]);
});

test("expired and sent plans render read-only, newest first, with Solscan links for sent ones", async () => {
  await connect();
  installFakeBff(
    agentBff([
      plan({ plan_id: "plan_old", status: AgentPlanStatus.Expired, created_at: "2026-10-01T00:00:00.000Z" }),
      plan({
        plan_id: "plan_sent",
        status: AgentPlanStatus.Broadcasted,
        created_at: "2026-10-05T00:00:00.000Z",
        execution: { execution_id: "exec_9", signatures: [SIG1], submitted_at: "2026-10-05T00:01:00.000Z", via: "web" },
      }),
    ])
  );
  renderInbox();
  await waitFor(() => expect(tags()).toEqual(["Sent", "Expired"]));
  expect(screen.getByRole("link").getAttribute("href")).toBe(`https://solscan.io/tx/${SIG1}`);
  expect(document.body.textContent).toContain("sent via web");
  expect(screen.queryByRole("button")).toBeNull();
});

test("without a connected Solana wallet it asks for one instead of fetching (watch-only does not count)", async () => {
  useSession.setState({ watchlist: [{ chain: "solana", address: SOL_OWNER }], connected: {} });
  const calls = installFakeBff(agentBff([plan()]));
  renderInbox();
  expect(screen.getByText(/Connect a Solana wallet to approve and sign plans from your Agent/)).toBeTruthy();
  expect(calls).toHaveLength(0);
});
