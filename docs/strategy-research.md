# Autonomous DeFi Strategies on Sui: A Risk-Spectrum Playbook for a Non-Custodial Treasury Agent

> **Scope note:** This is the full strategy universe. **For the hackathon, only Stage 1 (stablecoin lending optimization + allocation solver + circuit breakers) is in scope.** Everything in *Moderate* and *Active* below is roadmap / "future work," not the sprint. See [defi-agent-sui.md](defi-agent-sui.md) for the submission thesis this strategy serves, and [sui-defi-intergation-research.md](sui-defi-intergation-research.md) for venue/SDK selection. This doc owns the **strategy math**; the migration doc owns **thesis + scope**; the integration doc owns **SDK choices**.

## TL;DR
- **Build a three-layer stack.** The agent's core should be **stablecoin lending optimization across Suilend/NAVI/Scallop/AlphaLend** (the most feasible, highest risk-adjusted strategy on Sui today — NAVI USDC supply was ~6.78% in mid-June 2026, 30-day avg 5.49%), wrapped with an **opportunistic DeepBook v3 stable-pair market-making** sleeve and a **small, tightly-bounded leverage/looping component**. Everything composes atomically through Programmable Transaction Blocks (PTBs) and a scoped Move `TradeCap`/capability object.
- **Match strategy to Sui's real constraints.** Lending and yield-bearing-dollar strategies are production-ready with deep liquidity and mature SDKs. DeepBook market-making is *programmatically* excellent (CLOB + SDK + flash loans) but **thin** — DeepBook v3 TVL is only ~$12–16M, so size positions small. Delta-neutral funding (Bluefin perps) and cross-DEX arbitrage are viable but capacity-constrained and MEV/oracle-sensitive. DeepBook Margin (launched January 2026, ~5x SUI/USDC) and Predict (testnet May 5, 2026) are early.
- **Risk controls are math, not vibes.** Use utilization-curve-aware rebalancing breakeven thresholds, Avellaneda-Stoikov inventory-skewed quoting, liquidation-price buffers with health-factor floors, fractional-Kelly position sizing, and hard circuit breakers (depeg detection, drawdown limits, oracle-staleness halts).

## What this is optimizing *for*

This doc optimizes for risk-adjusted return. The hackathon, however, is won on a different axis: **non-custodial delegation + cryptographically verifiable risk bounds + not-reading-as-a-wrapper**. Frame accordingly. The agent's edge isn't the APY — it's that it deploys *other people's* idle capital under bounds anyone can verify on-chain, with the LLM out of the signing path. The strategy below is the substance that makes "agent" credible (a real optimization, not a heuristic); the scoped `TradeCap`/capability object and the attested risk bounds are what make it *trustworthy*. They are the **product**, not just risk plumbing. Optimize the pitch around both — never let it collapse to "our agent earns X%."

---

## Key Findings

1. **Stablecoin lending is the bedrock and the best risk-adjusted play on Sui right now.** Four credible money markets (Suilend, NAVI, Scallop, AlphaLend) expose programmatic deposit/withdraw/claim via TypeScript SDKs. NAVI USDC supply APY was 6.78% (30-day avg 5.49%) in mid-June 2026; rates float with utilization and most protocols layer token-reward APR on top. The "where to put idle USDC/USDT and when to move it" problem is solvable in closed form.
2. **A naive "all-to-highest-APY" heuristic is provably suboptimal.** Because supply rate falls as you add deposits (you push utilization down), the optimal allocation across N lenders is a convex optimization solved by equalizing marginal rates (a water-filling / Lagrangian solution), not concentrating capital.
3. **DeepBook v3 is the standout primitive for an autonomous agent** — a fully on-chain CLOB with a purpose-built market-making SDK (`@mysten/deepbook-v3`), `BalanceManager` + scoped `TradeCap`, flash loans via the "hot potato" pattern, and a public indexer. But low TVL (~$12–16M) means it is a *small-size, opportunistic* venue, not a capacity sink. Cumulative DEX volume is large ($7.4B+), evidencing real throughput.
4. **Concentrated-liquidity stable-stable LP (Cetus/Momentum/Bluefin) is attractive but capacity- and risk-bounded.** Bluefin and Magma USDC/USDT pools hold ~$10M each; Momentum ~$5M. Fee APR on tight stable ranges is modest (back-of-envelope ~0.8–2%+), and LVR is small for a pegged pair but spikes quadratically on depeg events.
5. **Leverage works but is the sharpest knife.** Looping (recursive supply/borrow) and LST-leveraged-staking amplify yield by `L = 1/(1−LTV)`; the strategy is positive-carry only while `L·supplyAPY + rewards > (L−1)·borrowAPY` (see §8), and liquidation risk scales with leverage. Flash-loan one-shot looping (NAVI/Scallop flash loans inside a PTB) avoids iterative gas.
6. **Delta-neutral funding and cross-DEX arbitrage are real but secondary.** Bluefin perps (up to 50x, Pyth oracle, hourly funding) enable basis/funding capture; DeepBook-vs-AMM arbitrage is natural on Sui thanks to atomic PTBs + flash loans. Both need careful capacity, latency, and MEV modeling.

