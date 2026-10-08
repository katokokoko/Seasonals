/**
 * oracle-feeds — registry と oracle 設定の整合 (§32.2、CLAUDE.md §4)。
 * Menu に asset を足したのに tier を宣言し忘れると、ここが落ちる。
 */
import { SWAP_EARN_MARKETS } from "./swap-earn-markets";
import { KAMINO_MARKETS, KAMINO_VAULTS } from "./kamino-markets";
import { SAVE_MARKETS } from "./save-markets";
import { EXPONENT_MARKETS } from "./exponent-markets";
import { METEORA_MARKETS } from "./meteora-markets";
import { ORCA_MARKETS } from "./orca-markets";
import {
  isGatedTier,
  ORACLE_FEEDS,
  oracleFeedForMint,
  oracleMintForSymbol,
  pythFeedIdForSymbol,
  PYTH_PUSH_MAX_AGE_S,
  REDSTONE_GATEWAY_MAX_AGE_S,
  REDSTONE_GATEWAY_MIN_SIGNERS,
  REDSTONE_PRIMARY_SIGNERS,
  REDSTONE_PUSH_MAX_AGE_S,
} from "./oracle-feeds";

/** gate が引く mint (lib/derive/oracle-gate.ts resolveOracleMint が返し得るもの) */
function gatedMints(): Array<[string, string]> {
  return [
    ...SWAP_EARN_MARKETS.map((m) => [m.underlying_mint, `swap-earn ${m.protocol_id} ${m.underlying_symbol}`] as [string, string]),
    ...KAMINO_MARKETS.map((m) => [m.underlying_mint, `kamino ${m.pool_id}`] as [string, string]),
    ...KAMINO_VAULTS.map((m) => [m.underlying_mint, `kamino vault ${m.pool_id}`] as [string, string]),
    ...SAVE_MARKETS.map((m) => [m.underlying_mint, `save ${m.pool_id}`] as [string, string]),
    ...EXPONENT_MARKETS.map((m) => [m.underlying_mint, `exponent ${m.underlying_symbol}`] as [string, string]),
    ...METEORA_MARKETS.map((m) => [m.deposit_mint, `meteora ${m.pool_id}`] as [string, string]),
    ...ORCA_MARKETS.map((m) => [m.deposit_mint, `orca ${m.pool_id}`] as [string, string]),
  ];
}

describe("ORACLE_FEEDS × registry", () => {
  it("gate が引く全 mint に tier が宣言されている (無ければ Menu に足す前に tier を決める)", () => {
    const missing = gatedMints().filter(([mint]) => !oracleFeedForMint(mint));
    expect(missing).toEqual([]);
  });

  it.each(Object.entries(ORACLE_FEEDS))("%s: tier ごとの必須項目", (_mint, f) => {
    if (f.tier === "A") {
      expect(f.pythFeedId).toMatch(/^[0-9a-f]{64}$/);
      expect(f.redstoneFeedId).toBeTruthy();
    }
    if (f.tier === "B" || f.tier === "C") expect(f.pythFeedId).toMatch(/^[0-9a-f]{64}$/);
    if (f.tier === "B") {
      expect(f.redstoneGatewayFeedId).toBeTruthy();
      expect(f.redstoneFeedId).toBeUndefined();
    }
    if (f.tier === "C") {
      expect(f.redstoneFeedId).toBeUndefined();
      expect(f.redstoneGatewayFeedId).toBeUndefined();
    }
    if (f.tier === "A") expect(f.redstoneGatewayFeedId).toBeUndefined();
    // feed 別の Pyth 閾値は「既定より長くする」ためだけに使う
    if (f.pythMaxAgeS !== undefined) expect(f.pythMaxAgeS).toBeGreaterThan(PYTH_PUSH_MAX_AGE_S);
    if (f.tier === "D") {
      expect(f.reason).toBeTruthy();
      expect(f.pythFeedId).toBeUndefined();
      expect(f.redstoneFeedId).toBeUndefined();
    }
    // RedStone の feed id は 32 byte の seed に収まる ASCII
    if (f.redstoneFeedId) expect(f.redstoneFeedId).toMatch(/^[\x20-\x7e]{1,32}$/);
  });

  it("RedStone gateway の signer allow-list は 0x 40 hex、quorum はその数以下", () => {
    expect(REDSTONE_PRIMARY_SIGNERS).toHaveLength(5);
    for (const a of REDSTONE_PRIMARY_SIGNERS) expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(new Set(REDSTONE_PRIMARY_SIGNERS.map((a) => a.toLowerCase())).size).toBe(5);
    expect(REDSTONE_GATEWAY_MIN_SIGNERS).toBeGreaterThanOrEqual(3);
    expect(REDSTONE_GATEWAY_MIN_SIGNERS).toBeLessThanOrEqual(REDSTONE_PRIMARY_SIGNERS.length);
  });
});

describe("symbol lookup", () => {
  it("gate のある tier だけ symbol から引ける (WSOL は SOL)", () => {
    expect(oracleMintForSymbol("SOL")).toBe("So11111111111111111111111111111111111111112");
    expect(oracleMintForSymbol("WSOL")).toBe("So11111111111111111111111111111111111111112");
    expect(oracleMintForSymbol("USDT")).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(oracleMintForSymbol("USDG")).toBe("2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH"); // tier B
    expect(oracleMintForSymbol("USDS")).toBeUndefined(); // tier D
    expect(oracleMintForSymbol("NOPE")).toBeUndefined();
  });
  it("pythFeedIdForSymbol は gate と同じ feed", () => {
    expect(pythFeedIdForSymbol("USDC")).toBe(ORACLE_FEEDS.EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v!.pythFeedId);
    expect(pythFeedIdForSymbol("USDS")).toBeUndefined();
  });
  it("isGatedTier", () => {
    expect(isGatedTier("A")).toBe(true);
    expect(isGatedTier("C")).toBe(true);
    expect(isGatedTier("D")).toBe(false);
  });
});

test("staleness 閾値は heartbeat (Pyth 55s / RedStone 60s / gateway 10s 刻み) より長い", () => {
  expect(PYTH_PUSH_MAX_AGE_S).toBeGreaterThan(55);
  expect(REDSTONE_PUSH_MAX_AGE_S).toBeGreaterThan(60);
  expect(REDSTONE_GATEWAY_MAX_AGE_S).toBeGreaterThan(10);
});
