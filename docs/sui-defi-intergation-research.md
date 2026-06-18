# Building an Autonomous DeFi Agent on Sui: Venue Selection for Lending/Yield and DeepBook v3 Market-Making

> **doc map:** this doc owns **venue / SDK selection**. see [defi-agent-sui.md](defi-agent-sui.md) for **thesis + scope** and [strategy-research.md](strategy-research.md) for the **strategy math**.

## TL;DR
- **For DeepBook v3 spot/market-making, integrate DeepBook directly via `@mysten/deepbook-v3` (the canonical Mysten Labs CLOB SDK)** — it is the single best programmatic venue on Sui, with a mature TypeScript SDK, a public REST indexer, a scoped non-custodial capability model (TradeCap), and PTB-atomic composability with every other protocol. For lending/yield with idle stablecoins, **Suilend and NAVI are the top two**: both have production TypeScript SDKs, the deepest lending TVL on Sui (per The Defiant in October 2025, "Suilend currently ranks as the largest protocol on Sui, with $745 million in TVL... Navi follows with $723 million"), and clean programmatic supply/withdraw/claim flows.
- **The strongest agent pattern is: park stablecoins in Suilend or NAVI, mint a scoped DeepBook `TradeCap` for a bot key, and rebalance/market-make on DeepBook** — and because all of these are Sui Move objects, you can compose a lending withdrawal + a DeepBook order into a *single atomic Programmable Transaction Block (PTB)*. AlphaFi/AlphaLend and Kai Finance offer ready-made auto-compounding vault SDKs if you prefer managed strategies.
- **Caveats:** DeepBook's own on-book TVL is small (~$11–16M on DefiLlama; ~$20M per Mysten's blog) even though cumulative volume exceeds $17B — liquidity is concentrated in a few pools and fragmented across Cetus/Bluefin/Momentum AMMs. DEEP token is required for fees, several SDKs are mainnet-only, and Sui mainnet had three outage incidents on May 28–29, 2026 that an agent must handle gracefully.

## Key Findings

**DeepBook v3 is the keystone integration.** It is the canonical on-chain central limit order book (CLOB) for Sui, built and maintained by Mysten Labs/Sui Foundation. It exposes a first-party TypeScript SDK (`@mysten/deepbook-v3`, currently v0.17.0), a Rust path, and a public REST indexer. Its account model (the `BalanceManager` shared object plus mintable `TradeCap`/`DepositCap`/`WithdrawCap` capability objects) is ideal for a non-custodial agent: an owner can hand a bot a `TradeCap` that authorizes placing/cancelling/modifying orders but *cannot* move funds, and can revoke it at will. Everything is composable in a single PTB, including flash loans.

**Lending: Suilend and NAVI lead; Scallop and AlphaLend follow.** Suilend (`@suilend/sdk`) and NAVI (`@naviprotocol/lending`) are the two largest lending markets and both ship full-featured TypeScript SDKs that build PTBs for supply/withdraw/borrow/repay/claim. Scallop (`@scallop-io/sui-scallop-sdk`) is mature but smaller. AlphaLend (`@alphafi/alphalend-sdk`) is a newer non-custodial market with a clean SDK.

**Vaults/yield optimizers for hands-off strategies:** AlphaFi (`@alphafi/alphafi-sdk`, multi-protocol — Bluefin, Navi, Cetus, Bucket, AlphaLend) and Kai Finance (`@kunalabs-io/kai`, leveraged-yield vaults with a published liquidation-bot example) both let an agent deposit/withdraw/compound programmatically.

**AMMs/CLMMs for LP strategies and routing:** Cetus (`@cetusprotocol/cetus-sui-clmm-sdk`) and Momentum (the largest Sui DEX by TVL) provide concentrated-liquidity LP positions as NFTs. Bluefin offers hybrid spot CLMM + perps with the deepest spot DEX volume.

**Aggregators that route through DeepBook:** 7K, Cetus Aggregator, Aftermath Smart-Order Router, and NAVI's Astros all include DeepBook v3 as a routed liquidity source — useful for best-execution swaps when rebalancing.

## Details

### 1. DeepBook v3 — the canonical CLOB (HIGHEST PRIORITY)

