/**
 * Menu 商品ごとの保有量 (GET /eth/holdings、Menu の「Deposited only」トグル用)。
 *
 * - 残高の正は mainnet の on-chain balanceOf。Pendle dashboard は「どの market を持っているか」の索引にだけ使う
 * - USD は Pendle の評価額が取れた時だけ付ける (Lido / Ethena は価格を推測しない)
 * - source ごとに隔離し、失敗は failed[] に記録する (失敗分を「保有なし」と見せない)
 */
import type { MenuHolding, MenuHoldingsResponse, MenuProduct } from "@workspace/lib/types";
import { erc20Abi, sUSDeAbi } from "./abis";
import { getEthClient } from "./client";
import { usdNumberTo8 } from "./common";
import { ETHENA, LIDO } from "./config";
import { getEthMenu, pendleMenuProducts } from "./menu";
import { fetchPendleMarkets, fetchPendleOpenPositions, stripChainPrefix, type PendleMarket, type PendlePosition } from "./pendle";

export const LIDO_PRODUCT_ID = "ethereum:lido:steth";
export const ETHENA_PRODUCT_ID = "ethereum:ethena:susde";

type Client = NonNullable<ReturnType<typeof getEthClient>>;

async function balanceOf(client: Client, token: string, owner: string): Promise<bigint> {
  return (await client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [owner as `0x${string}`] })) as bigint;
}

async function lidoHolding(client: Client, owner: string): Promise<MenuHolding | null> {
  const [st, wst] = await Promise.all([balanceOf(client, LIDO.stETH, owner), balanceOf(client, LIDO.wstETH, owner)]);
  const amounts = [
    ...(st > 0n ? [{ value: st.toString(), decimals: 18, symbol: "stETH" }] : []),
    ...(wst > 0n ? [{ value: wst.toString(), decimals: 18, symbol: "wstETH" }] : []),
  ];
  return amounts.length ? { productId: LIDO_PRODUCT_ID, amounts } : null;
}

async function ethenaHolding(client: Client, owner: string): Promise<MenuHolding | null> {
  const [shares, cd] = await Promise.all([
    balanceOf(client, ETHENA.sUSDe, owner),
    client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "cooldowns", args: [owner as `0x${string}`] }) as Promise<readonly [bigint, bigint]>,
  ]);
  const [end, cooling] = cd;
  if (shares === 0n && cooling === 0n) return null;
  return {
    productId: ETHENA_PRODUCT_ID,
    amounts: shares > 0n ? [{ value: shares.toString(), decimals: 18, symbol: "sUSDe" }] : [],
    ...(cooling > 0n
      ? { pending: { label: "Cooling down", amount: { value: cooling.toString(), decimals: 18, symbol: "USDe" }, endsAt: new Date(Number(end) * 1000).toISOString() } }
      : {}),
  };
}

/**
 * Pendle: dashboard の open positions で market を特定し、PT / YT の残高は on-chain で読む。
 * product id は pendleMenuProducts と同じ (`ethereum:pendle:{pt|yt}:<market>`)。
 */
export function pendleHoldingsFrom(
  positions: PendlePosition[],
  markets: PendleMarket[],
  onchain: Map<string, { balance: bigint; decimals: number }>
): { holdings: MenuHolding[]; heldMarkets: PendleMarket[] } {
  const byAddr = new Map(markets.map((m) => [m.address.toLowerCase(), m]));
  const holdings: MenuHolding[] = [];
  const held = new Map<string, PendleMarket>();
  for (const p of positions) {
    const m = byAddr.get(stripChainPrefix(p.marketId).toLowerCase());
    if (!m) continue;
    for (const kind of ["pt", "yt"] as const) {
      const token = stripChainPrefix(m[kind]).toLowerCase();
      const bal = onchain.get(token);
      if (!bal || bal.balance === 0n) continue;
      const usd = usdNumberTo8(p[kind]?.valuation);
      holdings.push({
        productId: `ethereum:pendle:${kind}:${m.address.toLowerCase()}`,
        amounts: [{ value: bal.balance.toString(), decimals: bal.decimals, symbol: `${kind.toUpperCase()}-${m.name}` }],
        ...(usd && Number(usd) > 0 ? { usd } : {}),
      });
      held.set(m.address.toLowerCase(), m);
    }
  }
  return { holdings, heldMarkets: [...held.values()] };
}

async function pendleHoldings(client: Client, owner: string) {
  const positions = await fetchPendleOpenPositions(owner);
  if (positions.length === 0) return { holdings: [], heldMarkets: [] as PendleMarket[] };
  const markets = await fetchPendleMarkets();
  const byAddr = new Map(markets.map((m) => [m.address.toLowerCase(), m]));
  const tokens = [
    ...new Set(
      positions.flatMap((p) => {
        const m = byAddr.get(stripChainPrefix(p.marketId).toLowerCase());
        return m ? [stripChainPrefix(m.pt).toLowerCase(), stripChainPrefix(m.yt).toLowerCase()] : [];
      })
    ),
  ];
  const calls = tokens.flatMap((t) => [
    { address: t as `0x${string}`, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner as `0x${string}`] as const },
    { address: t as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
  ]);
  const res = await client.multicall({ contracts: calls, allowFailure: true });
  const onchain = new Map<string, { balance: bigint; decimals: number }>();
  tokens.forEach((t, i) => {
    const b = res[i * 2];
    const d = res[i * 2 + 1];
    if (b?.status === "success" && d?.status === "success") onchain.set(t, { balance: b.result as bigint, decimals: Number(d.result) });
  });
  return pendleHoldingsFrom(positions, markets, onchain);
}

const cache = new Map<string, { at: number; value: MenuHoldingsResponse }>();

export function _invalidateHoldings(owner?: string) {
  if (owner) cache.delete(owner.toLowerCase());
  else cache.clear();
}

export async function getMenuHoldings(owner: string): Promise<MenuHoldingsResponse> {
  const key = owner.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value.failed.length ? 10_000 : 60_000)) return hit.value;
  const observedAt = new Date().toISOString();
  const client = getEthClient();
  if (!client) return { address: owner, holdings: [], extraProducts: [], failed: ["rpc"], observedAt };

  const [lido, ethena, pendle, menu] = await Promise.allSettled([
    lidoHolding(client, owner),
    ethenaHolding(client, owner),
    pendleHoldings(client, owner),
    getEthMenu(),
  ]);
  const failed: string[] = [];
  const holdings: MenuHolding[] = [];
  if (lido.status === "fulfilled") lido.value && holdings.push(lido.value);
  else failed.push("lido");
  if (ethena.status === "fulfilled") ethena.value && holdings.push(ethena.value);
  else failed.push("ethena");
  let extraProducts: MenuProduct[] = [];
  if (pendle.status === "fulfilled") {
    holdings.push(...pendle.value.holdings);
    const listed = new Set(menu.status === "fulfilled" ? menu.value.map((p) => p.id) : []);
    extraProducts = pendleMenuProducts(pendle.value.heldMarkets, observedAt, Number.POSITIVE_INFINITY).filter(
      (p) => !listed.has(p.id) && pendle.value.holdings.some((h) => h.productId === p.id)
    );
  } else failed.push("pendle");

  const value: MenuHoldingsResponse = { address: owner, holdings, extraProducts, failed, observedAt };
  cache.set(key, { at: Date.now(), value });
  return value;
}
