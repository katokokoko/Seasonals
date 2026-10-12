import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** Ethena StakedUSDeV2 (ERC-4626 + cooldown) */
export const sUSDeAbi = parseAbi([
  "function cooldownDuration() view returns (uint24)",
  "function cooldowns(address) view returns (uint104 cooldownEnd, uint152 underlyingAmount)",
  "function silo() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function cooldownShares(uint256 shares) returns (uint256)",
  "function unstake(address receiver)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
]);

/** Lido WithdrawalQueueERC721 */
export const withdrawalQueueAbi = parseAbi([
  "struct WithdrawalRequestStatus { uint256 amountOfStETH; uint256 amountOfShares; address owner; uint256 timestamp; bool isFinalized; bool isClaimed; }",
  "function getWithdrawalRequests(address _owner) view returns (uint256[] requestsIds)",
  "function getWithdrawalStatus(uint256[] _requestIds) view returns (WithdrawalRequestStatus[] statuses)",
  "function getLastCheckpointIndex() view returns (uint256)",
  "function findCheckpointHints(uint256[] _requestIds, uint256 _firstIndex, uint256 _lastIndex) view returns (uint256[] hintIds)",
  "function claimWithdrawal(uint256 _requestId)",
  "function MIN_STETH_WITHDRAWAL_AMOUNT() view returns (uint256)",
  "function MAX_STETH_WITHDRAWAL_AMOUNT() view returns (uint256)",
  "function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[] requestIds)",
  "function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[] requestIds)",
  "event WithdrawalRequested(uint256 indexed requestId, address indexed requestor, address indexed owner, uint256 amountOfStETH, uint256 amountOfShares)",
]);

/** Uniswap CCA (v1.1.0 〜 v2.1.0 で event の型は同一 = topic 同一) */
export const ccaFactoryAbi = parseAbi([
  "event AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)",
]);
export const ccaAuctionAbi = parseAbi([
  "event BidSubmitted(uint256 indexed id, address indexed owner, uint256 priceQ96, uint128 amount)",
  "event BidExited(uint256 indexed bidId, address indexed owner, uint256 tokensFilled, uint256 currencyRefunded)",
  "event TokensClaimed(uint256 indexed bidId, address indexed owner, uint256 tokensFilled)",
  "function isGraduated() view returns (bool)",
  "function clearingPrice() view returns (uint256)",
  "function exitBid(uint256 bidId)",
  "function claimTokens(uint256 bidId)",
]);
/** abi.encode(AuctionParameters) — v1.0.0〜v2.1.0 同一 */
export const auctionParametersAbi = [
  {
    type: "tuple",
    components: [
      { name: "currency", type: "address" },
      { name: "tokensRecipient", type: "address" },
      { name: "fundsRecipient", type: "address" },
      { name: "startBlock", type: "uint64" },
      { name: "endBlock", type: "uint64" },
      { name: "claimBlock", type: "uint64" },
      { name: "tickSpacing", type: "uint256" },
      { name: "validationHook", type: "address" },
      { name: "floorPrice", type: "uint256" },
      { name: "requiredCurrencyRaised", type: "uint128" },
      { name: "auctionStepsData", type: "bytes" },
    ],
  },
] as const;

/** ERC-20 の approve / allowance (plan の approval step 用) */
export const erc20ApproveAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** Lido stETH (submit で ETH を stake) と wstETH の換算 */
export const stETHAbi = parseAbi(["function submit(address _referral) payable returns (uint256)"]);
export const wstETHAbi = parseAbi([
  "function getStETHByWstETH(uint256 _wstETHAmount) view returns (uint256)",
  "function getWstETHByStETH(uint256 _stETHAmount) view returns (uint256)",
]);

/** Pendle PYLpOracle (TWAP) と SY (standardized yield) の換算 */
export const pendleOracleAbi = parseAbi([
  "function getOracleState(address market, uint32 duration) view returns (bool increaseCardinalityRequired, uint16 cardinalityRequired, bool oldestObservationSatisfied)",
  "function getPtToSyRate(address market, uint32 duration) view returns (uint256)",
  "function getYtToSyRate(address market, uint32 duration) view returns (uint256)",
]);
export const pendleSyAbi = parseAbi([
  "function previewDeposit(address tokenIn, uint256 amountTokenToDeposit) view returns (uint256 amountSharesOut)",
  "function previewRedeem(address tokenOut, uint256 amountSharesToRedeem) view returns (uint256 amountTokenOut)",
]);
