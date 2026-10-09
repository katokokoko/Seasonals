/**
 * Learn の内容 (初学者向けのプロトコル解説、英語)。
 *
 * 規則 (捏造しない / 古びさせない):
 * - 各文は公式サイト / 公式 docs / 公式 GitHub で確認した内容だけ (Ethereum は 2026-09-26、Solana は 2026-10-08)。出典は sources に残す
 * - APY・TVL など変わる数値は書かない (Menu に live の値がある)。仕組み上の定数は公式 docs にあるものだけ
 * - 「安全」「保証」と断定しない。risks は必ず書く
 * - inSeasonals は実装済みのことだけ (Ethereum の実行は fork のみ、Aave は read-only。Solana は wallet 署名で mainnet、
 *   swap-earn 系の withdraw は protocol の unstake ではなく swap)
 * id は ProtocolBadge / brandStyle / Menu の protocolId (Solana は menu-listings の protocol_id) と同じ。
 * chain は Learn の chain filter と並び順 (learn/filter.ts) に使う
 */
import type { ChainId } from "@workspace/lib/config/chains";

export interface LearnEntry {
  id: string;
  /** Menu の MenuProduct.chain と同じ型。Learn の chain filter と並び順に使う */
  chain: ChainId;
  name: string;
  tagline: string;
  /** 一覧カードの 3 行: 何ができるか / 一番の利点 / 一番の注意点 (下の裏取り済みの文の要約だけ) */
  keyPoints: [string, string, string];
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
    chain: "ethereum",
    name: "Lido",
    tagline: "Stake ETH and keep a token you can still use.",
    keyPoints: [
      "Stake ETH and get stETH, which earns staking rewards.",
      "Your staked ETH stays usable as a token.",
      "Withdrawals wait in a queue, usually 1\u20135 days.",
    ],
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
    chain: "ethereum",
    name: "Ethena",
    tagline: "A synthetic dollar (USDe) and a staked version that earns rewards (sUSDe).",
    keyPoints: [
      "Stake the USDe synthetic dollar to get sUSDe, which earns rewards.",
      "Rewards come from staked ETH and hedge funding.",
      "Unstaking needs a cooldown that Ethena can change.",
    ],
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
    chain: "ethereum",
    name: "Pendle",
    tagline: "Split a yield-bearing token into its principal (PT) and its future yield (YT).",
    keyPoints: [
      "Buy PT for a fixed return if held to maturity.",
      "YT collects the yield until maturity.",
      "Selling early gets the market price; YT is worth 0 after maturity.",
    ],
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
    chain: "ethereum",
    name: "Uniswap",
    tagline: "Swap tokens against shared liquidity, and join token auctions (CCA).",
    keyPoints: [
      "Swap tokens against shared liquidity pools.",
      "Bid in token auctions where everyone pays the same price per block.",
      "Check slippage, and check an auction's settings before bidding.",
    ],
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
    chain: "ethereum",
    name: "1inch Aqua",
    tagline: "Provide liquidity while your tokens stay in your own wallet.",
    keyPoints: [
      "Provide liquidity without moving tokens out of your wallet.",
      "One balance can back several strategies.",
      "Smart contract and market risk remain; fees are not guaranteed.",
    ],
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
    chain: "ethereum",
    name: "Aave",
    tagline: "Lend your tokens for interest, or borrow against them.",
    keyPoints: [
      "Lend tokens for interest, or borrow against them.",
      "Borrow without selling what you hold.",
      "If your health factor drops below 1, you can be liquidated.",
    ],
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
  // ── Solana (2026-10-08 に公式 docs で確認。Jito の docs は bot 対策で fetch を拒むので Chrome で同日に読んだ) ──
  // 共通の実装事実: deposit / withdraw は wallet 署名 → Seasonals server 経由で mainnet 送信。oracle gate は
  // 動かす側の asset (SOL / USDC) に対して Pyth + RedStone (CLAUDE.md §4: 2% warning / 5% refuse / both stale refuse)。
  // swap-earn 系 (Jito / Marinade / Sanctum / Perena / Solstice / Hylo / Jupiter Lend) は Jupiter swap で share token に
  // 出入りし、withdraw は protocol の unstake ではなく swap。jitoSOL / mSOL / INF は fair-value guard (償還価値から
  // 2% 超の不利で拒否、fair-value.ts)。epoch イベントは SOL 系 share (jitoSOL / mSOL / INF / hyloSOL) 保有時のみ。
  {
    id: "jupiter",
    chain: "solana",
    name: "Jupiter",
    tagline: "Lend tokens on Jupiter Lend and hold a receipt token that grows with interest.",
    keyPoints: [
      "Deposit USDC or SOL into Jupiter Lend and receive a jlToken that grows as borrowers pay interest.",
      "No lock-up: withdraw any time by redeeming the jlToken.",
      "Withdrawals can be limited while most of the pool is lent out.",
    ],
    whatItIs:
      "Jupiter is Solana's main swap aggregator, and Jupiter Lend is its lending market. On the Earn side you supply a token to a pool, borrowers pay interest on it, and you hold a jlToken (for example jlUSDC) that represents your share of the pool.",
    howItWorks: [
      "You deposit a token into its Earn pool and receive the matching jlToken in your wallet. Jupiter calls it the only on-chain proof of your deposit, so do not burn or discard it.",
      "Borrowers pay interest on what they borrow. That interest is shared across all lenders, so the jlToken's value in the underlying token rises over time while your jlToken balance stays the same.",
      "To withdraw, you redeem jlTokens for the underlying token plus the interest earned.",
      "Withdrawals use a limit that grows block by block. If most of the pool is lent out, you may have to withdraw in smaller amounts or wait for liquidity to return.",
    ],
    strengths: [
      "Interest starts right after you deposit, and there is no lock-up period.",
      "The jlToken is a regular Solana token, so your position is visible in any wallet.",
      "Jupiter charges no deposit or withdrawal fee on Earn; a share of the borrowers' interest goes to the protocol's reserve.",
    ],
    risks: [
      "Rates are variable and change with how much of the pool is borrowed.",
      "If liquidity is tied up in loans, withdrawals can be slowed or split into smaller amounts.",
      "Jupiter lists smart contract risk, oracle risk and the chance that a borrower's collateral falls faster than it can be liquidated.",
    ],
    onYourCalendar: [
      "Jupiter Lend positions have no fixed dates, so they do not create calendar events. Seasonals shows them as context on the Dashboard instead.",
    ],
    inSeasonals:
      "From the Menu you can Deposit into and Withdraw from Jupiter Lend's USDC and SOL markets. Seasonals routes your USDC or SOL into the matching jlToken through Jupiter's swap and routes it back when you withdraw. The card named JupSOL is the Jupiter Lend SOL market: it lends SOL and does not buy the JupSOL staking token. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server. Before building one, Seasonals checks the asset's price on the Pyth and RedStone on-chain feeds: it warns when they differ by more than 2% and refuses when they differ by more than 5% or both are stale. Jupiter's swap routing is also how Seasonals moves SOL or USDC into the staking and stable tokens of the other Solana protocols listed here.",
    site: "https://jup.ag/",
    docs: "https://docs.jup.ag/",
    sources: [
      "https://docs.jup.ag/user-docs/earn/lend/earn",
      "https://docs.jup.ag/user-docs/earn/lend/guides/using-earn",
      "https://developers.jup.ag/docs/lend/earn",
    ],
  },
  {
    id: "kamino",
    chain: "solana",
    name: "Kamino",
    tagline: "Lend into reserves, borrow against collateral, or deposit into a curated vault.",
    keyPoints: [
      "Supply to a lending reserve or a curated vault and hold a token that grows with interest.",
      "Borrow against collateral without selling it; vaults spread deposits across reserves.",
      "If a loan's LTV crosses the liquidation LTV, collateral is sold at a discount.",
    ],
    whatItIs:
      "Kamino is a Solana lending protocol. Kamino Lend lets you supply tokens to reserves and borrow against them, with every loan overcollateralized. Kamino Vaults (kVaults) take one token and spread it across lending reserves chosen by a curator, so you earn lending interest without picking markets yourself.",
    howItWorks: [
      "Supplying to a reserve gives you a kToken that rises in value as borrowers pay interest. Withdrawing redeems it.",
      "To borrow, you first supply collateral. Each position has a current LTV, a max LTV you can borrow up to, and a higher liquidation LTV. Interest accrues on the debt continuously, so a loan drifts toward liquidation even when prices do not move.",
      "If the current LTV passes the liquidation LTV, a liquidator repays part of the debt and takes collateral plus a bonus. Repaying debt or adding collateral moves the position back.",
      "A vault issues share tokens for a single deposit token. Its curator sets allocation weights and caps across reserves, interest compounds into the share price, and the vault keeps a small unallocated buffer for instant withdrawals.",
    ],
    strengths: [
      "Earn interest on idle tokens, or borrow against what you hold without selling it.",
      "Vault shares auto-compound, so there is nothing to claim or reinvest.",
      "Kamino publishes audits from several firms, formal verification and a public risk dashboard.",
    ],
    risks: [
      "A borrowing position can be liquidated when prices move against it or as interest grows the debt. Liquidation sells collateral at a discount.",
      "Vault withdrawals can be delayed when the underlying reserves are highly utilized, until borrowers repay.",
      "Vault depositors share any bad debt in the reserves a curator chose, and curators allocate at their own discretion.",
      "Kamino depends on price oracles and on smart contracts; it says no system can be fully immune to risk.",
    ],
    onYourCalendar: [
      "Health events for Kamino loans with outstanding borrows: a watch event as the LTV approaches the liquidation LTV and a critical event when it is close. Seasonals only alerts; it does not repay or add collateral for you.",
      "Supply-only positions and vault deposits have no dates and show as Dashboard context.",
    ],
    inSeasonals:
      "From the Menu you can Deposit into and Withdraw from the SOL Main Market and JLP reserves and the Steakhouse USDC and Allez SOL vaults. Deposits into the USDC Main Market are currently blocked because Kamino routes them to a closed reserve; withdrawing still works. JLP deposits pause while the reserve's cap is full. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server, after the Pyth and RedStone price check (warning above 2% divergence, refusal above 5% or when both feeds are stale).",
    site: "https://kamino.com/",
    docs: "https://kamino.com/docs",
    sources: [
      "https://kamino.com/docs/products/borrow/borrowing",
      "https://kamino.com/docs/products/borrow/liquidations",
      "https://kamino.com/docs/products/lending-vaults/how-it-works",
      "https://kamino.com/docs/products/lending-vaults/risks",
      "https://kamino.com/docs/security",
    ],
  },
  {
    id: "solstice",
    chain: "solana",
    name: "Solstice",
    tagline: "A Solana dollar (USX) and a staked version (eUSX) that earns from hedged strategies.",
    keyPoints: [
      "Stake the USX dollar token to get eUSX, which grows in value from delta-neutral strategies.",
      "eUSX does not rebase: the same tokens become worth more USX.",
      "Unstaking has a seven-day cooldown; selling eUSX on a DEX is instant but at market price.",
    ],
    whatItIs:
      "Solstice issues USX, a dollar-tracking token that it describes as overcollateralized and verified through third-party attestations. Staking USX in Solstice's YieldVault gives you eUSX, a yield-bearing token whose value in USX grows from delta-neutral trading strategies such as funding-rate arbitrage.",
    howItWorks: [
      "USX is minted and redeemed by verified institutional partners against stablecoins. Everyone else buys USX through the Solstice app or on Solana DEXs.",
      "You lock USX in the YieldVault and receive eUSX, a proportional share of the vault.",
      "eUSX is non-rebasing: your balance stays the same and its redemption value in USX rises as the strategies earn.",
      "To exit, you unlock eUSX back to USX after a cooldown that Solstice says is seven days as standard, with a faster path for small amounts, or you sell eUSX on a DEX at a price that may differ from its redemption value.",
    ],
    strengths: [
      "Dollar-like exposure that can earn when staked, with reserves attested by a third party.",
      "A standard SPL token, usable across Solana DeFi.",
      "Solstice publishes a detailed risk-disclosure page covering its strategies, exchanges and custodians.",
    ],
    risks: [
      "Funding rates move with market sentiment, and Solstice says hedges may not stay perfect in extreme volatility.",
      "The strategies depend on centralized exchanges and custodians, so their failure or insolvency can cause losses.",
      "A stablecoin used by the strategies can lose its peg, and USX itself can trade away from a dollar.",
      "Unstaking is not instant, and smart contract bugs or operational errors are possible.",
    ],
    onYourCalendar: [
      "eUSX has no fixed dates (the cooldown starts only when you unstake in the Solstice app), so it does not create calendar events. Seasonals shows the position as Dashboard context.",
    ],
    inSeasonals:
      "From the Menu you can Deposit USDC into eUSX and Withdraw back to USDC. Both are swaps routed through Jupiter, so a withdrawal sells eUSX at the market price instead of using Solstice's cooldown. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server, after the Pyth and RedStone check on USDC (warning above 2% divergence, refusal above 5% or when both feeds are stale). eUSX itself has no on-chain price feed that Seasonals trusts, so the check covers the USDC side only.",
    site: "https://solstice.finance/",
    docs: "https://docs.solstice.finance/",
    sources: [
      "https://docs.solstice.finance/solstice-for-users/yieldvault/eusx",
      "https://docs.solstice.finance/solstice-for-users/usx",
      "https://docs.solstice.finance/legal-documents/risk-disclosures",
    ],
  },
  {
    id: "sanctum",
    chain: "solana",
    name: "Sanctum",
    tagline: "One token (INF) that holds a basket of Solana liquid staking tokens.",
    keyPoints: [
      "Swap SOL into INF, a pool token backed by many liquid staking tokens (LSTs).",
      "INF earns the LSTs' staking rewards plus swap fees, all priced into the token.",
      "INF trades at a market price that can sit below the value of the LSTs behind it.",
    ],
    whatItIs:
      "Sanctum builds liquid staking infrastructure on Solana. Its Infinity pool holds many LSTs and lets people swap between them, between an LST and SOL, and into the pool itself. INF is the pool's token: holding it means holding a share of every LST in the pool.",
    howItWorks: [
      "A Solana LST represents SOL staked through a stake pool. Its value in SOL rises every epoch, about every two days, as staking rewards arrive; the token count does not change.",
      "Infinity pools many LSTs together. You can swap SOL or any supported LST into INF, and INF back out.",
      "INF's value grows from two sources: the staking rewards of the LSTs it holds and the fees traders pay to swap through the pool.",
      "Instant exits from an LST to SOL go through Sanctum's Router and Reserve, which buy the LST and unstake it at the next epoch boundary for a fee that rises when the Reserve is heavily used.",
    ],
    strengths: [
      "Diversified across many LSTs and validators instead of one stake pool.",
      "Rewards and fees accrue in the token, so there is nothing to claim.",
      "INF is liquid: you can swap out at any time rather than waiting for an epoch to end.",
    ],
    risks: [
      "The market price of INF or any LST can drift from the SOL value it represents, especially when many people exit at once.",
      "An LST in the pool can lose value if its validators underperform or its stake pool has problems.",
      "Instant unstaking through the Reserve costs more when demand is high.",
      "Smart contracts, including Sanctum's pool programs, can have bugs.",
    ],
    onYourCalendar: ["While you hold INF, an epoch event marks when the current Solana epoch ends and staking rewards are finalized."],
    inSeasonals:
      "From the Menu you can Deposit SOL into INF and Withdraw back to SOL. Both are swaps routed through Jupiter; a withdrawal sells INF at the market price rather than unstaking through Sanctum. Before signing, Seasonals checks the SOL price on Pyth and RedStone (warning above 2% divergence, refusal above 5% or when both feeds are stale) and compares the swap quote with INF's own redemption value, refusing if you would receive more than 2% less than that value. The JitoSOL and bSOL cards under Sanctum are listed for reference only. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server.",
    site: "https://www.sanctum.so/",
    docs: "https://learn.sanctum.so/docs",
    sources: [
      "https://learn.sanctum.so/docs/technical-documentation/infinity-non-technical",
      "https://learn.sanctum.so/docs/creating-your-own-lst-with-sanctum/understanding-sanctum-lsts",
      "https://learn.sanctum.so/docs/technical-documentation/reserve",
    ],
  },
  {
    id: "perena",
    chain: "solana",
    name: "Perena",
    tagline: "USD*, a dollar token whose value grows from stablecoin pools and lending strategies.",
    keyPoints: [
      "Deposit USDC and receive USD*, a dollar token that grows in value with no staking or claiming.",
      "Yield comes from stablecoin swap fees, lending and tokenized Treasuries, pooled into one token.",
      "Legacy USD* from the old Seed Pool no longer earns in the new system; upgrade it in the Perena app.",
    ],
    whatItIs:
      "Perena is a Solana protocol built around USD*, a yield-bearing digital dollar. The current USD* is backed by a diversified set of positions, which Perena lists as delta-neutral strategies, secured lending and tokenized real-world assets, and its price rises as that income accrues. Perena's Numéraire stableswap AMM, with its Seed Pool and Growth Pools, provides the stablecoin liquidity underneath.",
    howItWorks: [
      "You deposit USDC (Perena says more stablecoins are coming) and receive USD*, or convert between supported stablecoins and USD* in the app.",
      "USD* does not rebase. Income from the strategies behind it accrues in the token's price, so the same USD* redeems for more stablecoins over time.",
      "You can redeem USD* back to USDC at any time; Perena charges a small redemption fee and no minting fee.",
      "The original USD* was an LP receipt for the USDC/USDT/PYUSD Seed Pool. In the new system those LP tokens are deposited into the vaults that back USD*, and Perena asks holders to upgrade through the Portfolio page.",
    ],
    strengths: [
      "Dollar exposure with yield built into the token and no lock-up.",
      "Redeemable to stablecoins directly in the Perena app, not only on secondary markets.",
      "Spreads yield across several sources instead of a single pool.",
    ],
    risks: [
      "Yield is variable and depends on the vaults' performance; past figures are indicative only.",
      "If a stablecoin in the basket loses its peg, or a lending or real-world-asset position fails, USD* can lose value.",
      "Legacy USD* does not accrue yield in the new system until it is upgraded.",
      "Smart contract bugs are possible, and Perena marks its vault products as beta.",
    ],
    onYourCalendar: ["USD* has no fixed dates, so it does not create calendar events. Seasonals shows the position as Dashboard context."],
    inSeasonals:
      "From the Menu you can Deposit USDC into the current USD* token and Withdraw back to USDC, both as swaps routed through Jupiter, signed in your Solana wallet and sent to mainnet through the Seasonals server after the Pyth and RedStone check on USDC (warning above 2% divergence, refusal above 5% or when both feeds are stale). The Tri-Stable Pool card is listed for reference only: its LP token is the legacy USD*, and the card links to the Perena app where you can withdraw or upgrade it.",
    site: "https://perena.org/",
    docs: "https://perena.gitbook.io/perena",
    sources: [
      "https://perena.gitbook.io/perena/products/usd-star-usd",
      "https://perena.gitbook.io/perena/products/usd-star-usd/upgrade-legacy-usd",
      "https://perena.gitbook.io/perena/use-perena",
    ],
  },
  {
    id: "savefi",
    chain: "solana",
    name: "Save",
    tagline: "Lend and borrow on Save, the protocol formerly known as Solend.",
    keyPoints: [
      "Supply USDC or SOL and receive cTokens that are redeemable for more as interest accrues.",
      "cTokens are plain Solana tokens: hold them, move them, redeem them any time there is liquidity.",
      "If a reserve is fully borrowed, withdrawals wait until borrowers repay.",
    ],
    whatItIs:
      "Save, formerly Solend, is a lending and borrowing protocol on Solana. Suppliers deposit tokens into reserves and receive cTokens that represent their share of the reserve. Borrowers post collateral and pay interest that flows to suppliers.",
    howItWorks: [
      "When you supply, say, USDC, you receive cUSDC. The exchange rate between cUSDC and USDC rises as interest accrues, so redeeming later returns your deposit plus interest.",
      "Interest rates follow utilization: the more of a reserve is borrowed, the higher the borrow rate, and supply interest is the borrow interest shared across suppliers.",
      "Borrowers must keep their health above the liquidation threshold. If it falls below, a liquidator repays part of the debt and takes collateral plus a bonus.",
      "Save runs a main market and isolated pools with their own parameters.",
    ],
    strengths: [
      "Simple savings-style lending with a token receipt you keep in your own wallet.",
      "cTokens stay composable with other Solana apps and keep earning when transferred.",
      "No repayment deadline for borrowers, and no lock-up for suppliers.",
    ],
    risks: [
      "When a reserve is fully utilized there are no tokens left to withdraw until borrowers repay.",
      "Save lists smart contract risk, oracle risk (wrong prices causing wrongful liquidations) and the risk that liquidations happen too late to cover a loan.",
      "Rates change with utilization, so supply income is not fixed.",
    ],
    onYourCalendar: ["Save positions have no fixed dates, so they do not create calendar events. Seasonals shows them as Dashboard context."],
    inSeasonals:
      "From the Menu you can Deposit into and Withdraw from the USDC Main and SOL Main reserves; you hold the matching cToken in your wallet in between. Turbo SOL is listed for reference only. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server after the Pyth and RedStone price check (warning above 2% divergence, refusal above 5% or when both feeds are stale).",
    site: "https://save.finance/",
    docs: "https://docs.save.finance/",
    sources: [
      "https://docs.save.finance/architecture/ctokens",
      "https://docs.save.finance/getting-started/liquidations",
      "https://docs.save.finance/getting-started/risks",
      "https://docs.save.finance/getting-started/supply-and-borrow-apy",
    ],
  },
  {
    id: "marinade",
    chain: "solana",
    name: "Marinade",
    tagline: "Stake SOL through Marinade and hold mSOL, which grows in value every epoch.",
    keyPoints: [
      "Stake SOL and receive mSOL; its price in SOL rises each epoch as rewards accrue.",
      "mSOL stays liquid and usable in DeFi while your SOL is staked.",
      "Unstaking directly takes about an epoch and a small fee; selling mSOL is instant at market price.",
    ],
    whatItIs:
      "Marinade is a stake automation protocol on Solana. Its liquid staking product stakes your SOL across a set of validators chosen by performance and gives you mSOL, a token that represents your staked SOL plus the rewards it earns.",
    howItWorks: [
      "You stake SOL and receive mSOL. Marinade spreads the stake across many validators.",
      "mSOL does not rebase. Its price equals the total SOL staked divided by the mSOL supply, so it rises each epoch as staking rewards are added.",
      "Delayed unstake returns SOL at the next epoch boundary, about one to two days, for a small protocol fee. You come back to claim the SOL once it is ready.",
      "Instant unstake swaps mSOL for SOL on a DEX at the market rate, with no extra Marinade fee but with the market spread.",
    ],
    strengths: [
      "Staking rewards without running a validator or picking one yourself.",
      "mSOL is a standard token, so it works as collateral and liquidity elsewhere.",
      "Two exit paths: a predictable delayed unstake, or an instant swap.",
    ],
    risks: [
      "mSOL's market price can diverge from the SOL it represents, especially when many people exit at once.",
      "Validators can underperform or go offline, and Marinade notes that slashing could put stake at risk if Solana introduces it.",
      "Delayed unstaking is not instant, and amounts received vary with network conditions.",
      "Smart contracts, and the oracles and data feeds around them, can fail.",
    ],
    onYourCalendar: ["While you hold mSOL, an epoch event marks when the current Solana epoch ends and staking rewards are finalized."],
    inSeasonals:
      "From the Menu you can Deposit SOL into mSOL and Withdraw back to SOL. Both are swaps routed through Jupiter, so a withdrawal sells mSOL at the market price rather than using Marinade's delayed unstake. Before signing, Seasonals checks the SOL price on Pyth and RedStone (warning above 2% divergence, refusal above 5% or when both feeds are stale) and compares the swap quote with mSOL's redemption value, refusing if you would receive more than 2% less. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server.",
    site: "https://marinade.finance/",
    docs: "https://docs.marinade.finance/",
    sources: [
      "https://docs.marinade.finance/marinade-protocol/protocol-overview/marinade-liquid/what-is-msol",
      "https://docs.marinade.finance/marinade-protocol/protocol-overview/marinade-instant-unstake",
      "https://docs.marinade.finance/marinade-protocol/legal/risks",
    ],
  },
  {
    id: "meteora",
    chain: "solana",
    name: "Meteora",
    tagline: "Provide liquidity in price bins with fees that rise when markets get volatile.",
    keyPoints: [
      "Deposit one token into a DLMM pool and earn trading fees while the price stays in your bins.",
      "Fees are dynamic: a base fee plus more during volatile periods.",
      "A position earns nothing while the price is outside its range, and faces impermanent loss.",
    ],
    whatItIs:
      "Meteora is liquidity infrastructure on Solana. Its DLMM (Dynamic Liquidity Market Maker) pools arrange liquidity in discrete price bins: trades inside a bin happen at that bin's fixed price, and liquidity providers choose which bins to fill.",
    howItWorks: [
      "Each pool is a ladder of bins separated by a fixed bin step. Only the active bin, where the current price sits, is traded at any moment; as it empties, trading moves to the next bin.",
      "You can deposit a single token into the bins you choose, and pick a shape: spread evenly (Spot), concentrated around the current price (Curve), or weighted toward the edges (Bid-Ask).",
      "Fees are a base fee plus a variable part that grows with volatility. Only the bins a swap crosses earn that swap's fees.",
      "If the price moves outside your bins, the position stops earning until the price returns or you rebalance. Withdrawing returns your tokens in whatever mix the position holds, plus unclaimed fees.",
    ],
    strengths: [
      "Single-sided deposits: you do not need to hold both tokens.",
      "Zero slippage inside a bin, and higher fees when liquidity providers take more risk.",
      "You decide exactly where your liquidity sits.",
    ],
    risks: [
      "Impermanent loss: when prices move, the position can be worth less than simply holding the tokens.",
      "Out-of-range positions earn no fees until the price comes back or you move them.",
      "Tighter positions need more frequent rebalancing; Meteora says its strategies do not remove impermanent loss or out-of-range risk.",
      "Smart contracts can have bugs.",
    ],
    onYourCalendar: [
      "A claim event when one of your Meteora positions has unclaimed fees, with a Withdraw & claim action that withdraws the position and collects the fees.",
    ],
    inSeasonals:
      "From the Menu you can Deposit USDC into the USDC-USDT and SOL-USDC DLMM pools and SOL into the JitoSOL-SOL pool, each as a single-sided deposit, and Withdraw a position you hold. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server after the Pyth and RedStone price check (warning above 2% divergence, refusal above 5% or when both feeds are stale).",
    site: "https://meteora.ag/",
    docs: "https://docs.meteora.ag/",
    sources: [
      "https://docs.meteora.ag/core-products/dlmm/what-is-dlmm",
      "https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases",
      "https://docs.meteora.ag/core-products/dlmm/collect-fee-mode",
    ],
  },
  {
    id: "jito",
    chain: "solana",
    name: "Jito",
    tagline: "Stake SOL for JitoSOL and earn staking rewards plus MEV tips.",
    keyPoints: [
      "Stake SOL and receive JitoSOL, which rises in value from staking rewards and MEV rewards.",
      "Validators are picked automatically by StakeNet for performance, low fees and running Jito's client.",
      "Direct unstaking waits up to one epoch and charges a small fee; selling JitoSOL is instant.",
    ],
    whatItIs:
      "Jito runs a liquid staking pool on Solana. You stake SOL and receive JitoSOL. The pool stakes with validators that run Jito's MEV-enabled client, so JitoSOL earns normal staking rewards plus a share of the MEV tips those validators collect.",
    howItWorks: [
      "You stake SOL on Jito and receive JitoSOL right away. The pool is built on the stake pool program from Solana Labs, and Jito describes it as non-custodial.",
      "Rewards accrue in the price: JitoSOL does not rebase, it becomes worth more SOL over time.",
      "MEV rewards come from an auction in Jito's validator client where traders bid for transaction ordering. Winning bids go to validators and then to their stakers, pro rata, at each epoch boundary.",
      "StakeNet, Jito's automated system, re-selects validators every few weeks based on commission, voting performance, running the Jito client and not being too large.",
      "Delayed unstake returns SOL after up to one epoch (about two days) with a small withdrawal fee. Selling JitoSOL on a DEX is instant, at the market spread.",
    ],
    strengths: [
      "Two reward streams in one token, with nothing to claim.",
      "Validator selection is automatic and aimed at decentralization.",
      "JitoSOL is widely used as collateral and liquidity across Solana DeFi.",
    ],
    risks: [
      "MEV rewards swing with market activity: busy, volatile periods pay more, quiet markets less.",
      "Jito names large-scale validator slashing (not currently part of Solana) and critical smart contract bugs as the ways JitoSOL could lose value against SOL.",
      "On the market, JitoSOL can trade below its redemption value, so selling instantly can cost more than the direct unstake fee.",
      "Jito charges a management fee on rewards and a fee on direct withdrawals.",
    ],
    onYourCalendar: ["While you hold JitoSOL, an epoch event marks when the current Solana epoch ends and staking and MEV rewards are finalized."],
    inSeasonals:
      "From the Menu you can Deposit SOL into JitoSOL and Withdraw back to SOL. Both are swaps routed through Jupiter, so a withdrawal sells JitoSOL at the market price rather than using Jito's delayed unstake. Before signing, Seasonals checks the SOL price on Pyth and RedStone (warning above 2% divergence, refusal above 5% or when both feeds are stale) and compares the swap quote with JitoSOL's redemption value, refusing if you would receive more than 2% less. The Jito Restaking Vault card is listed for reference only. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server.",
    site: "https://www.jito.network/",
    docs: "https://www.jito.network/docs/jitosol/",
    sources: [
      "https://www.jito.network/docs/jitosol/faqs/general-faqs/",
      "https://jito-foundation.gitbook.io/mev/mev-payment-and-distribution/high-level",
      "https://www.solana-program.com/docs/stake-pool",
    ],
  },
  {
    id: "orca",
    chain: "solana",
    name: "Orca",
    tagline: "Provide liquidity on Orca Whirlpools, in a tight range or across the full range.",
    keyPoints: [
      "Add liquidity to a Whirlpool and earn a share of swap fees while the price is in your range.",
      "Full-range positions are passive; concentrated ones put more liquidity near the price but need attention.",
      "Positions out of range earn nothing, and impermanent loss applies.",
    ],
    whatItIs:
      "Orca is a Solana DEX. Its Whirlpools are concentrated-liquidity pools: liquidity providers choose a price range for their capital instead of spreading it across every price. A position can cover the full range for a passive approach or a narrow band for more concentration.",
    howItWorks: [
      "You pick a pool and a fee tier, then a price range. Your tokens are deposited in the ratio that range requires.",
      "While the pool price is inside your range, swaps use your liquidity and you accrue a share of the fees.",
      "Fees sit in the position until you harvest them, and are also collected when you withdraw or close the position. Withdrawing returns your tokens in whatever mix the position holds, which can differ from what you deposited.",
      "If the price leaves your range, the position stops accruing fees and can end up entirely in one token. You can wait, withdraw, or open a new position.",
    ],
    strengths: [
      "Choose your own exposure: passive full range or concentrated.",
      "Fees accrue continuously and are yours to harvest when you like.",
      "Orca's contracts are audited, and its docs explain each risk plainly.",
    ],
    risks: [
      "Impermanent loss, which Orca calls divergence loss: your position may be worth less than simply holding the tokens.",
      "Out-of-range positions earn no fees and become one-sided.",
      "A higher fee tier does not mean higher returns; it can reduce trading in the pool.",
      "Orca says its contracts are audited but that no protocol is without risk.",
    ],
    onYourCalendar: [
      "A claim event when one of your Orca positions has unclaimed fees, with a Withdraw & claim action that withdraws the position and collects the fees.",
    ],
    inSeasonals:
      "From the Menu you can Deposit USDC into the USDC-USDT and SOL-USDC Whirlpools and SOL into the JitoSOL-SOL Whirlpool. Seasonals opens a full-range position in two transactions: it first swaps part of your deposit into the other token, then opens the position. You can Withdraw a position you hold. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server after the Pyth and RedStone price check (warning above 2% divergence, refusal above 5% or when both feeds are stale).",
    site: "https://www.orca.so/",
    docs: "https://docs.orca.so/",
    sources: [
      "https://docs.orca.so/liquidity/getting-started/beginner-guide",
      "https://docs.orca.so/liquidity/concepts/impermanent-loss",
      "https://docs.orca.so/liquidity/manage/harvest",
    ],
  },
  {
    id: "hylo",
    chain: "solana",
    name: "Hylo",
    tagline: "A stablecoin and leverage protocol with its own staking token (hyloSOL) and Earn Pool (eHYUSD).",
    keyPoints: [
      "Stake SOL for hyloSOL, or deposit hyUSD into the Earn Pool for eHYUSD, which grows every epoch.",
      "hyUSD is backed by pools of collateral; leverage tokens (xSOL) absorb the price swings.",
      "eHYUSD is the same token formerly called sHYUSD; its yield depends on the protocol's activity.",
    ],
    whatItIs:
      "Hylo is a Solana protocol that splits collateral such as SOL liquid staking tokens into two products: hyUSD, a decentralized stablecoin, and xAssets like xSOL, leveraged tokens that take on the collateral's price moves. Around these it offers the Earn Pool, where hyUSD deposits become yield-bearing eHYUSD, and hyloSOL, its own liquid staking token.",
    howItWorks: [
      "Each collateral pool is split into a virtual stablecoin worth one dollar and a leverage token. hyUSD is backed one-to-one by the combined value of those virtual stablecoins, and the leverage token absorbs the collateral's volatility.",
      "Depositing hyUSD into the Earn Pool mints eHYUSD. Every epoch, yield from the collateral pools (staking rewards and borrow rates) is harvested into hyUSD and added to the pool, so eHYUSD appreciates against hyUSD.",
      "hyloSOL is SOL staked to Hylo's validator; it earns staking yield that varies with network conditions.",
      "Hylo manages each pool's collateral ratio with rebalance zones, fee routing and, as a last resort, burning Earn Pool hyUSD to retire unbacked supply.",
    ],
    strengths: [
      "Stablecoin yield that comes from the protocol's own collateral and leverage activity rather than a central issuer.",
      "hyloSOL gives SOL staking exposure that stays liquid.",
      "Hylo publishes audits for its exchange, stability pool and Earn Pool programs.",
    ],
    risks: [
      "Earn Pool deposits are the protocol's loss buffer: in stress, Earn Pool hyUSD can be burned to keep hyUSD backed, so eHYUSD can lose value.",
      "A sharp drop in the collateral's price pushes pools toward their stability mechanisms and can affect every product.",
      "hyloSOL depends on a single validator operator and on the stake pool program.",
      "Smart contracts can have bugs, and Hylo renamed and restructured its yield token in V2, so older guides may still say sHYUSD.",
    ],
    onYourCalendar: [
      "While you hold hyloSOL, an epoch event marks when the current Solana epoch ends and staking rewards are finalized.",
      "eHYUSD has no fixed dates and shows as Dashboard context.",
    ],
    inSeasonals:
      "From the Menu you can Deposit SOL into hyloSOL and USDC into eHYUSD, and Withdraw back, all as swaps routed through Jupiter. The Menu still labels the second pool with its earlier name, sHYUSD Stability Pool; it is the same token Hylo now calls eHYUSD. Transactions are signed in your Solana wallet and sent to mainnet through the Seasonals server after the Pyth and RedStone check on SOL or USDC (warning above 2% divergence, refusal above 5% or when both feeds are stale). hyloSOL and eHYUSD have no price feed that Seasonals trusts, so the check covers the SOL or USDC side only.",
    site: "https://hylo.so/",
    docs: "https://docs.hylo.so/",
    sources: [
      "https://docs.hylo.so/product-guide/stablecoin",
      "https://docs.hylo.so/protocol-overview/earn-pool",
      "https://docs.hylo.so/product-guide/liquid-staking-tokens",
      "https://docs.hylo.so/protocol-overview/risk-management",
      "https://docs.hylo.so/security/onchain-addresses",
      "https://docs.hylo.so/security/audits",
    ],
  },
  {
    id: "exponent",
    chain: "solana",
    name: "Exponent",
    tagline: "Split a Solana yield token into fixed-rate principal (PT) and floating yield (YT).",
    keyPoints: [
      "PT redeems one-to-one for the underlying at maturity; buying it at a discount locks in a fixed rate.",
      "YT collects all of the underlying's yield until maturity, then is worth zero.",
      "In Seasonals you can only redeem matured PT; buying PT or YT is not available yet.",
    ],
    whatItIs:
      "Exponent is a yield-tokenization protocol on Solana. It takes a yield-bearing token and splits it, for a fixed maturity date, into a Principal Token (PT), a claim on the deposited principal, and a Yield Token (YT), a claim on all the variable yield that principal earns until maturity. One underlying token equals one PT plus one YT.",
    howItWorks: [
      "A yield-bearing token is deposited and split into PT and YT with the same maturity.",
      "PT trades below the underlying before maturity. Holding it to maturity returns the full underlying, so the discount is your fixed return.",
      "YT receives the underlying's yield, including protocol rewards and emissions, until maturity. After maturity it stops accruing and is worth zero.",
      "The implied rate is the market's expectation of yield until maturity, set by PT and YT trading. Selling before maturity realizes the market price, not the fixed return.",
      "At maturity, PT redeems one-to-one for the underlying, with no deadline to redeem.",
    ],
    strengths: [
      "A known return if you hold PT to maturity, from a Solana-native market.",
      "YT gives direct exposure to a token's yield without buying the whole token.",
      "Each market has a clear maturity date, which makes planning easy, and Exponent's programs have been audited by several firms.",
    ],
    risks: [
      "Selling PT or YT before maturity means taking the market price, which can be a loss.",
      "YT's value falls to zero at maturity.",
      "Exponent depends on the protocol behind each underlying token; a problem there affects PT and YT.",
      "Smart contract risk applies to Exponent and to the underlying protocols; Exponent says no protocol can be completely bulletproof.",
    ],
    onYourCalendar: [
      "The maturity date of each Exponent PT or YT you hold. After maturity a PT shows as overdue with a Redeem PT action; YT has no action because it expires worthless.",
    ],
    inSeasonals:
      "The Menu lists Exponent's PT markets for reference, with their maturity dates, but Seasonals does not buy PT or YT yet. For a matured PT you hold, the Calendar offers Redeem PT, which redeems it one-to-one for the underlying; Seasonals refuses to redeem before maturity. The redemption is signed in your Solana wallet and sent to mainnet through the Seasonals server.",
    site: "https://www.exponent.finance/",
    docs: "https://docs.exponent.finance/",
    sources: [
      "https://docs.exponent.finance/user-documentation/overview",
      "https://docs.exponent.finance/user-documentation/yield-stripping-swap",
      "https://docs.exponent.finance/user-documentation/security",
      "https://docs.exponent.finance/user-documentation/audits-bug-bounty",
    ],
  },
];
