/**
 * Fork execution (Ethereum v3 §8 "Execution demo runs on an Anvil fork of mainnet").
 *
 * - ETH_EXECUTION_TARGET=fork の時だけ動く。mainnet への送信経路は存在しない
 * - 送信先が Anvil (web3_clientVersion) かつ chainId 1 であることを確認してから
 *   anvil_impersonateAccount で owner として送る (秘密鍵は存在しない / 使わない)
 * - 人の承認 (UI のボタン) を経た request のみ受け付ける。MCP からは呼べない (build_action まで)
 * - receipt を観測したら executed class の event を記録する (v3 §4)
 */
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import type { TimelineEvent } from "@workspace/lib/types";
import { executionTarget, forkRpcUrl, sanitizeError, undiciFetch } from "./client";
import { buildActionPlan, PlanError, type ActionPlan } from "./plans";
import { registerUserSource, _invalidateUser } from "./events";
import { loadJson, saveJson } from "../persistence";

export interface ForkExecution {
  target: "fork";
  plan: ActionPlan;
  txs: Array<{ hash: string; status: "success" | "reverted"; blockNumber: string; gasUsed: string; description: string }>;
  executedEvent: TimelineEvent;
}

const STORE = "eth-executed-events";
// 遅延 load: SEASONALS_DATA_DIR は index.ts の main() で設定されるため import 時には読まない
let executed: TimelineEvent[] | null = null;
function store(): TimelineEvent[] {
  if (!executed) executed = loadJson<TimelineEvent[]>(STORE) ?? [];
  return executed;
}

registerUserSource((owner) => ({
  name: "executed:fork",
  needsRpc: false,
  run: async () => store().filter((e) => e.owner?.toLowerCase() === owner.toLowerCase()),
}));

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await undiciFetch()(forkRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

export async function assertForkEndpoint(): Promise<void> {
  if (executionTarget() !== "fork") throw new PlanError("action_not_available", "Execution is disabled: this server is configured for plans only.");
  let version: string;
  let chainId: string;
  try {
    [version, chainId] = await Promise.all([rpc<string>("web3_clientVersion"), rpc<string>("eth_chainId")]);
  } catch {
    throw new PlanError("rpc_unavailable", "The local fork is not running. Start it with `bash scripts/eth-fork.sh`.");
  }
  if (!/anvil/i.test(version) || Number.parseInt(chainId, 16) !== 1) {
    throw new PlanError("action_not_available", "The execution endpoint is not an Anvil mainnet fork; refusing to impersonate.");
  }
}

export async function executeOnFork(input: { owner: string; eventId: string; actionType: string }): Promise<ForkExecution> {
  await assertForkEndpoint();
  const owner = input.owner as Hex;
  const transport = http(forkRpcUrl(), { fetchFn: undiciFetch() });
  const pub = createPublicClient({ chain: mainnet, transport });
  // fork の状態で再検証・eth_call する (時間送り後の cooldown / 満期も fork 上の事実で判定)
  const plan = await buildActionPlan(input, { client: pub as unknown as PublicClient, stateOnly: true, where: "fork" });
  const wallet = createWalletClient({ chain: mainnet, transport });

  await rpc("anvil_impersonateAccount", [owner]);
  try {
    const bal = await pub.getBalance({ address: owner });
    // gas 代のみ fork 上で補充 (実資金ではない)
    if (bal < 10n ** 16n) await rpc("anvil_setBalance", [owner, "0x" + (10n ** 17n).toString(16)]);
    const txs: ForkExecution["txs"] = [];
    for (const step of plan.steps) {
      const hash = await wallet.sendTransaction({ account: owner, to: step.to as Hex, data: step.data as Hex, value: BigInt(step.value), chain: mainnet });
      const r = await pub.waitForTransactionReceipt({ hash });
      txs.push({ hash, status: r.status, blockNumber: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), description: step.description });
      if (r.status !== "success") break;
    }
    const ok = txs.length === plan.steps.length && txs.every((t) => t.status === "success");
    const last = txs[txs.length - 1];
    const block = last ? await pub.getBlock({ blockNumber: BigInt(last.blockNumber) }) : null;
    const now = new Date().toISOString();
    const source = (await buildEventSnapshot(input.owner, input.eventId)) ?? { protocol: null, protocolName: null, title: plan.summary, asset: undefined };
    const executedEvent: TimelineEvent = {
      id: `ethereum:executed:fork:${last?.hash ?? now}`,
      chain: "ethereum",
      class: "executed",
      kind: "action_executed",
      protocol: source.protocol,
      protocolName: source.protocolName,
      title: `${ok ? "Executed" : "Failed"} on fork: ${plan.summary}`,
      ...(source.asset ? { asset: source.asset } : {}),
      at: block ? new Date(Number(block.timestamp) * 1000).toISOString() : now,
      atApprox: false,
      settled: true,
      outcome: ok ? "success" : "failed",
      metrics: [
        { label: "Environment", kind: "text", value: "Local Anvil fork of mainnet (no real funds moved)" },
        ...txs.map((t, i) => ({ label: `Fork tx ${i + 1}`, kind: "text" as const, value: `${t.hash.slice(0, 10)}… (${t.status})` })),
      ],
      actions: [],
      requiresWallet: true,
      owner: input.owner,
      links: [],
      source: "anvil-fork:receipt",
      observedAt: now,
    };
    executed = [...store(), executedEvent];
    saveJson(STORE, executed);
    _invalidateUser(input.owner);
    return { target: "fork", plan, txs, executedEvent };
  } catch (e) {
    if (e instanceof PlanError) throw e;
    throw new PlanError("upstream_error", sanitizeError(e));
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [owner]).catch(() => undefined);
  }
}

async function buildEventSnapshot(owner: string, eventId: string) {
  const { getUserEvents } = await import("./events");
  const e = (await getUserEvents(owner)).events.find((x) => x.id === eventId);
  return e ? { protocol: e.protocol, protocolName: e.protocolName, title: e.title, asset: e.asset } : null;
}

export function _resetExecutedForTest() {
  executed = [];
}

/** fork の時間を進める (デモ用: cooldown 終了 / 満期 / CCA の block 進行を再生する)。fork 専用 */
export async function advanceFork(seconds: number): Promise<{ timestamp: string; block: string }> {
  await assertForkEndpoint();
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 400 * 86_400) throw new PlanError("action_not_available", "seconds must be 1..34560000");
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
  const b = await rpc<{ timestamp: string; number: string }>("eth_getBlockByNumber", ["latest", false]);
  return { timestamp: new Date(Number.parseInt(b.timestamp, 16) * 1000).toISOString(), block: String(Number.parseInt(b.number, 16)) };
}
