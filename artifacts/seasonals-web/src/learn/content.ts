/**
 * Learn の内容 (初学者向けのプロトコル解説、英語)。
 *
 * 規則 (捏造しない / 古びさせない):
 * - 各文は公式サイト / 公式 docs / 公式 GitHub で 2026-09-26 に確認した内容だけ。出典は sources に残す
 * - APY・TVL など変わる数値は書かない (Menu に live の値がある)。仕組み上の定数は公式 docs にあるものだけ
 * - 「安全」「保証」と断定しない。risks は必ず書く
 * - inSeasonals は実装済みのことだけ (実行は fork のみ、Aave は read-only など)
 * id は ProtocolBadge / brandStyle / Menu の protocolId と同じ。Solana は同じ形で後から足せる
 */
export interface LearnEntry {
  id: string;
  name: string;
  tagline: string;
  whatItIs: string;
  howItWorks: string[];
  strengths: string[];
  risks: string[];
  onYourCalendar: string[];
  inSeasonals: string;
  site: string;
  docs: string;
  sources: string[];
}

export const LEARN: LearnEntry[] = [
  {
    id: "lido",
    name: "Lido",
    tagline: "Stake ETH and keep a token you can still use.",
    whatItIs:
      "Lido stakes your ETH to help secure Ethereum and gives you stETH in return. stETH stands for the ETH you staked plus the rewards it earns, so you can hold or use it instead of locking your ETH away.",
    howItWorks: [
      "You send ETH to Lido and receive stETH.",
      "Once a day, when Lido's oracle reports validator balances, your stETH balance updates to include staking rewards.",
      "If you prefer a balance that never changes, wstETH wraps stETH: the number of tokens stays the same and each one becomes worth more stETH over time.",
      "To get ETH back, you request a withdrawal, wait for it to be finalized, then claim the ETH.",
    ],
    strengths: [
      "Earn Ethereum staking rewards without running your own validator.",
      "stETH and wstETH are regular tokens, so they stay usable while your ETH is staked.",
      "Withdrawals go through Lido's own queue, so you do not have to find a buyer.",
    ],
    risks: [
      "Withdrawals are not instant. Lido says they usually take 1–5 days under normal conditions, and they can take longer when the queue is busy.",
      "Each withdrawal request must be at least 100 wei and at most 1000 stETH, so large amounts are split into several requests.",
      "If validators are penalized (slashed), staked funds can be lost.",
      "On other markets stETH can trade below the ETH it represents, especially when withdrawals are slow.",
      "Like any smart contract, Lido's code can have bugs.",
    ],
    onYourCalendar: [
      "Pending withdrawal requests (the wait before they are finalized).",
      "Finalized withdrawals that are ready to claim, with a Claim ETH action.",
    ],
    inSeasonals:
      "From the Menu you can Deposit (stake ETH) and Withdraw (request a withdrawal). Plans are checked against Ethereum mainnet without being sent, and they only run on a local fork of mainnet. Your withdrawal requests and claims show up on the Calendar.",
    site: "https://lido.fi/",
    docs: "https://docs.lido.fi/",
    sources: [
      "https://docs.lido.fi/guides/lido-tokens-integration-guide",
      "https://help.lido.fi/en/articles/7858315-how-long-does-it-take-to-withdraw-steth",
    ],
  },
  {
    id: "ethena",
    name: "Ethena",
    tagline: "A synthetic dollar (USDe) and a staked version that earns rewards (sUSDe).",
    whatItIs:
      "USDe is a synthetic dollar. Instead of being backed by cash in a bank, it is backed by crypto assets that are paired with short futures positions of about the same size, so price moves in the crypto roughly cancel out. Staking USDe gives you sUSDe, which earns rewards.",
    howItWorks: [
      "Holding USDe by itself does not earn rewards. You stake it to receive sUSDe.",
      "Rewards come from staked-ETH yield and from the funding and basis spread on the hedge positions.",
      "Rewards are paid about every 8 hours and added gradually to sUSDe. In some periods there are no rewards, but they are never negative.",
      "To unstake, you start a cooldown. When it ends, you claim your USDe.",
    ],
    strengths: [
      "A dollar-like token that can earn rewards when you stake it.",
      "sUSDe is a standard vault token, so its value grows as rewards are added.",
      "Ethena documents its risks openly, including a reserve fund for negative funding periods.",
    ],
    risks: [
      "The cooldown changes with conditions. Ethena says it is currently between 1 and 7 days, it is set by governance, and the contract allows up to 90 days.",
      "Funding rates can stay negative for a long time, which reduces rewards.",
      "The hedges depend on centralized exchanges and custody providers, so their failure is a risk.",
      "The backing includes staked-ETH tokens, which carry their own risks.",
      "You can sometimes sell sUSDe instead of waiting for the cooldown, but there is no guarantee a market will exist.",
    ],
    onYourCalendar: ["The day your sUSDe cooldown ends and the USDe becomes claimable, with a Claim USDe action."],
    inSeasonals:
      "From the Menu you can Deposit USDe into sUSDe and Withdraw (start a cooldown). If you only have USDC, the Deposit panel can first swap it to USDe on Uniswap, after checking that USDe is still close to 1:1 with USDC. Everything runs only on a local fork of mainnet.",
    site: "https://ethena.fi/",
    docs: "https://docs.ethena.fi/",
    sources: [
      "https://docs.ethena.fi/",
      "https://docs.ethena.fi/overview/how-usde-works.md",
      "https://docs.ethena.fi/technical-design/staking-usde.md",
      "https://docs.ethena.fi/video-guides/how-to-stake-usde",
      "https://docs.ethena.fi/technical-design/staking-usde/staking-key-functions.md",
      "https://docs.ethena.fi/protocol-overview/risks/funding-risk.md",
      "https://docs.ethena.fi/protocol-overview/risks/custodial-risk.md",
      "https://docs.ethena.fi/protocol-overview/risks/exchange-failure-risk.md",
      "https://docs.ethena.fi/protocol-overview/risks/backing-assets-risk.md",
    ],
  },
  {
    id: "pendle",
    name: "Pendle",
    tagline: "Split a yield-bearing token into its principal (PT) and its future yield (YT).",
    whatItIs:
      "Pendle takes a token that earns yield and splits it into two parts with a maturity date: a Principal Token (PT) and a Yield Token (YT). You can buy either part, which lets you lock in a fixed yield or bet on the yield going up.",
    howItWorks: [
      "A yield-bearing token is wrapped into a standard form (SY) and split into PT and YT with the same maturity date.",
      "PT works like a zero-coupon bond: you buy it at a discount, and at maturity it redeems 1:1 for the asset named in brackets in its name. The discount is your fixed yield if you hold to maturity.",
      "YT collects the underlying token's yield until maturity. Its value moves toward zero as maturity approaches and is zero after it.",
      "The implied APY is the market's expectation of future yield, calculated from the prices of YT and PT.",
    ],
    strengths: [
      "PT gives a known return if you hold it until maturity.",
      "YT lets you get exposure to a token's yield without buying the whole token.",
      "Every market has a clear maturity date, which makes planning easy.",
    ],
    risks: [
      "If you sell PT before maturity, you get the market price, which can be higher or lower than you paid, even a loss.",
      "Time works against YT: its value falls to zero at maturity.",
      "Pendle relies on the protocol behind each token. If that protocol has a problem, PT and YT can lose value.",
      "Smart contract risk applies to Pendle and to the protocols it wraps.",
    ],
    onYourCalendar: [
      "The maturity date of each PT you hold. After maturity it shows as overdue with a Redeem PT action.",
      "Maturity dates of the most liquid markets, as public events.",
    ],
    inSeasonals:
      "The Menu lists the most liquid markets as PT and YT pairs. You can Deposit (buy) and Withdraw (sell) from each card. Before any trade, Seasonals compares Pendle's quote with Pendle's own on-chain 15-minute average price. It warns when they differ by more than 2%, refuses to run when they differ by more than 5%, and refuses when that price is not available. Trades run only on a local fork of mainnet.",
    site: "https://www.pendle.finance/",
    docs: "https://docs.pendle.finance/",
    sources: [
      "https://docs.pendle.finance/pendle-v2/ProtocolMechanics/Glossary",
      "https://docs.pendle.finance/pendle-v2/ProtocolMechanics/YieldTokenization/Minting",
      "https://docs.pendle.finance/pendle-v2/ProtocolMechanics/YieldTokenization/PT",
      "https://docs.pendle.finance/pendle-v2/ProtocolMechanics/YieldTokenization/YT",
      "https://docs.pendle.finance/pendle-academy/cheatsheet-for-the-impatient/pt-yt-lp-cheatsheet",
      "https://docs.pendle.finance/pendle-v2/FAQ",
    ],
  },
  {
    id: "uniswap",
    name: "Uniswap",
    tagline: "Swap tokens against shared liquidity, and join token auctions (CCA).",
    whatItIs:
      "Uniswap lets you swap one token for another against pools of liquidity that other people provide, instead of matching with a single seller. It also offers Continuous Clearing Auctions (CCA), where a new token is sold over time and everyone in the same block pays the same price.",
    howItWorks: [
      "Swaps trade against a liquidity pool. A small fee goes to the people who provide that liquidity.",
      "You set a slippage tolerance. If the price moves beyond it while your swap is pending, the swap fails instead of filling at a worse price.",
      "Before the first swap of a token, you approve Permit2 once. After that, each swap is authorized with a short-lived signed message.",
      "In a CCA, you place a bid with a budget and a maximum price. Tokens are sold block by block at a clearing price, between the auction's start and end.",
    ],
    strengths: [
      "Swaps work any time, without waiting for a counterparty.",
      "Slippage limits and deadlines protect you from filling at a much worse price.",
      "In a CCA everyone pays the same clearing price per block, and if the auction does not reach its target, bidders can get their full bid back.",
    ],
    risks: [
      "Large swaps move the price (price impact), so you may receive less than you expected.",
      "CCA bidders must check the auction's settings themselves: floor price, block range, target, and the token itself. A badly or maliciously configured auction can lose you money.",
      "Tokens from a CCA can only be claimed after the claim time, and only if the auction reached its target.",
    ],
    onYourCalendar: [
      "Public CCA auctions: when they end and when tokens can be claimed (times are estimated from block numbers).",
      "Your own bids, with Exit bid (refund) or Claim tokens when they become available.",
    ],
    inSeasonals:
      "The Calendar indexes CCA auctions and your bids from Ethereum mainnet. The Ethena Deposit panel uses the Uniswap Trading API to quote USDC → USDe and can run the swap on a local fork.",
    site: "https://uniswap.org/",
    docs: "https://developers.uniswap.org/",
    sources: [
      "https://developers.uniswap.org/docs/get-started/concepts/traders/swaps",
      "https://developers.uniswap.org/docs/trading/swapping-api/getting-started",
      "https://developers.uniswap.org/docs/trading/swapping-api/concepts/permit2",
      "https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/concepts/cca",
      "https://github.com/Uniswap/continuous-clearing-auction/blob/main/docs/TechnicalDocumentation.md",
    ],
  },
  {
    id: "aqua",
    name: "1inch Aqua",
    tagline: "Provide liquidity while your tokens stay in your own wallet.",
    whatItIs:
      "Aqua is 1inch's shared liquidity layer. Instead of depositing tokens into a pool, you approve Aqua once and describe how your tokens may be traded. Your tokens stay in your wallet until a swap actually fills.",
    howItWorks: [
      "You give Aqua one token approval. Aqua keeps records of allowances; it does not hold your tokens.",
      "You ship a strategy: a position with a token pair, a price range and a fee. One wallet balance can back several strategies.",
      "When a trader's swap matches your strategy, 1inch's SwapVM engine runs it. If your balance is too low at that moment, the swap simply reverts.",
      "A shipped strategy cannot be edited. To change it, you dock (remove) it and ship a new one. Revoking the approval stops new fills.",
    ],
    strengths: [
      "Your tokens never leave your wallet until a trade happens.",
      "The same balance can support more than one strategy.",
      "You stay in control: removing a strategy or the approval stops trading.",
    ],
    risks: [
      "1inch notes that smart contract risk, impermanent loss and market risk remain.",
      "Swap fees are not guaranteed.",
      "Only use the official Aqua contracts that 1inch lists; anything else is not Aqua.",
    ],
    onYourCalendar: ["A review date for each strategy you ship from Seasonals, so you remember to check or dock it."],
    inSeasonals:
      "On the Agent page, the LP sleeve ships a USDC/USDe strategy, fills it and docks it, all on a local fork of mainnet. Shipping is refused if the Chainlink USDe/USDC price is stale or off by more than 0.5%.",
    site: "https://1inch.com/aqua/learn",
    docs: "https://github.com/1inch/aqua",
    sources: ["https://1inch.com/aqua/learn", "https://github.com/1inch/aqua"],
  },
  {
    id: "aave",
    name: "Aave",
    tagline: "Lend your tokens for interest, or borrow against them.",
    whatItIs:
      "Aave is a lending protocol where you keep custody through smart contracts. Suppliers deposit tokens and earn interest. Borrowers post collateral worth more than what they borrow. Aave V4 is live on Ethereum, organized into Liquidity Hubs that hold funds and Spokes that set their own rules.",
    howItWorks: [
      "Supply tokens to earn interest. The rate changes with market conditions and comes from what borrowers pay.",
      "To borrow, you first supply collateral that is worth more than the loan.",
      "Your health factor compares your collateral, adjusted by its liquidation threshold, with your debt. If it falls below 1, your position can be liquidated.",
      "In a liquidation, someone repays part of your debt and receives some of your collateral plus a bonus. Adding collateral or repaying debt raises your health factor.",
    ],
    strengths: [
      "Earn interest on tokens you are not using.",
      "Borrow without selling what you hold.",
      "Rules are enforced by smart contracts rather than a company.",
    ],
    risks: [
      "If prices move against you and your health factor drops below 1, part of your collateral can be sold at a discount.",
      "Aave depends on price oracles from third parties.",
      "Smart contracts can have bugs.",
      "Interest rates change with market conditions.",
    ],
    onYourCalendar: [
      "Aave positions have no fixed dates, so they do not create calendar events. Seasonals shows them as context on the Dashboard instead.",
    ],
    inSeasonals: "The Dashboard shows read-only context for Aave V4 positions of the addresses you watch. Seasonals does not supply, borrow or repay on Aave.",
    site: "https://aave.com/",
    docs: "https://aave.com/docs",
    sources: ["https://aave.com/docs", "https://aave.com/faq", "https://aave.com/help/borrowing/liquidations", "https://aave.com/blog/aave-v4-live-ethereum", "https://aave.com/docs/aave-v4"],
  },
];