**What it is.** DeepBook v3 (DBv3) is a next-generation fully on-chain CLOB built natively on Sui by Mysten Labs, live on mainnet. It is the "liquidity layer of Sui." It introduced flash loans, governance, improved account abstraction, an upgraded matching engine, and the DEEP token. Staked takers trade at fees as low as 0.25 bps (stable pairs) / 2.5 bps (volatile pairs); staked makers earn rebates. Trades settle on-chain in under ~400ms.

**Status & metrics (mid-2026).** Mainnet. Per the official Sui blog (blog.sui.io/deepbook-spot-margin-primitives-for-builders), verbatim: *"It has $20M in TVL and has powered over $17B in cumulative on-chain volume. Eight protocols have integrated it: Aftermath, Bluefin, Cetus, Turbos, Momentum, STEAMM, Full Sail, and DeepTrade,"* with "20+ integrated apps" tapping its liquidity overall. DefiLlama (measuring net BalanceManager deposits) shows lower TVL (~$11.64M live, with cached snapshots around $15.93M), ~$12M 24h volume, ~$598M 30d volume, and ~$14.79B cumulative — the cumulative discrepancy vs. Mysten's "$17B+" reflects different methodologies (Mysten counts all on-chain flow; DefiLlama sums per-pool spot swap volume). DeepBook hit an all-time-high ~$800M+ volume month in January, and 7M+ DEEP have been burned from fees.

**Programmatic access — best on Sui.**
- **TypeScript SDK:** `@mysten/deepbook-v3` (npm, v0.17.0). Construct a `DeepBookClient` with a `SuiClient`, sender address, environment (`testnet`/`mainnet`), and registered balance managers. A `constants.ts` ships the latest package IDs, registry ID, DEEP treasury ID, and staple pools/coins. As of SDK 2.0 it also exports a gRPC client extension (`deepbook({address})`).
- **Indexer:** A public REST DeepBookV3 Indexer (run by Mysten, or self-hostable) exposes pool metadata (tick/lot/min sizes), historical and per-BalanceManager volume, OHLCV candlesticks, and DeepBook Margin events (loans, liquidations, margin-pool ops). Ideal for an agent's market-data and PnL layer.
- **Order operations (SDK):** `placeLimitOrder`, `placeMarketOrder`, `modifyOrder` (reduce quantity / lower expiration only — increases require cancel+replace), `cancelOrder`, `cancelOrders` (atomic batch), `cancelAllOrders`, `withdrawSettledAmounts`. Four order options and three self-matching options are supported. `pay_with_deep` toggles fees in DEEP (20% cheaper) vs. input token. Reads: `checkManagerBalance`, `getLevel2Range`/level-2 book status, order status.
- **Move interface:** `deepbook::pool` and `deepbook::balance_manager` are public; you can call them directly in a PTB. Cancellation of multiple orders is atomic (all-or-nothing).

**Position & strategy management.** You hold limit and market orders and maker quotes across all pools from one BalanceManager. There's no first-party "MM vault," but Mysten ships a reference `DeepBookMarketMaker` class (extends `DeepBookClient`) in the SDK examples that demonstrates deposit/withdraw, place limit orders, flash loans, and signing — a practical market-making bot starter. Third parties (Lotus Finance for HFT market-making, DeepTrade, Abyss vaults) build production MM stacks on DeepBook.

**Composability with DeepBook.** It *is* DeepBook — and everything is PTB-composable. Swaps can take Coin objects directly as input/output (no BalanceManager needed for pure swaps), and flash loans, order placement, and external protocol calls can be batched atomically. The "hot potato" pattern enforces atomic settlement.

**Non-custodial / agent-friendliness — excellent.** The `BalanceManager` is a shared object with exactly one immutable owner and up to 1,000 traders. The owner can `mint_trade_cap` (only the owner can mint; verified on-chain via `validate_owner`) and transfer the resulting `TradeCap` (an owned object) to a bot's scoped key. The Move source module doc states verbatim: *"A `TradeProof` can be generated in two ways: by the owner directly, or by any `TradeCap` owner. The owner can generate a `TradeProof` without the risk of equivocation. The `TradeCap` owner, due to it being an owned object, risks equivocation when generating a `TradeProof`. Generally, a high frequency trading engine will trade as the default owner."* The README states: *"A trader cannot deposit and withdraw funds, but can do everything else"* — i.e., a `TradeCap` holder generates a `TradeProof` via `generate_proof_as_trader` and can place/cancel/modify orders and set referrals, but has **no path to move funds**. Deposits/withdrawals require the owner directly (`deposit`/`withdraw` doc: *"Only owner can call this directly"*), or a separately-minted `DepositCap`/`WithdrawCap` (`deposit_with_cap`/`withdraw_with_cap`). The owner can `revoke_trade_cap` at any time — verbatim: *"Revoke a `TradeCap`. Only the owner can revoke a `TradeCap`. Can also be used to revoke `DepositCap` and `WithdrawCap`."* There is a `MAX_TRADE_CAPS` allow-list cap of 1,000. This is exactly the scoped-key, non-custodial pattern an autonomous treasury agent needs. The SDK exposes `mintTradeCap`, `mintDepositCap`, `mintWithdrawalCap`, `generateProofAsTrader`/`generateProofAsOwner`, and a one-call `createBalanceManagerWithOwnerAndCaps`.

