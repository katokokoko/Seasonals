import { encodeAbiParameters } from "viem";
import { auctionParametersAbi } from "./abis";
import { decodeAuctionCreated, deriveAuctionPublicEvents, deriveBidEvents, type CcaAuction } from "./cca";

const params = {
  currency: "0x0000000000000000000000000000000000000000",
  tokensRecipient: "0x0000000000000000000000000000000000000001",
  fundsRecipient: "0x0000000000000000000000000000000000000002",
  startBlock: 100n,
  endBlock: 1_000n,
  claimBlock: 1_100n,
  tickSpacing: 1n,
  validationHook: "0x0000000000000000000000000000000000000000",
  floorPrice: 79228162514264337593543950336n,
  requiredCurrencyRaised: 5n * 10n ** 18n,
  auctionStepsData: "0x",
} as const;

const auction = (over: Partial<CcaAuction> = {}): CcaAuction => ({
  auction: "0xAuc",
  token: "0x1234567890123456789012345678901234567890",
  factory: "0xFac",
  amount: "1000000000000000000000",
  currency: params.currency,
  startBlock: "100",
  endBlock: "1000",
  claimBlock: "1100",
  floorPriceQ96: "1",
  requiredCurrencyRaised: "5000000000000000000",
  createdBlock: "90",
  tokenSymbol: "XYZ",
  tokenDecimals: 18,
  currencySymbol: "ETH",
  currencyDecimals: 18,
  graduated: null,
  ...over,
});
const NOW = "2026-09-26T00:00:00.000Z";
const head = (block: number) => ({ block, timestampSec: Date.parse(NOW) / 1000 });

test("decodes AuctionCreated configData (AuctionParameters)", () => {
  const configData = encodeAbiParameters(auctionParametersAbi, [params]);
  const a = decodeAuctionCreated({ address: "0xFac", blockNumber: 90n, args: { auction: "0xAuc", token: "0xTok", amount: 10n, configData } })!;
  expect(a).toMatchObject({ auction: "0xAuc", startBlock: "100", endBlock: "1000", claimBlock: "1100", requiredCurrencyRaised: "5000000000000000000", amount: "10" });
  expect(decodeAuctionCreated({ address: "0xFac", blockNumber: 1n, args: { auction: "0xA", token: "0xT", amount: 1n, configData: "0x1234" } })).toBeNull();
});

test("public events: start (future) / end / claim with approximate block times, wallet-independent", () => {
  const ev = deriveAuctionPublicEvents(auction(), head(50), NOW);
  expect(ev.map((e) => e.kind)).toEqual(["auction_start", "auction_end", "auction_claim"]);
  expect(ev.every((e) => e.atApprox && !e.requiresWallet)).toBe(true);
  // end block は head から 950 block 先 = 950 × 12 秒後
  expect(Date.parse(ev[1]!.at!) - Date.parse(NOW)).toBe(950 * 12 * 1000);
  expect(ev[1]!.metrics.some((m) => m.label === "Risk")).toBe(true);
  // claim == end なら 1 件に畳む、非 graduate なら claim を出さない
  expect(deriveAuctionPublicEvents(auction({ claimBlock: "1000" }), head(500), NOW).map((e) => e.kind)).toEqual(["auction_end"]);
  expect(deriveAuctionPublicEvents(auction({ graduated: false }), head(2000), NOW).map((e) => e.kind)).toEqual(["auction_end"]);
});

test("bid lifecycle: exit after end, claim after claim block when graduated and exited, refund when not graduated", () => {
  const bid = { auction: "0xAuc", bidId: "7", priceQ96: "1", amount: "100", exited: false, claimed: false };
  const live = deriveBidEvents("0xO", auction(), bid, head(500), NOW);
  expect(live.map((e) => [e.kind, e.actions[0]!.availability])).toEqual([
    ["auction_end", "not_yet"],
    ["auction_claim", "not_yet"],
  ]);
  const ended = deriveBidEvents("0xO", auction({ graduated: true }), bid, head(1050), NOW);
  expect(ended[0]!.actions[0]).toMatchObject({ actionType: "cca_exit_bid", availability: "available", params: { auction: "0xAuc", bidId: "7" } });
  const claimable = deriveBidEvents("0xO", auction({ graduated: true }), { ...bid, exited: true }, head(1200), NOW);
  expect(claimable[1]!.actions[0]).toMatchObject({ actionType: "cca_claim", availability: "available" });
  const refund = deriveBidEvents("0xO", auction({ graduated: false }), bid, head(1200), NOW);
  expect(refund.map((e) => e.kind)).toEqual(["auction_refund"]);
  expect(refund[0]!.actions[0]!.availability).toBe("available");
  expect(refund[0]!.amount).toEqual({ value: "100", decimals: 18, symbol: "ETH" });
});
