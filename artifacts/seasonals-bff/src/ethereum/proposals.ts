/**
 * Event proposals (Ethereum v3 §7 primary mode) — rule-based。
 * ANTHROPIC_API_KEY が無い環境では LLM を使わず、on-chain / API の事実から決定的に組み立てる。
 * 出力は zod で検証。facts / assumptions / options / risks を分ける。calldata は含めない
 * (実行計画は build_action が protocol SDK / ABI から作る)。
 */
import { z } from "zod";
import { formatPercentage, formatTokenAmount } from "@workspace/lib/utils/numeric";
import type { TimelineEvent } from "@workspace/lib/types";
import { getJson } from "./client";
import { getUserEvents } from "./events";
import { fetchPendleMarkets } from "./pendle";

const LiquidityClass = z.enum(["instant", "cooldown", "queue", "dated"]);
export const ProposalSchema = z.object({
  eventId: z.string(),
  generator: z.literal("rule-based"),
  summary: z.string(),
  facts: z.array(z.string()),
  assumptions: z.array(z.string()),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        /** 比率 (0..1)、不明なら null。将来の利回りを約束しない */
        currentYield: z.number().nullable(),
        yieldSource: z.string().nullable(),
        liquidityClass: LiquidityClass,
        durationDays: z.number().nullable(),
        risks: z.array(z.string()),
        /** この option の最初の一歩として実行できる event action (build_action に渡す) */
        firstAction: z.string().nullable(),
      })
    )
    .min(1),
  recommendedOptionId: z.string(),
  reason: z.string(),
  builtAt: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

async function lidoSmaApr(): Promise<number | null> {
  try {
    const r = await getJson<{ data: { smaApr: number } }>("https://eth-api.lido.fi/v1/protocol/steth/apr/sma");
    return Number.isFinite(r.data.smaApr) ? r.data.smaApr / 100 : null;
  } catch {
    return null;
  }
}
async function ethenaSusde30d(): Promise<number | null> {
  try {
    const r = await getJson<{ avg30dSusdeYield: { value: number } }>("https://ethena.fi/api/yields/protocol-and-staking-yield");
    return Number.isFinite(r.avg30dSusdeYield.value) ? r.avg30dSusdeYield.value / 100 : null;
  } catch {
    return null;
  }
}

const pct = (r: number | null) => (r === null ? "unavailable" : formatPercentage(r));

export async function buildProposal(owner: string, eventId: string): Promise<Proposal | null> {
  const { events } = await getUserEvents(owner);
  const e = events.find((x) => x.id === eventId);
  if (!e) return null;
  const builtAt = new Date().toISOString();
  const p = await proposalFor(e);
  return p ? ProposalSchema.parse({ ...p, eventId, generator: "rule-based", builtAt }) : null;
}