**DeepBook Margin & Predict.** Per the Sui blog, DeepBook Margin *"launched in January 2026 and already has $20M in cumulative volume. Five protocols are integrated: DeepTrade, Abyss, Current, Turbos, and Cetus,"* supporting up to 10x leverage with isolated pools. It extends the same shared liquidity to on-chain leveraged trading of *underlying* assets (not synthetic perps), with yield-bearing margin pools, and the indexer exposes margin events. Relevant if the agent later wants leverage; for a stablecoin treasury agent it's secondary.

### 2. Lending / Yield protocols

**Suilend — #1 lending market.** Built by the Solend team; launched March 2024. Suilend + SpringSui (liquid staking) + STEAMM (superfluid AMM) crossed $1B combined TVL in January 2025 and ended Q1 2026 holding nearly 30% of all Sui DeFi TVL; The Defiant reported it as the largest single Sui protocol at $745M TVL during the October 2025 ecosystem peak.
- **SDK:** `@suilend/sdk` (npm, v1.1.99, actively published). `SuilendClient.initialize(LENDING_MARKET_ID, LENDING_MARKET_TYPE, suiClient)`. Methods: `createObligation`, `depositIntoObligation`, `depositLiquidityAndGetCTokens`, `withdraw`, `borrow`, `repay` (full flow), `refreshAll`, `claimRewards`/`claimRewardsAndDeposit`/`claimRewardsAndSendToUser`, `liquidateAndRedeem`. Positions are NFT-based `Obligation` objects; deposits mint cTokens. An event-fetching API layer (`ApiDepositEvent`, `ApiWithdrawEvent`, etc.) gives the agent an indexer. Includes a `Swap` module (DEX integration).
- **STEAMM** ships its own `@suilend/steamm-sdk` for AMM deposit/swap/redeem.
- **Non-custodial:** fully non-custodial; positions held in user-owned `ObligationOwnerCap`.

**NAVI Protocol — #2 lending, strongest "agent" framing.** "One-stop liquidity protocol" on Sui; The Defiant reported $723M TVL during the October 2025 peak (DefiLlama's narrower 2026 "NAVI Lending" sub-views show ~$155M–$173M). Q1 2026 gross revenue $4.32M; ranks top-4 lending by 7-day revenue. Holds 70.8% of Bitcoin-related assets on Sui.
- **SDK:** Modern modular SDK — `@naviprotocol/lending` (deposit, borrow, repay, liquidate, claim rewards, flash loans, oracle queries; `*PTB`-suffixed methods construct transactions), plus `@naviprotocol/wallet-client` (simpler unified swap+lending helpers), a Bridge SDK, and the Astros Aggregator SDK. Legacy `navi-sdk` still maintained. NAVI also publishes a `skills` repo (agent skills) and a `Copilot` asset-management layer that supports direct actions (claim rewards, adjust positions) across NAVI, Astros, Volo, Bluefin, AlphaFi, Cetus, MMT, and Suilend.
- **Strategies:** Automatic Leverage Vaults, "Multiply" (vault-based leveraged looping), isolation markets, E-Mode. Programmatic looping is first-class.
- **Composability:** Liquidations route through DeepBook and AMMs; the Astros aggregator routes through DeepBook v3 (see below).
- **Non-custodial:** yes.

**Scallop — mature, mid-size.** Compound-v3/Solend-style market; peak TVL $195M (Nov 2024), ~$102M (Sep 2025), ~$21M on DefiLlama's 2026 "Scallop Lend" view. sCoins (interest-bearing, composable across Sui DeFi), zero-fee flash loans, veSCA.
- **SDK:** `@scallop-io/sui-scallop-sdk` (TypeScript). Seven models: `Scallop`, `ScallopClient` (high-level lend/borrow/collateral/withdraw), `ScallopBuilder` (custom PTB composition), `ScallopQuery`, `ScallopAddress`, `ScallopUtils`, `ScallopIndexer`. **Mainnet-only** (testnet errors). Pro-trader "Layer-2 SDK."
- **Non-custodial:** yes; permissionless, composable.

