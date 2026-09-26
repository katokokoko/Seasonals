/**
 * 現在単価 (USD 8-dec) — portfolio 履歴 (history.ts) と Strategy Brief が共有する。
 *
 * 優先順: Chainlink (stale は使わない) → on-chain 換算 (wstETH → stETH、sUSDe → USDe) → DefiLlama。
 * 取れない asset は map に入れない (0 や推測で埋めない。呼び手が「unpriced」として扱う)。
 */
import type { PublicClient } from "viem";
import { ETH_ASSET_ADDRESS, ETH_NATIVE_KEY } from "@workspace/lib/config/eth-assets";
import { bigIntToUsd8, usd8ToBigInt } from "@workspace/lib/utils/numeric";
import { fetchLlamaCurrentPrices } from "../clients/llama-history";
import { sUSDeAbi, wstETHAbi } from "./abis";
import { getEthClient } from "./client";
import { ETHENA, LIDO } from "./config";
import { getChainlinkPrice, type ChainlinkPrice, type PriceAsset } from "./pricing";

const UINT_RE = /^[0-9]+$/;

/** registry asset key → Chainlink の feed 名 (WETH は ETH と同価) */
export const CHAINLINK_BY_KEY: Record<string, PriceAsset> = {
  [ETH_NATIVE_KEY]: "ETH",
  [ETH_ASSET_ADDRESS.WETH.toLowerCase()]: "ETH",
  [ETH_ASSET_ADDRESS.USDC.toLowerCase()]: "USDC",
  [ETH_ASSET_ADDRESS.USDe.toLowerCase()]: "USDe",
  [ETH_ASSET_ADDRESS.stETH.toLowerCase()]: "stETH",
};

/** Chainlink の answer (decimals 桁) → USD 8-dec。stale / 非正は null (使わない) */
export function chainlinkToUsd8(p: ChainlinkPrice | null): string | null {
  if (!p || p.stale || !UINT_RE.test(p.answer)) return null;
  const answer = BigInt(p.answer);
  if (answer <= 0n) return null;
  const scaled = p.decimals >= 8 ? answer / 10n ** BigInt(p.decimals - 8) : answer * 10n ** BigInt(8 - p.decimals);
  return bigIntToUsd8(scaled);
}

/** 換算で単価を出す asset: 1e18 単位の rate を読んで base の単価に掛ける */
const DERIVED: Record<string, { base: string; read: (client: PublicClient) => Promise<bigint> }> = {
  [ETH_ASSET_ADDRESS.wstETH.toLowerCase()]: {
    base: ETH_ASSET_ADDRESS.stETH.toLowerCase(),
    read: async (c) => (await c.readContract({ address: LIDO.wstETH, abi: wstETHAbi, functionName: "getStETHByWstETH", args: [10n ** 18n] })) as bigint,
  },
  [ETH_ASSET_ADDRESS.sUSDe.toLowerCase()]: {
    base: ETH_ASSET_ADDRESS.USDe.toLowerCase(),
    read: async (c) => (await c.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "convertToAssets", args: [10n ** 18n] })) as bigint,
  },
};

/** base の単価 × rate (1e18 = 1.0) → 8-dec */
export function derivePrice(baseUsd8: string, rate1e18: bigint): string {
  return bigIntToUsd8((usd8ToBigInt(baseUsd8) * rate1e18) / 10n ** 18n);
}

/** 純粋な合成 (テスト用に分離): Chainlink → derived → Llama の順で最初に見つかった単価 */
export function mergePriceSources(keys: string[], chainlink: Map<string, string | null>, derived: Map<string, string>, llama: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of keys) {
    const v = chainlink.get(k) ?? derived.get(k) ?? llama.get(k);
    if (v) out.set(k, v);
  }
  return out;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; usd8: string }>();
export function _clearPriceCacheForTest() {
  cache.clear();
}

/**
 * keys ("ETH" / 小文字 address) の現在単価。取れた分だけ返す。
 * Chainlink・換算は RPC がある時だけ。Llama は失敗しても空 map (throw しない)
 */
export async function priceEthAssetsNow(keys: string[], opts: { client?: PublicClient | null; now?: number } = {}): Promise<Map<string, string>> {
  const now = opts.now ?? Date.now();
  const wanted = [...new Set(keys.map((k) => (k === ETH_NATIVE_KEY ? k : k.toLowerCase())))];
  const out = new Map<string, string>();
  const todo = wanted.filter((k) => {
    const hit = cache.get(k);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      out.set(k, hit.usd8);
      return false;
    }
    return true;
  });
  if (todo.length === 0) return out;

  // Chainlink (derived の base も一緒に読む)
  const client = opts.client === undefined ? getEthClient() : opts.client;
  const feedKeys = new Set<string>();
  for (const k of todo) {
    if (CHAINLINK_BY_KEY[k]) feedKeys.add(k);
    const d = DERIVED[k];
    if (d && CHAINLINK_BY_KEY[d.base]) feedKeys.add(d.base);
  }
  const feeds = [...new Set([...feedKeys].map((k) => CHAINLINK_BY_KEY[k]!))];
  const feedPrices = new Map<PriceAsset, string | null>(
    client ? await Promise.all(feeds.map(async (f) => [f, chainlinkToUsd8(await getChainlinkPrice(f, now))] as const)) : []
  );
  const chainlink = new Map<string, string | null>();
  for (const k of feedKeys) chainlink.set(k, feedPrices.get(CHAINLINK_BY_KEY[k]!) ?? null);

  const derived = new Map<string, string>();
  if (client) {
    await Promise.all(
      todo.map(async (k) => {
        const d = DERIVED[k];
        const base = d && chainlink.get(d.base);
        if (!d || !base) return;
        try {
          derived.set(k, derivePrice(base, await d.read(client)));
        } catch {
          /* 換算に失敗したら Llama に任せる */
        }
      })
    );
  }

  const missing = todo.filter((k) => !chainlink.get(k) && !derived.get(k));
  const llama = missing.length ? await fetchLlamaCurrentPrices(missing, "ethereum") : new Map<string, string>();
  for (const [k, usd8] of mergePriceSources(todo, chainlink, derived, llama)) {
    out.set(k, usd8);
    cache.set(k, { at: now, usd8 });
  }
  return out;
}
