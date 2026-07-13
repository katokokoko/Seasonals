/**
 * Phase 8.29: 自律実行サイクル + ガードレール + routes のテスト。
 * solana-devnet client を mock し実 network を掴まない。
 */
import type { FastifyInstance } from "fastify";
import { Keypair } from "@solana/web3.js";
// bs58 は @types 無し — require で any 回避 (encode のみ使用)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require("bs58") as { encode(b: Uint8Array): string };

import type { ProtocolMenuEntry, UserPolicy } from "@workspace/lib/types";
import {
  fixtureUserPolicyDefault,
} from "@workspace/lib/__fixtures__";

import { buildServer, buildAutonomousDeps } from "./server";
import {
  runAutonomousCycle,
  _resetAutonomousForTest,
  getAutonomousStatus,
  AUTONOMOUS_MAX_TX_USD8,
  type AutonomousDeps,
} from "./autonomous";
import { _clearPlanStoreForTest } from "./plan-store";
import { _resetPolicyForTest } from "./policy-store";
import { sendAndConfirmDevnetTx, getDevnetConnection } from "./clients/solana-devnet";

jest.mock("./clients/solana-devnet", () => ({
  ...jest.requireActual("./clients/solana-devnet"),
  sendAndConfirmDevnetTx: jest.fn(),
  getDevnetConnection: jest.fn(),
}));

const mockSend = sendAndConfirmDevnetTx as jest.MockedFunction<
  typeof sendAndConfirmDevnetTx
>;
const mockConn = getDevnetConnection as jest.MockedFunction<
  typeof getDevnetConnection
>;

// USDC pool を持つ menu (kamino: default policy で enabled、TVL 100M)
const MENU: ProtocolMenuEntry[] = [
  {
    protocol_id: "kamino",
    display_name: "Kamino",
    primary_category: "lending" as never,
    supported_assets: ["USDC"],
    icon_id: "kamino",
    icon_bg: "#000",
    pools: [
      {
        pool_id: "kamino_usdc_main",
        name: "USDC Main",
        category: "lending" as never,
        asset: "USDC",
        apy: 0.045,
        tvl_usd: 100_000_000,
      },
    ],
  },
];

function fakeDeps(policy: UserPolicy, push = jest.fn()): AutonomousDeps {
  return {
    fetchMenu: async () => MENU,
    getPolicy: () => policy,
    sendExecutionPush: push,
  };
}

const ENV_KEYS = [
  "FEATURE_APPROVAL_MODE_AUTO",
  "AUTONOMOUS_DELEGATE_SECRET",
  "SOLANA_RPC_URL",
  "AUTONOMOUS_TRANSFER_LAMPORTS",
];
let savedEnv: Record<string, string | undefined>;