**AlphaLend — newer non-custodial market.** `@alphafi/alphalend-sdk` (npm, v1.1.27). `AlphalendClient("mainnet", suiClient)`; `updatePrices` (Pyth), supply/borrow with market IDs, `getAllMarkets` returns supply/borrow APR, LTV, liquidation thresholds, available liquidity. ~$72.5M TVL on DefiLlama's 2026 lending view (above Scallop Lend's $21M there). Explicitly "decentralized, non-custodial, composable."

### 3. Vaults / yield optimizers

**AlphaFi — top yield optimizer, best multi-protocol agent SDK.** `@alphafi/alphafi-sdk`: multi-protocol (Bluefin, Navi, Cetus, Bucket, AlphaLend, AlphaFi), with `getPoolsData(['Lending'|'Lp'|'AutobalanceLp'])`, `getUserPortfolio` (net worth, aggregated APY, rewards), and unsigned-transaction builders for deposit/withdraw/swap/claim. Strategies: lending, LP farming, leveraged yield farming (LYF), looping, Alpha vaults. Auto-compounding CLMM vaults (Cetus pairs). ~$12M TVL. Audited by MoveBit, monitored by zeroShadow.

**Kai Finance — leveraged-yield vaults with bot tooling.** `@kunalabs-io/kai` (TypeScript): `VAULTS.suiUSDT.fetch`, `getVaultStats` (TVL/APR/APY), `getWalletVaultInfo`, `Position.compound`, `position.withdrawAllRewardsConvertAndTransfer` (with Aftermath/Cetus router adapters). Ships a reference liquidation-bot repo (position monitoring + flash-swap execution). Up to 11x leverage for active users, one-click vaults for passive.