---

## Details

For each strategy below: **(A) the design + math**, then **(B) Sui feasibility**.

### CONSERVATIVE / LOW-RISK

#### 1. Stablecoin lending optimization & yield routing (the core use case)

**(A) Design & math.**

*Net APY.* For a given lender i, the agent earns supply interest plus token rewards minus the amortized cost of moving capital there:
```
netAPY_i = supplyAPR_i + rewardAPR_i − (gas + slippage + swap_fees)/notional / horizon
```
Supply APR is itself a function of utilization. Every Sui money market uses a kinked (two-slope) interest-rate model identical to Aave/Compound. With utilization `U = Borrows / (Borrows + AvailableLiquidity)`, optimal/kink utilization `U*`, base rate `r0`, slopes `s1` (below kink) and `s2` (above):
```
borrowAPR(U) = r0 + s1 · (U/U*)                         if U ≤ U*
             = r0 + s1 + s2 · ((U − U*)/(1 − U*))        if U > U*
supplyAPR(U) = borrowAPR(U) · U · (1 − reserveFactor)
```
The steep second slope above `U*` is why supply APY can spike when a pool is heavily borrowed — and why those spikes are fragile (a single large repay collapses them). Suilend states its supply rate explicitly: **Supply APR = Borrow APR × Utilization × (1 − interest-rate spread)**, with the spread (protocol fee) ~20% of borrow interest.

*Rebalancing breakeven.* Moving capital `C` from lender A to lender B is justified only if the annualized rate pickup exceeds the round-trip cost amortized over the expected holding horizon `H` (in years):
```
(netAPY_B − netAPY_A) · C · H  >  gas + slippage + swap_fees
⟺ Δrate > (totalMoveCost) / (C · H)
```
So a $1M position held a month tolerates moving for a few bps; a $5k position needs a large spread. The agent should compute `Δrate*` (breakeven) and only rebalance when the *observed* spread exceeds it by a safety margin, and crucially must re-price the post-move rate (moving capital in lowers B's rate and raises A's).

**(B) Sui feasibility.** Fully production-ready and the recommended baseline. Programmatic paths:
- **Suilend** — `@suilend/sdk`; supply formula above, ~20% interest spread; pays reward incentives (SEND/sSUI/DEEP/etc.). TVL ~$112M (lending-only DefiLlama snapshot) to ~$163–176M (alternate snapshot — see Caveats on data noise).
- **NAVI** — `@naviprotocol/lending` (rebuilt modular SDK: deposit, borrow, repay, liquidate, claim, flash loans, oracle queries) + `@naviprotocol/wallet-client`; TVL ~$127M; USDC supply ~6.78% mid-June 2026.
- **Scallop** — `@scallop-io/sui-scallop-sdk`; obligation-key account model with up to 5 sub-accounts; TVL ~$15–28M depending on snapshot.
- **AlphaLend** — `@alphafi/alphalend-sdk`; ~$53–67M (DefiLlama tracking is glitchy — one page shows $0, clearly an error).

All four expose PTB-composable calls, so the agent can withdraw from A and deposit to B atomically. Use Pyth for USD valuation. **Gap:** APYs are mostly variable and reward-driven, so the agent must poll on-chain reserve state + reward emissions, not trust a cached number.