function autoPolicy(over: Partial<UserPolicy> = {}): UserPolicy {
  return { ...fixtureUserPolicyDefault, approval_mode: "auto", ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAutonomousForTest();
  _clearPlanStoreForTest();
  _resetPolicyForTest();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
  process.env.AUTONOMOUS_DELEGATE_SECRET = bs58.encode(
    Keypair.generate().secretKey
  );
  process.env.FEATURE_APPROVAL_MODE_AUTO = "true";
  mockConn.mockReturnValue({} as never);
  mockSend.mockResolvedValue("SIG_DEVNET_CONFIRMED");
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("runAutonomousCycle — decision + guards", () => {
  it("dry_run: 決定のみ返し署名しない", async () => {
    const rec = await runAutonomousCycle(
      { objective: "safety_first", asset: "USDC", dry_run: true },
      fakeDeps(autoPolicy())
    );
    expect(rec.decision).toBe("dry_run");
    expect(rec.protocol).toBe("kamino");
    expect(rec.tx_signature).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("dry_run 省略時は既定で dry_run (F1 fail-closed、署名しない)", async () => {
    const rec = await runAutonomousCycle(
      { objective: "safety_first", asset: "USDC" }, // dry_run 省略
      fakeDeps(autoPolicy())
    );
    expect(rec.decision).toBe("dry_run");
    expect(rec.tx_signature).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("本番: 委任署名 → confirmed devnet 署名 + notify + hard-cap notional", async () => {
    const push = jest.fn();
    const rec = await runAutonomousCycle(
      { objective: "safety_first", asset: "USDC", dry_run: false },
      fakeDeps(autoPolicy(), push)
    );
    expect(rec.decision).toBe("executed");
    expect(rec.tx_signature).toBe("SIG_DEVNET_CONFIRMED");
    expect(rec.amount_usd8).toBe(AUTONOMOUS_MAX_TX_USD8); // policy 無制限 → $20 に第1クランプ
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ type: "execution", status: "executed" })
    );
  });

  it("policy reject: manual_only は approval_mode 違反", async () => {
    const rec = await runAutonomousCycle(
      { objective: "safety_first", asset: "USDC", dry_run: false },
      fakeDeps({ ...fixtureUserPolicyDefault, approval_mode: "manual_only" })
    );
    expect(rec.decision).toBe("rejected");
    expect(rec.violations).toContain("policy_violation_approval_mode");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("policy reject: enabled_protocols に無いと candidate なし", async () => {
    const rec = await runAutonomousCycle(
      { objective: "safety_first", asset: "USDC", dry_run: false },
      fakeDeps(autoPolicy({ enabled_protocols: ["jito"] }))
    );
    expect(rec.decision).toBe("rejected");
    expect(rec.reason).toBe("no_candidate_passed_policy");
  });

  it("daily cap: max_daily_executions 超過で reject", async () => {
    const policy = autoPolicy({ max_daily_executions: 1 });
    const a = await runAutonomousCycle(
      { objective: "safety_first", asset: "USDC", dry_run: false },
      fakeDeps(policy)
    );
    expect(a.decision).toBe("executed");
    const b = await runAutonomousCycle(
      { objective: "safety_first", asset: "USDC", dry_run: false },
      fakeDeps(policy)
    );
    expect(b.decision).toBe("rejected");
    expect(b.violations).toContain("policy_violation_max_daily_executions");
  });

  it("feature flag OFF: dry_run も含め throw", async () => {
    process.env.FEATURE_APPROVAL_MODE_AUTO = "false";
    await expect(
      runAutonomousCycle(
        { objective: "safety_first", asset: "USDC", dry_run: true },
        fakeDeps(autoPolicy())
      )
    ).rejects.toMatchObject({ code: "feature_flag_off" });
  });

  it("非 devnet: 本番実行は throw (dry_run は通る)", async () => {
    process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
    _resetAutonomousForTest(); // delegate cache クリア
    await expect(
      runAutonomousCycle(
        { objective: "safety_first", asset: "USDC", dry_run: false },
        fakeDeps(autoPolicy())
      )
    ).rejects.toMatchObject({ code: "not_devnet" });
  });
});

describe("routes: /autonomous/* + PATCH /user-policy", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildServer({ logger: false });
  });
  afterEach(async () => {
    await app.close();
  });

  it("PATCH /user-policy: approval_mode 編集 + GET 反映、不正 field は 400", async () => {
    const ok = await app.inject({
      method: "PATCH",
      url: "/user-policy",
      payload: { approval_mode: "auto", max_tx_amount: "5.00000000" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().approval_mode).toBe("auto");
    const got = await app.inject({ method: "GET", url: "/user-policy" });
    expect(got.json().approval_mode).toBe("auto");

    const bad = await app.inject({
      method: "PATCH",
      url: "/user-policy",
      payload: { approval_mode: "nonsense" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("GET /autonomous/status の shape", async () => {
    const res = await app.inject({ method: "GET", url: "/autonomous/status" });
    const s = res.json();
    expect(s.feature_flag).toBe(true);
    expect(s.devnet).toBe(true);
    expect(s.hard_caps.max_tx_usd8).toBe(AUTONOMOUS_MAX_TX_USD8);
  });

  it("POST /autonomous/kill → tick 503 → resume", async () => {
    await app.inject({ method: "POST", url: "/autonomous/kill" });
    const killed = await app.inject({
      method: "POST",
      url: "/autonomous/tick",
      payload: { objective: "safety_first", dry_run: true },
    });
    expect(killed.statusCode).toBe(503);
    expect(killed.json().reason).toBe("kill_switch_active");
    const resumed = await app.inject({ method: "POST", url: "/autonomous/resume" });
    expect(resumed.json().killed).toBe(false);
  });

  it("tick: 不正 objective は 400 / flag off は 403", async () => {
    const badObj = await app.inject({
      method: "POST",
      url: "/autonomous/tick",
      payload: { objective: "nope" },
    });
    expect(badObj.statusCode).toBe(400);

    process.env.FEATURE_APPROVAL_MODE_AUTO = "false";
    const off = await app.inject({
      method: "POST",
      url: "/autonomous/tick",
      payload: { objective: "safety_first", dry_run: true },
    });
    expect(off.statusCode).toBe(403);
    expect(off.json().reason).toBe("feature_flag_off");
  });

  it("auto-approve 短絡: request-approval が push なしで approved+token", async () => {
    // policy を auto に
    await app.inject({
      method: "PATCH",
      url: "/user-policy",
      payload: { approval_mode: "auto" },
    });
    const fetchSpy = jest.spyOn(global, "fetch");
    // plan 作成 + simulate
    const plan = (
      await app.inject({
        method: "POST",
        url: "/agent-plans",
        payload: { objective: "max_yield", mcp_client_id: "t" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/agent-plans/${plan.plan_id}/simulate`,
      payload: {
        action_spec: {
          wallet_id: "W",
          action_type: "deposit",
          protocol: "jito",
          asset: "SOL",
          amount: "1000000",
        },
      },
    });
    const req = await app.inject({
      method: "POST",
      url: `/agent-plans/${plan.plan_id}/request-approval`,
    });
    expect(req.json().status).toBe("approved"); // pending_user を飛ばした
    // approval poll で token が取れる
    const appr = await app.inject({
      method: "GET",
      url: `/agent-plans/${plan.plan_id}/approval`,
    });
    expect(appr.json().approval_token).not.toBeNull();
    // Expo push は呼ばれていない
    expect(
      fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("exp.host")
      )
    ).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it("auto-approve 短絡: policy 外 protocol は短絡せず pending_user (F3 fail-closed)", async () => {
    await app.inject({
      method: "PATCH",
      url: "/user-policy",
      payload: { approval_mode: "auto" },
    });
    const plan = (
      await app.inject({
        method: "POST",
        url: "/agent-plans",
        payload: { objective: "max_yield", mcp_client_id: "t" },
      })
    ).json();
    // orca は fixture default policy の enabled_protocols 外 → 短絡しない
    await app.inject({
      method: "POST",
      url: `/agent-plans/${plan.plan_id}/simulate`,
      payload: {
        action_spec: {
          wallet_id: "W",
          action_type: "deposit",
          protocol: "orca",
          asset: "SOL",
          amount: "1000000",
        },
      },
    });
    const req = await app.inject({
      method: "POST",
      url: `/agent-plans/${plan.plan_id}/request-approval`,
    });
    expect(req.json().status).toBe("pending_user"); // 人手承認へ fall through
    const appr = await app.inject({
      method: "GET",
      url: `/agent-plans/${plan.plan_id}/approval`,
    });
    expect(appr.json().approval_token).toBeNull(); // token 未発行
  });

  it("buildAutonomousDeps.fetchMenu が /menu-listings を返す (回帰 smoke)", async () => {
    const deps = buildAutonomousDeps(app);
    const menu = await deps.fetchMenu();
    expect(Array.isArray(menu)).toBe(true);
  });
});