**Typus, Bucket, Volo.** Typus = structured/options/perps vaults that integrate Scallop sCoins for lending yield. Bucket = CDP stablecoin (USDB) accepting sCoins/SCA/sUSDC collateral. Volo (NAVI's LST arm) = vaults + liquid staking ($45M TVL Q1 2026) and notably shipped the **Volo MCP for agentic yield deployment** plus an open Vault Standard — directly relevant to AI/agent integrations.

### 4. AMM / CLMM DEXs (LP strategies + DeepBook routing context)

**Cetus — leading CLMM, best AMM SDK, integrates DeepBook.** `@cetusprotocol/cetus-sui-clmm-sdk` (and newer `@cetusprotocol/sui-clmm-sdk`): open position, add/remove liquidity, close, collect fees/rewards, swap, RouterV2 (`getBestRouter`/`swapWithRoute`). Positions are NFTs (composable with lenders/vaults), up to ~4000x capital efficiency. Cetus built a dedicated DeepBook UI (deepbook.cetus.zone), aggregates DeepBook liquidity into Cetus Plus, and publishes `@cetusprotocol/deepbook-utils-sdk` for builders integrating DeepBook programmatically. **Risk note:** Cetus suffered a $223M exploit on May 22, 2025; per The Block it "relaunched on Sunday just 17 days after suffering a $223 million exploit" (~$162M was frozen by Sui validators; CoinDesk reported pre-exploit TVL of $284M and a $30M Sui Foundation loan to fund recovery). Weight this in protocol risk.

**Momentum (MMT) — largest Sui DEX by TVL.** Uniswap-v3-style CLMM, ve(3,3). Per a Bitget research report (as of Oct 25, 2025): *"Momentum has over 2.1 million users, $600 million in TVL, and over $26 billion in cumulative trading volume,"* backed by Coinbase Ventures, Jump Crypto, Circle, and OKX Ventures. SDK/docs at docs.mmt.finance; supports operator-delegation (delegate permissions to operator wallets/contracts) and dynamic auto-rebalancing pools — agent-relevant. Has "Momentum vaults" for automated MM strategies. NAVI's Copilot integrates MMT.

**Bluefin — deepest spot DEX volume + perps, routes DeepBook.** Hybrid (off-chain order book / on-chain settlement) for perps; CLMM for spot. ~$84–195M TVL; handles >30% of Sui decentralized spot volume (Dec 2025). API-accessible. **BluefinX RFQ aggregator routes spot trades through Cetus, DeepBook, and Aftermath.** Up to 50x leverage perps (50+ markets), Pyth oracles (400ms price feeds). zkLogin + gasless UX. Backed by Polychain, Brevan Howard, SIG.

**Turbos, FlowX, Aftermath.** Turbos = CLMM that integrated DeepBook's order book for added depth and, per the Sui blog, *"launched high-yield lending pools supplying SUI, USDC, DEEP, and WALRUS, with USDC deposits yielding over 20% annually at launch, in collaboration with DeepBook and Abyss."* FlowX = multi-asset AMM/CLMM. Aftermath = AMM + Smart-Order Router (routes across all liquid Sui DEXs incl. DeepBook via PTB, single-signature execution with split routing), `aftermath-ts-sdk` (Router, Pools, Staking, Farms, DCA, Limit Orders), a Rust SDK (`aftermath-sdk-rust`), plus an **agentic "skills" repo** — strong agent tooling. Aftermath AMM TVL ~$22.8M.

### 5. Aggregators that route through DeepBook
- **7K** (`@7k-ag/7k-sdk-ts`): meta-aggregator across Bluefin7K, FlowX, Cetus; limit orders, DCA, prices. Mainnet-only. Integrated into Scallop V2.
- **Cetus Aggregator** (`@cetusprotocol/aggregator-sdk`): integrates 30+ DEXs explicitly including `deepbookv3`, plus Suilend/Scallop/Momentum/Bluefin etc.; Move + TS integration.
- **Aftermath SOR:** every liquid Sui DEX incl. DeepBook; single-signature PTB execution with split routing (hot-potato slippage checks).
- **NAVI Astros** (`@naviprotocol/astros-aggregator-sdk` / `navi-aggregator-sdk`): routes through Cetus, Turbos, Kriya v2/v3, Aftermath, **DeepBook v3**, Bluefin, Momentum, Magma; `getRoute`/`swapPTB`/`swap`; gas-free swaps; 90,000+ users, 1M+ transactions.

## Recommendations

**Stage 1 — Stand up the lending leg (idle-stablecoin yield).** Integrate **Suilend** (`@suilend/sdk`) first as the primary stablecoin lender (deepest TVL, cleanest obligation/cToken model, claimRewards helpers) and **NAVI** (`@naviprotocol/lending`) as a parallel venue for rate arbitrage and its `*PTB` builders. Use each SDK's event API/indexer for position health and APY. Both are non-custodial; hold the `ObligationOwnerCap`/account objects in your agent's key. *Threshold to act:* route new deposits to whichever of Suilend/NAVI shows the higher net supply APY for USDC/USDT after rewards; rebalance when the spread exceeds your gas+slippage cost.

**Stage 2 — Stand up the DeepBook trading leg with a scoped key.** Create a `BalanceManager`, fund it from treasury (owner key), then `mint_trade_cap` and transfer the `TradeCap` to a separate hot bot key. The bot places/cancels/modifies orders via `@mysten/deepbook-v3` but cannot withdraw funds — exactly the non-custodial separation you want, and the owner can `revoke_trade_cap` instantly if the bot key is compromised. Use the public Indexer for L2 book/OHLCV and the reference `DeepBookMarketMaker` class as your bot skeleton. Stake DEEP to reach maker-rebate / reduced-taker-fee tiers if volume justifies it. *Threshold:* only stake DEEP once projected monthly maker volume × rebate rate exceeds the opportunity cost of the staked DEEP.

**Stage 3 — Compose the two legs atomically.** Build PTBs that, in one transaction, withdraw stablecoins from Suilend/NAVI (owner-signed leg or via a `WithdrawCap`), deposit into the DeepBook BalanceManager, and place orders — or the reverse to sweep idle/settled balances back into the lender. This atomicity (a genuine Sui advantage) eliminates inter-leg settlement risk. For best-execution rebalancing swaps, call the Aftermath SOR, Cetus Aggregator, or NAVI Astros (all route through DeepBook).

**Stage 4 — Optional managed strategies.** If you'd rather not hand-roll LP/looping logic, add **AlphaFi** (`@alphafi/alphafi-sdk`, multi-protocol portfolio + unsigned-tx builders) or **Kai Finance** (`@kunalabs-io/kai`, leveraged vaults + liquidation-bot reference) for auto-compounding. Watch **Volo's MCP / open Vault Standard** and **Aftermath's and NAVI's agentic "skills" repos** — these are the Sui ecosystem's emerging agent-native standards.

**Ranking — best venues for an autonomous agent**

*Lending/yield (weighted: SDK quality 40%, TVL/liquidity 35%, DeepBook composability 25%):*
1. **Suilend** — best SDK maturity + deepest TVL; composes with DeepBook via PTB.
2. **NAVI** — near-equal TVL, most agent-oriented tooling (Copilot, skills, Astros routing through DeepBook), `*PTB` builders.
3. **Scallop** — solid SDK (Builder/Query/Indexer), composable sCoins; smaller/mainnet-only.
4. **AlphaLend / AlphaFi** — cleanest newer SDKs and managed vaults; smaller TVL.

*DeepBook spot/market-making (weighted same):*
1. **DeepBook v3 direct** (`@mysten/deepbook-v3`) — no contest for programmatic CLOB control, scoped caps, PTB atomicity.
2. **Bluefin** — deepest spot volume + API + RFQ that routes DeepBook; good if you want AMM depth + perps.
3. **Cetus** (+ `deepbook-utils-sdk`) — best AMM SDK and a DeepBook utility layer.
4. **Aggregators (Aftermath SOR / 7K / Astros)** — for best-execution swaps that include DeepBook, not for resting maker orders.

*Deepest liquidity:* Momentum (DEX TVL, ~$600M), Suilend & NAVI (lending TVL, ~$745M/$723M at peak), Bluefin (spot volume). DeepBook leads cumulative *volume* ($17B+) despite thin resting TVL (~$11–20M).

*Best programmatic/SDK support for agents specifically:* DeepBook v3, NAVI (skills + Copilot + modular SDKs), Aftermath (skills + Router + Rust SDK), AlphaFi (multi-protocol portfolio SDK), Suilend.

## Caveats
- **DeepBook resting liquidity is thin.** On-book TVL is ~$11–20M; depth is concentrated in a few whitelisted pools (DEEP/USDC, DEEP/SUI, SUI/USDC). An agent posting large maker orders may be the dominant liquidity and should size accordingly and pull quotes during volatility. Cumulative volume ($14.79B DefiLlama / $17B+ Mysten) reflects throughput, not standing depth.
- **DEEP token dependency.** Trading fees in the current design require DEEP (or input-token fees at a 20% premium). Your agent must hold and manage a DEEP balance; staking DEEP unlocks rebates/fee reductions but locks capital.
- **Liquidity fragmentation.** Spot liquidity is split across DeepBook, Cetus, Bluefin, Momentum, Turbos, Aftermath. For execution you'll likely route through an aggregator; for market-making you commit to DeepBook's book specifically.
- **SDK maturity / mainnet-only.** Scallop and 7K SDKs are mainnet-only; Cetus's CLMM SDK has had package-version build quirks (`--dependencies-are-root`). Mysten's SDK 2.0 moved to ESM-only and gRPC/GraphQL — pin versions and budget for the migration. Aftermath notes not all protocols are on testnet.
- **Capability equivocation risk.** A DeepBook `TradeCap` is an *owned* object; concurrent use can risk equivocation (locked objects until epoch change). Per Mysten's own source doc, high-frequency engines should trade as the owner instead; design your nonce/object management accordingly.
- **Network stability.** Per the Sui Foundation post-mortem, *"On Thursday, May 28 and Friday, May 29, 2026, Sui Mainnet experienced three outage incidents. The first two stemmed from crash bugs involving the interaction of gas charging logic and the recent 1.72 release (which introduced address balances)"*; total downtime exceeded 15 hours and the third halt was a latent randomness/DKG state bug, though no user funds were lost. An autonomous agent must handle stalled transactions, retries, and order staleness gracefully.
- **Smart-contract risk.** Cetus suffered a $223M exploit on May 22, 2025 (relaunched 17 days later with validator-frozen funds and a Sui Foundation loan). Weight protocol risk, not just APY/TVL, and prefer audited venues with active monitoring.
- **TVL figures fluctuate and sources disagree.** Sui total DeFi TVL fell from a ~$2.6B October 2025 peak to roughly $570M–$900M ranges cited by different trackers in early 2026; individual-protocol TVLs vary by which DefiLlama sub-view you read. Treat all figures as point-in-time and re-query DefiLlama at integration time.