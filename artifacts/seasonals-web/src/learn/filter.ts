/**
 * Learn の chain filter と並び順。content.ts からは LEARN と LearnEntry.chain だけを使い、
 * 対応 chain の一覧・表示名は @workspace/lib/config/chains (SUPPORTED_CHAINS) から引く。
 */
import { SUPPORTED_CHAINS, chainInfo, type ChainId } from "@workspace/lib/config/chains";
import { LEARN, type LearnEntry } from "./content";

export type LearnChain = "all" | ChainId;

// chip は config から描く (UI v2 §1: 対応 chain を hard-code しない)
export const LEARN_CHAINS: readonly LearnChain[] = ["all", ...SUPPORTED_CHAINS.map((c) => c.id)];

// All chains の時の並び順 (chain ごとにまとめる)。Ethereum を先にするなら [...SUPPORTED_CHAINS].reverse().map((c) => c.id) の 1 行替え
export const CHAIN_ORDER: readonly ChainId[] = SUPPORTED_CHAINS.map((c) => c.id);

export const chainLabel = (c: LearnChain) => (c === "all" ? "All chains" : chainInfo(c).name);

/** filter は新しい配列を返すので sort しても LEARN 自体は並べ替わらない (sort は stable = 同じ chain 内は content.ts の順) */
export function learnEntries(chain: LearnChain): LearnEntry[] {
  return LEARN.filter((e) => chain === "all" || e.chain === chain).sort(
    (a, b) => CHAIN_ORDER.indexOf(a.chain) - CHAIN_ORDER.indexOf(b.chain)
  );
}