#### 2. Cross-protocol allocation optimization (why "all-to-best" is wrong)

> **This is the load-bearing reasoning — the single artifact that proves the agent is not a wrapper.** A judge can dismiss "deposit into the highest APY"; they cannot dismiss "solve a convex program that equalizes marginal rates across protocols, accounting for the agent's own market impact and decaying incentives." Make this the centerpiece of the build and the demo.

**(A) Design & math.** Allocate total capital `W` across lenders to maximize blended yield, accounting for the fact that each protocol's supply rate *declines* as you add deposits (your own market impact). Let `x_i` = amount supplied to lender i, with a combined supply-rate function:
```
R_i(x_i) = baseSupplyAPR_i(u_i)  +  rewardAPR_i(s_i)
```
where `u_i` is utilization (so the base rate falls as you deposit) and `s_i` is *your share of protocol i's reward pool* (so reward APR also falls as you concentrate, and falls again as the emission's USD value drops). **rewardAPR is the real alpha and the real trap:** the agent must re-underwrite incentives at live token prices every cycle, and any allocation that is positive *only* on incentives must be flagged as fragile (incentives can decay to zero, or below the move cost). With `R_i(x_i)` decreasing in `x_i`, maximize total interest:
```
max  Σ_i x_i · R_i(x_i)        s.t.  Σ_i x_i = W,   x_i ≥ 0
```
Form the Lagrangian `L = Σ_i x_i R_i(x_i) − λ(Σ_i x_i − W)`. First-order condition:
```
∂/∂x_i [x_i R_i(x_i)] = R_i(x_i) + x_i R_i'(x_i) = λ   for all funded i
```
i.e., **equalize marginal yield across all funded protocols** (a water-filling solution). Because `R_i' < 0`, the marginal rate `R_i + x_i R_i'` is below the spot rate — concentrating all capital in today's highest spot-APY pool drives its marginal contribution below other pools' rates, leaving yield on the table. The kinked-rate structure makes `R_i(x_i)` piecewise-linear, so the problem is a small convex program the agent can solve with projected gradient or a closed-form per-segment solution (academic treatments give the `x_i*(λ)` per-segment solution explicitly for the kinked-rate case).

**(B) Sui feasibility.** Highly feasible — read each reserve's `U`, `U*`, slopes and `reserveFactor` from chain, build `R_i(x_i)`, solve, and split the deposit across protocols in one PTB. With only ~4 venues and stablecoin pools in the tens of millions, an agent supplying $1–10M will measurably move rates, so modeling own-impact matters. Re-solve on a schedule and only act when the new allocation beats the current one by the rebalancing breakeven margin (Strategy 1).

#### 3. Yield-bearing stablecoins & LST strategies