async function proposalFor(e: TimelineEvent): Promise<Omit<Proposal, "eventId" | "generator" | "builtAt"> | null> {
  const amount = e.amount ? `${formatTokenAmount(e.amount.value, e.amount.decimals, { maxFractionDigits: 4 })} ${e.amount.symbol}` : "unknown amount";
  switch (e.kind) {
    case "withdrawal_claimable": {
      const apr = await lidoSmaApr();
      return {
        summary: "Finalized Lido withdrawal: the ETH is idle until claimed.",
        facts: [`${e.title}.`, `Requested amount: ${amount}.`, `Lido stETH 7-day SMA APR: ${pct(apr)} (eth-api.lido.fi).`],
        assumptions: ["APR is a trailing average, not a promise of future yield."],
        options: [
          { id: "A", label: "Claim ETH and hold", currentYield: 0, yieldSource: null, liquidityClass: "instant", durationDays: null, risks: [], firstAction: "lido_claim" },
          {
            id: "B",
            label: "Claim ETH, then stake again as wstETH",
            currentYield: apr,
            yieldSource: "Lido stETH 7-day SMA APR",
            liquidityClass: "queue",
            durationDays: null,
            risks: ["Exiting again goes through the withdrawal queue (typically days)."],
            firstAction: "lido_claim",
          },
        ],
        recommendedOptionId: "A",
        reason: "Claiming is required for every option and costs only gas; decide on re-staking after the ETH is back.",
      };
    }
    case "cooldown_end": {
      const y = await ethenaSusde30d();
      const ready = e.actions.some((a) => a.availability === "available");
      return {
        summary: ready ? "The sUSDe cooldown has finished: the USDe sits in the silo earning nothing." : "An sUSDe cooldown is running.",
        facts: [`${e.title}.`, `Amount in cooldown: ${amount}.`, `sUSDe 30-day average yield: ${pct(y)} (ethena.fi).`],
        assumptions: ["Trailing yield, not future yield. The cooldown length is set by Ethena and can change."],
        options: [
          { id: "A", label: "Claim USDe and hold", currentYield: 0, yieldSource: null, liquidityClass: "instant", durationDays: null, risks: ["USDe is a synthetic dollar; peg risk remains."], firstAction: ready ? "ethena_unstake" : null },
          {
            id: "B",
            label: "Claim USDe, then stake to sUSDe again",
            currentYield: y,
            yieldSource: "Ethena sUSDe 30-day average",
            liquidityClass: "cooldown",
            durationDays: null,
            risks: ["Leaving again requires a new cooldown.", "USDe concentration stays the same."],
            firstAction: ready ? "ethena_unstake" : null,
          },
        ],
        recommendedOptionId: "A",
        reason: ready ? "The claim is available now and is the first step of every option." : "Nothing to do until the cooldown ends.",
      };
    }
    case "pt_maturity": {
      if (!e.owner) return null;
      const matured = e.actions.some((a) => a.availability === "available");
      const markets = await fetchPendleMarkets({ active: true }).catch(() => []);
      const ptName = e.asset?.replace(/^PT-/, "") ?? "";
      const roll = markets
        .filter((m) => m.name === ptName && Date.parse(m.expiry) > Date.now())
        .sort((a, b) => Date.parse(a.expiry) - Date.parse(b.expiry))[0];
      const days = roll ? Math.round((Date.parse(roll.expiry) - Date.now()) / 86_400_000) : null;
      return {
        summary: matured ? `${e.asset} has matured and no longer earns a fixed rate.` : `${e.asset} matures on ${e.at?.slice(0, 10)}.`,
        facts: [
          `${e.title}.`,
          `Position: ${amount}.`,
          roll ? `Next ${ptName} market: expiry ${roll.expiry.slice(0, 10)}, implied APY ${pct(roll.details?.impliedApy ?? null)} (Pendle API).` : "No later market with the same underlying is listed right now.",
        ],
        assumptions: ["Implied APY is the current market rate; it is fixed only for PT bought at that rate and held to maturity."],
        options: [
          { id: "A", label: "Redeem PT to the underlying", currentYield: null, yieldSource: null, liquidityClass: "instant", durationDays: null, risks: [], firstAction: matured ? "pendle_redeem" : null },
          ...(roll
            ? [
                {
                  id: "B",
                  label: `Roll into PT-${roll.name} (${roll.expiry.slice(0, 10)})`,
                  currentYield: roll.details?.impliedApy ?? null,
                  yieldSource: "Pendle implied APY (current market rate)",
                  liquidityClass: "dated" as const,
                  durationDays: days,
                  risks: ["Selling before maturity depends on market liquidity and price.", "Underlying protocol risk continues."],
                  firstAction: matured ? "pendle_redeem" : null,
                },
              ]
            : []),
        ],
        recommendedOptionId: "A",
        reason: matured ? "A matured PT earns nothing; redeeming is required before any other choice." : "Nothing to do before maturity.",
      };
    }
    default:
      return null;
  }
}
