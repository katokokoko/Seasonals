/**
 * exponent-markets registry test (Phase 8.33)
 *
 * 時限爆弾なし: activeExponentMarkets は nowSec 注入、maturity は snapshot の
 * 固定値と相対比較のみ (wall-clock 不使用)。
 */
import {
  EXPONENT_MARKETS,
  activeExponentMarkets,
  exponentMaturityIso,
  exponentPoolId,
  exponentPoolName,
  findExponentMarketByPtMint,
  findExponentMarketByYtMint,
} from "./exponent-markets";

describe("EXPONENT_MARKETS registry", () => {
  it("pt_mint / yt_mint / market_id が一意", () => {
    const pts = EXPONENT_MARKETS.map((m) => m.pt_mint);
    const yts = EXPONENT_MARKETS.map((m) => m.yt_mint);
    const ids = EXPONENT_MARKETS.map((m) => m.market_id);
    expect(new Set(pts).size).toBe(pts.length);
    expect(new Set(yts).size).toBe(yts.length);
    expect(new Set(ids).size).toBe(ids.length);
    // PT と YT が衝突しない
    expect(pts.some((p) => yts.includes(p))).toBe(false);
  });

  it("全 entry のフィールド sanity (mint 非空 / decimals 整数 / maturity 正)", () => {
    for (const m of EXPONENT_MARKETS) {
      expect(m.protocol_id).toBe("exponent");
      expect(m.underlying_mint.length).toBeGreaterThanOrEqual(32);
      expect(m.pt_mint.length).toBeGreaterThanOrEqual(32);
      expect(m.yt_mint.length).toBeGreaterThanOrEqual(32);
      expect(Number.isInteger(m.underlying_decimals)).toBe(true);
      expect(Number.isInteger(m.pt_decimals)).toBe(true);
      expect(Number.isInteger(m.maturity_ts)).toBe(true);
      expect(m.maturity_ts).toBeGreaterThan(0);
      expect(m.implied_apy).toBeGreaterThan(0);
      expect(m.quote_ticker.length).toBeGreaterThan(0);
      expect(m.market_id).toBe(
        exponentPoolId(m.underlying_symbol, m.maturity_ts)
      );
    }
  });

  it("resolver: pt_mint / yt_mint で引ける、未知 mint は undefined", () => {
    const usx = EXPONENT_MARKETS.find((m) => m.underlying_symbol === "USX")!;
    expect(findExponentMarketByPtMint(usx.pt_mint)).toBe(usx);
    expect(findExponentMarketByYtMint(usx.yt_mint)).toBe(usx);
    expect(findExponentMarketByPtMint("UnknownMint111111111111111111111111")).toBeUndefined();
    expect(findExponentMarketByYtMint(usx.pt_mint)).toBeUndefined(); // 側の取り違え防止
  });

  it("activeExponentMarkets: nowSec 注入で満期を除外 (時限爆弾なし)", () => {
    const earliest = Math.min(...EXPONENT_MARKETS.map((m) => m.maturity_ts));
    const latest = Math.max(...EXPONENT_MARKETS.map((m) => m.maturity_ts));
    // 全 market 満期前
    expect(activeExponentMarkets(EXPONENT_MARKETS, earliest - 1)).toHaveLength(
      EXPONENT_MARKETS.length
    );
    // 最短満期ちょうど → その market は除外 (maturity_ts > nowSec)
    const afterEarliest = activeExponentMarkets(EXPONENT_MARKETS, earliest);
    expect(afterEarliest.length).toBeLessThan(EXPONENT_MARKETS.length);
    // 全満期後 → 空
    expect(activeExponentMarkets(EXPONENT_MARKETS, latest)).toHaveLength(0);
  });

  it("exponentPoolId / Name: UTC 日付整形 + ticker 英数正規化 (hyloSOL+ 対策)", () => {
    // 2026-09-16T04:38:20Z (1789552700)
    expect(exponentPoolId("USX", 1789552700)).toBe("exponent_pt_usx_20260916");
    expect(exponentPoolName("USX", 1789552700)).toBe("PT USX · 2026-09-16");
    expect(exponentPoolId("hyloSOL+", 1786535900)).toBe(
      "exponent_pt_hylosolplus_20260812"
    );
    // hyloSOL と hyloSOL+ は同 maturity でも衝突しない
    expect(exponentPoolId("hyloSOL", 1786535900)).not.toBe(
      exponentPoolId("hyloSOL+", 1786535900)
    );
    expect(exponentMaturityIso(1789552700)).toBe("2026-09-16T09:58:20.000Z");
  });
});