**(A) Design & math.** Two flavors: (i) hold a yield-bearing wrapper whose price accretes (LST appreciation), and (ii) stake SUI into an LST and deploy it. LST value accretes as `price_t = price_0 · (1 + stakingAPR)^t` (e.g., sSUI starts at 1.0 SUI and rises — Suilend's docs note "1 sSUI may become equivalent to 1.05 SUI"). Staking yield ≈ network issuance + fees, net of validator commission and protocol fee. The agent treats an LST as collateral whose "carry" is `stakingAPR` and whose risk is depeg + smart-contract.

**(B) Sui feasibility.** Production-ready for SUI exposure but **note these are SUI-denominated, not dollar-stable** — only appropriate if the treasury wants SUI exposure. SpringSui (sSUI, instant unstaking via SIP-33, the strongest depeg protection; ~$211M TVL snapshot), Haedal (haSUI, ~$174M), Volo (vSUI, ships an MCP server for agentic yield), Aftermath (afSUI), AlphaFi (stSUI). For a *stablecoin* treasury, the relevant analog is yield-bearing dollar assets (e.g., AUSD, USDY, USDC supplied to lenders, and SUI Group's suiUSDe synthetic dollar deployed into an Ember Protocol vault). **Gap:** true stablecoin "staking" on Sui is really lending; the highest-quality dollar yield is the lending stack (Strategy 1), not LSTs.

#### 4. Auto-compounding (optimal frequency)

**(A) Design & math.** With continuous nominal rate `r`, principal `P`, fixed gas cost `g` per compound, and `n` compounds per year, net end-of-year value is:
```
V(n) = P · (1 + r/n)^n − n·g
```
The first term rises toward `P·e^r` with diminishing returns; the second is linear in `n`. Maximize by setting `dV/dn = 0`. Practically, beyond daily compounding the marginal APY gain is <0.01% for typical DeFi rates (e.g., 12% APR daily-compounded ≈ 12.75% APY, the same as continuous to two decimals), so the optimal `n*` is the largest `n` where the marginal compounding gain still exceeds `g`. The breakeven condition: compound when accrued-but-uncompounded interest `I_acc` satisfies `I_acc · r · Δt > g` — i.e., only when the extra yield-on-yield beats gas.

**(B) Sui feasibility.** Excellent — Sui gas is fractions of a cent and PTBs batch claim+swap+redeposit atomically. AlphaFi and Kai Finance already run auto-compounding/optimizer vaults; an agent can replicate with a scheduled PTB. Because gas is negligible, the agent can compound aggressively (e.g., daily) without eroding returns; many lending positions also auto-accrue in-protocol (no explicit compound tx needed).

### MODERATE RISK

#### 5. DeepBook v3 passive market-making

**(A) Design & math — Avellaneda-Stoikov.** Quote a bid and ask around a risk-adjusted *reservation price*, not the mid. With mid `S`, inventory `q` (signed), risk-aversion `γ`, volatility `σ`, time-to-horizon `(T−t)`, and order-book intensity `κ`:
```
Reservation price:    r = S − q · γ · σ² · (T − t)
Optimal total spread: δ_total = γ · σ² · (T − t) + (2/γ) · ln(1 + γ/κ)
Bid = r − δ_total/2,   Ask = r + δ_total/2
```
The inventory term `−q·γ·σ²·(T−t)` skews quotes to mean-revert inventory: long inventory (`q>0`) lowers `r`, making you more eager to sell; short inventory raises `r`. The spread widens with volatility and risk-aversion and narrows when the book is deep (high `κ`). At `γ→0` you recover symmetric risk-neutral quoting. To manage **adverse selection**, blend `r` toward the microprice (size-weighted bid/ask — a common weighting is ~70% inventory/OFI-adjusted price, 30% microprice) and widen on order-flow-imbalance signals; set a hard inventory cap `|q| ≤ q_max` and stop quoting the side that would breach it.

**(B) Sui feasibility.** This is *the* strategy DeepBook was built for. `@mysten/deepbook-v3` exposes `placeLimitOrder` (poolKey, balanceManagerKey, price, quantity, isBid, expiration, orderType, payWithDeep), `placeMarketOrder`, `modifyOrder`, `cancelOrder`, `cancelAllOrders`, `getLevel2Range` (read book depth), and `checkManagerBalance`. The agent creates a `BalanceManager` (shared object holding balances, up to 1000 traders) and operates via a scoped `TradeCap` — a trader can place/cancel/stake but **cannot deposit or withdraw**, exactly the non-custodial scoped-delegation model the user wants. (Note: the `TradeCap` is an owned object, so a `TradeProof` generated by it risks equivocation in concurrent use; an HFT engine typically trades as the owner. A Rust SDK also exists.) The official `DeepBookMarketMaker` example class is a direct template. Staked-DEEP makers earn rebates and stable-pair taker fees fall to as low as 0.25 bps (2.5 bps on volatile pairs); paying fees in DEEP is 20% cheaper than input-token fees. **Constraint:** DeepBook v3 TVL is only ~$12–16M, so inventory caps must be small; this is a yield *enhancer*, not a core allocator. Quotes update via cheap PTBs; a public REST indexer feeds book state. **Caveat (do not over-allocate):** there is no substantiated public evidence of profitable *autonomous* MM returns on DeepBook at size — the mechanics and tooling are excellent, but thin liquidity caps this. Validate in paper-trade and prove positive realized PnL net of fees/adverse-selection before committing any real allocation.

#### 6. Stablecoin concentrated-liquidity LP (Cetus / Momentum / Bluefin)

**(A) Design & math.** For a USDC/USDT CLMM position over price range `[p_a, p_b]` around peg `≈1.0`, liquidity `L` relates token reserves to price; fee APR scales with `volume × feeTier / TVL_in_range`. Concentrating into a tight band (e.g., 0.999–1.001) multiplies capital efficiency but exits to one-sided inventory if the peg breaks. The drag is **Loss-Versus-Rebalancing (LVR)**, the cost of arbitrageurs trading against stale quotes (Milionis–Moallemi–Roughgarden 2022):
```
Instantaneous LVR rate = (σ² / 2) · p² · |V''(p)|
For a Uniswap-v3-style position in range:  V''(p) = −L / (2 · p^{1.5})
⟹ LVR per unit time ≈ (σ² · L) / (4 · √p)
```
LP is profitable when `feeIncome > LVR + gas`. For a pegged stable pair, `σ` is tiny so LVR is small — but it scales with σ² (2× vol ⇒ 4× LVR), so it spikes during depeg events. Rebalancing logic: re-center the range when price drifts to an edge, but only if expected incremental fees exceed gas + realized LVR (the same fee>cost test).

**(B) Sui feasibility.** Viable with modest size. Use `@cetusprotocol/cetus-sui-clmm-sdk` (`Pool.createPoolTransaction`, `Position.addLiquidityTransaction` with `lowerTick`/`upperTick`) for tight stable ranges (0.01% fee tier). Momentum (largest Sui CLMM, $600M+ TVL overall; USDT/USDC pool ~$5M, ~$21M/day volume), Bluefin spot (USDT/USDC ~$10M at a 0.001% fee, ~$21M/day), and Magma (~$10M) are alternatives. Back-of-envelope fee APRs are modest (e.g., Bluefin ~0.76%, Cetus's small 0.01% pool ~2.2% — author estimates, exclude reward mining). **Risk flag:** Cetus suffered a **~$223M exploit on May 22, 2025** via a `checked_shlw` overflow bug in the `integer-mate` library; ~$60M was bridged to Ethereum and ~$162M was frozen on Sui at the validator level and largely recovered (per Cyfrin). Smart-contract risk is real — prefer audited, battle-tested pools and cap exposure. AlphaFi runs auto-rebalancing USDC/USDT vaults on Cetus liquidity if the agent prefers to outsource range management.

#### 7. Delta-neutral basis / funding-rate strategies

**(A) Design & math.** Hold long spot + short perp of equal notional so price PnL cancels (`Δ ≈ 0`) and you harvest funding. On Bluefin, "Funding Payments are accumulated at every hour's end... If the Funding Rate is positive, long position holders pay short position holders":
```
fundingPayment = positionNotional × fundingRate     (per hourly interval)
fundingRate ∝ (perpPrice − indexPrice)/indexPrice  + interest component
```
If funding is persistently positive, shorts get paid: net carry ≈ `fundingAPR + spotYield(if spot is lent) − financing − fees`. Basis (perp − spot) convergence adds/subtracts. Construct neutrality with `spotQty = perpQty` (base units); rehedge when `|Δ|` drifts past a band. Size so a worst-case adverse move doesn't liquidate the perp leg (keep perp margin well above maintenance).

**(B) Sui feasibility.** Feasible on **Bluefin Pro** (50+ perp markets, up to 50x leverage, Pyth feeding spot prices every ~400ms, 8-hour funding, cross-margin wUSDC; off-chain matching, on-chain settlement). Spot leg can be the actual token or an LST. DeepBook Margin offers an alternative **funding-rate-free** leverage path (you borrow the spot asset and pay a stable borrow fee, no funding) — useful when funding is unfavorable. **Constraints:** SUI-PERP and majors have decent depth, but capacity and funding-rate stability are binding; this is a tactical overlay, not a core allocator. Hedge rebalancing is programmatic via Bluefin's SDK.

#### 8. Looping / leveraged lending

**(A) Design & math.** Recursively supply → borrow → re-supply to amplify a positive carry. With loan-to-value `LTV`, the geometric series converges (e.g., 77% LTV → ~$434.78 deposit per $100, ~4.3x; 90% LTV → 10x):
```
Max leverage:   L = 1 / (1 − LTV)
Effective APY:  APY_eff = L · supplyAPY − (L − 1) · borrowAPY   (+ reward APR on both legs)
```
The strategy is positive only while `L·supplyAPY + rewards > (L−1)·borrowAPY`. Liquidation: with collateral value `Coll`, debt `D`, weighted liquidation threshold `LT`, a position is liquidatable when health factor `HF = (Coll·LT)/D < 1`. For a same-asset stable loop the price is ~1 so risk comes mainly from rate divergence and depeg; for cross-asset loops the liquidation price of collateral is:
```
p_liq = D / (Coll_qty · LT)
```
Keep `HF` above a floor (e.g., ≥1.25) and de-lever when borrowAPY rises enough to flip net carry negative.

**(B) Sui feasibility.** NAVI has **Automatic Leverage Vaults**, and its lending SDK exposes the full supply/borrow/repay loop plus flash loans, so the agent can do **one-shot flash-loan looping** inside a PTB (flash-borrow → supply → borrow → repay flash loan) rather than dozens of iterative txns. Suilend and Scallop also support the primitives; Kai Finance offers leveraged-yield vaults with a public liquidation-bot example. **Risk flag:** highest-risk of the "moderate" bucket — keep leverage low (e.g., ≤3x on stables), monitor borrow-rate spikes (the kinked curve can push borrow APY above supply APY fast at high utilization), and wire circuit breakers on `HF` and on net-carry going negative.

### ACTIVE / HIGH-COMPLEXITY

#### 9. Active DeepBook market-making with inventory/adverse-selection management

Extends Strategy 5 with multi-level quoting (geometric grid of orders), dynamic `γ`/spread from realized volatility, order-flow-imbalance and VPIN-style toxicity detection, and aggressive inventory mean-reversion. Position sizing per quote level via fractional Kelly (below). Same SDK path; needs a low-latency loop reading the indexer and re-quoting via PTBs. Feasible but **liquidity-bounded** — best on the deepest pairs (SUI/USDC, DEEP/USDC) and small size. Per the January 30, 2026 DeepBook Spaces recap, **Lotus Finance's HFT market-making has already demonstrated extremely high volume-to-TVL ratios on DeepBook (Aslan cited ~400x on certain days)** — evidence the venue supports HFT MM programmatically.

#### 10. Cross-venue / cross-DEX arbitrage

**(A) Design & math.** Detect when the product of exchange rates around a cycle deviates from 1: for a path SUI→USDC→X→SUI with quoted prices `P1,P2,P3`, profit exists if `P1·P2·P3 > 1 + totalFees + slippage`. Execute atomically — flash-borrow, swap across venues, repay, keep residual — all in one PTB. Net:
```
π = notional · (∏ P_i − 1) − fees − slippage − gas − flashLoanFee
```
Only fire when `π > 0` after worst-case slippage at the intended size.

**(B) Sui feasibility.** Sui is *unusually* good for this: PTBs are atomic (all-or-nothing, up to 1024 ops), and Move's "hot potato" flash-loan pattern makes non-repayment a *compile-time impossibility* (the borrowed `FlashLoan` struct lacks `drop`/`store`, so a PTB that fails to return it is invalid), not a runtime check — per Trail of Bits' analysis of DeepBook v3. DeepBook v3 exposes `borrow_flashloan_base`/`return_flashloan_base`; NAVI/Scallop/Bucket also offer flash loans (the `suiflash` aggregator routes best-cost). Aggregators (NAVI Aggregator SDK with `getRoute`/`swapPTB`, Cetus Plus, Aftermath router, Astros) route across Cetus/Momentum/Bluefin/DeepBook/Turbos. Open-source bots (e.g., "Sharky") already do triangular arb across Cetus/Turbos/Scallop/NAVI with flash loans. **Constraint:** thin books mean small per-trade profit and frequent reverts; latency races cap edge. Treat as opportunistic and capital-light (flash-loan funded — failed arbs cost only gas).

#### 11. Liquidation bot

**(A) Design & math.** Monitor positions; when `HF < 1`, repay up to the close factor of the debt and seize collateral + bonus. Profit:
```
π = repaidDebt · liquidationBonus − gas − swapSlippage(on seized collateral) − flashLoanFee
```
Per Suilend's docs: a liquidator "repays 20% of the BTC loan, $1,600, collects $1,600 from the collateral USDC supply to cover the BTC, then collects an additional 5% ($80) as a bonus." Scallop uses **soft liquidation** — "liquidators only repay up to 20% of a borrower's total debt per liquidation call, and receive a portion of the borrower's collateral at a discount" — with the penalty−discount spread accruing to the protocol. NAVI's bonus is per-asset. Fire only when bonus value exceeds gas + the slippage of offloading seized collateral.

**(B) Sui feasibility.** Strong fit. NAVI/Suilend/Scallop liquidation calls are in their SDKs; **DeepBook Margin exposes a public, incentivized liquidation endpoint** with Pyth-driven checks (searchers actively compete). Flash-loan the repayment, liquidate, swap collateral, repay — atomic PTB. Kai Finance ships a liquidation-bot example. **Constraint:** competitive; profitability depends on being first and on collateral being liquid enough to offload without eating the bonus.

#### 12. Delta-neutral LP / funding arbitrage (CLMM LP + perp hedge)

Combine Strategy 6 (earn LP fees) with a perp short sized to neutralize the LP's net delta (which drifts as price moves through the range — the LP is short gamma). Continuously rehedge `Δ_LP + Δ_perp ≈ 0`. The math couples the CLMM delta (`∂V/∂p`, changing across the range) with the perp hedge ratio; profitable when `feeAPR > LVR + hedgingCost + fundingPaid`. Feasible (Cetus/Momentum LP + Bluefin perp) but operationally heavy — rehedging frequency vs. cost is the key tradeoff. Best left to a later phase.

#### 13. Statistical arbitrage / mean-reversion on correlated Sui pairs

Trade the spread between cointegrated pairs (e.g., two LSTs vs SUI, or stable-stable deviations) when the z-score of the spread exceeds a band: enter at `|z| > z_in`, exit at `|z| < z_out`, size by fractional Kelly. Mechanically feasible (DeepBook/CLMM execution) but **data- and capacity-limited** on Sui — few deeply liquid, genuinely cointegrated pairs exist; highest research burden, lowest current capacity. Lowest priority.

### Risk-management math (applies across the stack)

- **Position sizing (fractional Kelly).** Full Kelly fraction `f* = (bp − q)/b` (discrete bets, `b` = reward:risk, `p` = win prob, `q = 1−p`) or `f* = (μ − r)/σ²` (continuous, excess return over variance). Use **quarter- to half-Kelly** — full Kelly's ~60–80% max drawdowns are unacceptable for a treasury; half-Kelly captures ~75% of long-run growth at roughly half the drawdown. Cap any single strategy at a hard % of treasury regardless of Kelly output, and recompute edge inputs every 50–100 trades.
- **Depeg circuit breaker.** Halt lending/LP and exit if `|price_stable − 1| > threshold` per Pyth, or if the Pyth confidence interval widens / feed goes stale beyond N seconds. The threshold is a **tunable policy parameter** (50 bps is a reasonable default, not a constant) — expose it on the capability/policy object so the owner can set it.
- **Drawdown limit.** Track rolling PnL per sleeve; if drawdown exceeds a cap (e.g., 2% of treasury for the MM sleeve), flatten and pause that sleeve.
- **Leverage/HF floor.** Maintain `HF ≥ 1.25` on any borrowed position; auto-deleverage (flash-loan unwind) on breach or on net-carry < 0.
- **Oracle/venue health.** Gate all actions on Pyth freshness and a max-slippage check; because PTBs are atomic, a breach simply reverts the whole transaction (no partial state, only gas lost).

---

## Recommendations

**Stage 1 — Ship the core (weeks 1–4).** Deploy stablecoin lending optimization across Suilend + NAVI (then add Scallop, AlphaLend). Implement the kinked-rate model reader, the convex allocation solver (equalize marginal rates), and the rebalancing-breakeven gate. Auto-compound via scheduled PTBs (gas negligible). Wire Pyth-based USD valuation, depeg circuit breaker, and per-protocol exposure caps. **Allocate ~70–85% of treasury here.** Benchmark to beat: blended net APY > best single-protocol spot APY, with <1 rebalance/day.

**Stage 2 — Add the MM sleeve (weeks 4–8).** Stand up a DeepBook v3 `BalanceManager` + scoped `TradeCap`, implement Avellaneda-Stoikov quoting on the deepest stable/SUI pairs with hard inventory caps, microprice blending, and OFI-based widening. **Allocate ~5–15%**, small absolute size given ~$12–16M venue TVL. Add a stable-stable CLMM LP position (Cetus/Bluefin 0.01%/0.001% tiers) if fee APR clears the LVR+gas test. Benchmark: MM+LP sleeve net of LVR/fees > the lending baseline on that capital; else fold back into Stage 1.

**Stage 3 — Tactical overlays (weeks 8+).** Add (a) one-shot flash-loan looping on NAVI capped at ≤3x with `HF ≥ 1.25`, (b) a liquidation bot against Suilend/NAVI/DeepBook Margin, and (c) opportunistic cross-DEX flash-loan arbitrage. **Allocate ≤10% combined**, capital-light (flash-loan funded where possible). Benchmark: each overlay must show positive realized PnL net of gas/slippage over a 2-week paper-trade before live capital.

**Ranking by risk-adjusted return × current Sui feasibility (best first):** (1) stablecoin lending optimization + allocation solver; (2) auto-compounding (free on Sui); (3) yield-bearing-dollar / lending-of-LST; (4) DeepBook stable MM (small size); (5) stable-stable CLMM LP; (6) liquidation bot; (7) ≤3x looping; (8) delta-neutral funding (Bluefin); (9) cross-DEX flash arb; (10) delta-neutral LP; (11) stat-arb.

**Best suited to a fully autonomous agent** (clear decision rules + bounds): lending optimization, allocation solver, auto-compounding, looping with HF guard, and liquidation bots — all have deterministic triggers and PTB-atomic execution. **Need more discretion/liquidity than Sui currently offers:** active HFT market-making at scale, delta-neutral LP rehedging, and stat-arb.

**Thresholds that change the plan:** If DeepBook v3 TVL/volume grows materially (e.g., >$50M TVL on Margin adoption), promote MM to a larger allocation. If borrow APY on stables persistently exceeds supply+reward APY, disable looping. On a depeg or oracle-staleness event, fall back to 100% in the single most-liquid, highest-quality lending pool (or idle native USDC) until conditions normalize.

---

## Caveats

- **Looks good on paper, impractical at size on Sui today:** pure DeepBook HFT market-making and statistical arbitrage — the *tooling* is excellent but liquidity (DeepBook v3 TVL ~$12–16M) caps deployable size; these are yield enhancers, not allocators. Cross-DEX arb edge is real but small and competitive.
- **Smart-contract risk is not hypothetical:** Cetus lost ~$223M on May 22, 2025 to a `checked_shlw` overflow bug. Diversify across audited protocols; cap per-protocol exposure; prefer instant-unstake LSTs (SpringSui SIP-33) over those reliant on liquidity for redemption.
- **Early/immature primitives:** DeepBook Margin (launched January 2026 — initial leverage 5x on SUI/USDC, ~3x on DEEP; up to 10x cap; isolated, currently permissioned pools; ~$20M cumulative volume) and Predict (testnet May 5, 2026; pricing model built with Block Scholes) are promising but young — treat as experimental, not core.
- **Reward APR is fickle:** much of the headline stablecoin APY is token incentives that decay; the agent must value rewards at live prices and re-underwrite continuously.
- **TVL/APY data is noisy:** DefiLlama snapshots conflict across its own pages (Suilend $112M vs $163–176M; AlphaLend shows $0 in one table, clearly a glitch; DeepBook v3 protocol TVL ~$15.8M vs ~$11.6M depending on page; reported 24h volume varies from ~$12M to ~$75M across snapshots). The agent should read state on-chain, not trust dashboards.
- **No public mempool MEV market on Sui** (unlike Ethereum) reduces sandwich risk, but latency races still exist; atomic PTB reverts mean failed arbs cost only gas — the right design for an autonomous executor.
- **LSTs are SUI-denominated**, not dollar-stable — only deploy them if the treasury mandate allows SUI exposure; otherwise the dollar-yield path is lending + yield-bearing dollar assets (AUSD, USDY, suiUSDe, supplied USDC/USDT).
- **Numbers are mid-June 2026 snapshots** of an intraday-variable market; the agent must treat every APY/TVL/volume figure here as a starting estimate to be re-measured on-chain at runtime.