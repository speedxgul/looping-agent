# defi-agent → Sui Overflow: migration & submission checklist (v2)

> **doc map:** this doc owns **thesis + scope**. see [strategy-research.md](strategy-research.md) for the **strategy math** (allocation solver, looping, MM, risk controls) and [sui-defi-intergation-research.md](sui-defi-intergation-research.md) for **venue / SDK selection**.

**short version:** keep the brain (the agent loop), but keep the LLM *out of the money-moving step*; rebuild the hands on Sui. and reframe the pitch — a capped budget is table stakes (every serious agent does scoped delegation), so the novelty has to move up to **non-custodial delegation + attested risk**. realistically a chain-layer rewrite, not a port.

**the frame (state it this way):** you're building *a non-custodial agent that deploys other people's idle capital under on-chain risk bounds you can cryptographically verify* — LLM confined to planning/explanation, a deterministic layer moving funds. that framing is what makes every piece load-bearing and what separates it from the wrapper crowd. it's also the framing under which the TEE is *necessary* (managing others' funds = the trust gap), not decorative.

**target track:** Agentic Web (primary) — maps to the "autonomous agent wallet with a capped budget via a Move policy object" sub-track. structure it to also reach **Walrus** (memory) and **DeepBook** (execution venue). the risk-controls piece below also lines up with the "autonomous risk guardian" sub-track.

---

## keep as-is
- the agent-loop scaffold — `run-once` / `run-daemon`, `MAX_TOOL_ROUNDS`, the observe → decide → act cycle. (the loop stays; its *authority over funds* doesn't — see the two rules below.)
- the `DRY_RUN` master switch and the safety-gating philosophy
- the persistent-memory patterns: dedup, cooldown, action-then-receipt
- the discipline of "never claim an action executed unless a tool result confirms it"

## replace (the actual work)

| today (Base) | Sui version | why |
|---|---|---|
| EVM calls in TS (ethers/viem) | Sui TS SDK (`@mysten/sui`) + a Move package | required — it's a Sui hackathon |
| Fluid / Instadapp lending | **DeepBook** (spot/margin) for a trading/LP strategy, **or** a Sui lender (Scallop / Suilend / NAVI) for the "park idle capital" thesis | DeepBook unlocks the DeepBook track; a lender is the closer analogue of Fluid |
| TS safety policy (`FLUID_MAX_SUPPLY`, allowlist, cooldown) | a **non-custodial Move capability object**: funds stay in the *user's* account; the agent holds a scoped, revocable capability — whitelisted protocols only, per-tx + rolling caps, expiry, **can't touch principal, can't send to arbitrary addresses** | the universal credible pattern (Giza, Almanak, Newton, Coinbase). note: it's **table stakes, not the novelty** — do it right; the novelty lives in the risk + verifiability layers below |
| agent holds a raw private key in env, LLM drives the loop | **secret isolation**: keys + API secrets never enter the LLM context; the model calls a controlled tool API while a separate signer holds the keys (gateway / sidecar pattern) | kills prompt-injection key exfiltration; it's the security standard and a clean judge talking point |
| local JSON memory (`agent-state.json`) | **Walrus (MemWal)** for memory blobs + **Seal** for access control | verifiable, portable, auditable memory = the Walrus-track hook |
| EOA / Coinbase smart account | a Sui keypair for the agent; **zkLogin** + **sponsored transactions** for owner onboarding | gasless, no-friction, clean non-crypto demo |
| `post_deposit_update` (X) as the "proof" | an on-chain **receipt object/event** per action | real proof lives on-chain, not in a tweet |
| MoltX swap quotes | DeepBook quotes / a Sui DEX aggregator | native data source |

## two rules that separate this from a wrapper
the competitive read was blunt: most "AI agents" are deterministic optimizers or LLM wrappers, and Agentic Web explicitly filters wrappers out. two non-negotiables:

- **LLM out of the execution path.** the model parses intent, plans, and explains — it never signs. a deterministic, schema-validated layer moves funds: validate every step against live on-chain data, and constrain execution to pre-verified action templates (HeyAnon's and Wayfinder's patterns). this is *the* line between agentic and wrapper, and it's far safer.
- **load-bearing reasoning.** "deposit into the highest-APR market" is a heuristic — it's exactly the wrapper tell, and it's what Giza's ARMA did *before* the AI claim was real. replace it with an actual allocation optimizer (convex / MILP-ish across a few markets, accounting for gas and the fact that your own size moves the rate). a genuine optimization problem is what makes the "agent" credible. if you'd rather keep a heuristic for the timeline, fine — then drop the "agentic" emphasis and lead with custody + verifiability instead of claiming reasoning you don't have.

## add
- a deployed Move package on **mainnet or testnet**, with the **Package ID in the README**
- per-action **on-chain receipts** + an owner **revocation** path for the capability object (the sub-track requires a revocation demo)
- **risk controls as a first-class feature** — position limits, a depeg / liquidation guard, and a circuit breaker — and make them **attested** (enforced and proven inside the TEE). risk management is the weakest layer across the entire field; this is your clearest differentiation wedge, and it maps to the "autonomous risk guardian" sub-track.
- a real-world mission framing: *"a non-custodial agent that deploys idle stablecoins for users who shouldn't have to trust the operator, under verifiable risk bounds"* — not "deposit + tweet." real-world application is the heaviest-weighted criterion.
- the submission package: **public GitHub repo**, demo video (YouTube, **≤5 min**), 1:1 logo, optional website

## drop / deprioritize
- **X-posting as a core feature** — it's build-in-public engagement, not real-world utility. nice-to-have at most.
- the unimplemented `ENABLE_AUTONOMOUS_SWAPS` flag — build a real DeepBook swap/trade tool or cut it.

---

## minimum viable submission
user keeps funds in their own account and grants a **scoped, revocable capability** → the agent loop reads market + risk state on Sui → a **deterministic optimizer** picks an allocation *within the capability's limits* → executes via a PTB (**the LLM never signs**) → writes an **on-chain receipt** → memory on **Walrus**, gated by **Seal** → owner can **revoke** → a **circuit breaker** halts on a depeg or limit breach. deployed to testnet with a Package ID, a 5-min demo, and a public repo.

that's a coherent, novel, Agentic-Web entry that doesn't read as a wrapper. everything past it — the TEE moat, DeepBook strategy depth, multi-agent decomposition — is stretch.

## the strategy the agent runs (researched)
the MVS above says "a deterministic optimizer picks an allocation." this is what it actually optimizes. (verified against 2025–2026 Sui data via a multi-source research pass; see sources at the end of this section.)

**core strategy — incentive-aware cross-protocol stablecoin lending.** the agent splits idle stablecoins across **Suilend / NAVI / Scallop / AlphaLend** to maximize blended *net* APY, rebalancing when the edge beats gas. the optimization is genuine — and this is the part that separates it from "deposit into highest APR":

- each market's **base supply APY is a function of utilization** (suppliers earn ~80% of borrow interest; the protocol keeps a ~20% spread), so your own deposit *moves the rate* — your size is a variable, not a constant.
- on top of base rate sits a **floating incentive APR** (e.g. Scallop's veSCA boost, up to ~4×) that **decays as more capital farms it** — a moving target that depends on your allocation and everyone else's.
- so the objective is: maximize Σ( allocᵢ × [ baseAPYᵢ(utilization) + incentiveAPRᵢ(your share of the reward pool) ] ) subject to per-protocol exposure caps, a min-position threshold, and the gas cost of each move. that's a real constrained optimization across 3–4 markets — demoable in seconds, impossible to dismiss as a wrapper.
- live depth is there (Q2-2025 snapshots): Suilend ≈ $701M supplied / $166M borrowed, NAVI ≈ $673M / $175M, Scallop ≈ $146M / $48M, AlphaLend ≈ $137M / $73M — all sub-100% utilization, all with production TypeScript SDKs.

**headline differentiator — depeg + health circuit-breaker overlay.** runs every tick: watch a Pyth feed for USDC/USDT depeg and obligation health across protocols; on a breach, deterministically unwind to the safest market or to idle. this is the "attest each action stayed within the risk bounds" wedge — and it's the most demoable piece (force a breach on stage, watch it fire).

**DeepBook = plumbing, not strategy.** the research pass found **no substantiated evidence** on DeepBook v3 market-making returns/boundability *or* Bluefin delta-neutral funding strategies — under-documented and unproven for an agent, and DeepBook resting liquidity is thin (~$11–20M). so use DeepBook only as the **swap venue** when the optimizer rotates between assets (an honest nod to that track, zero MM risk). don't build a market-maker as the core under a deadline.

**looping is a knife-edge — demote it to a risk-demo.** recursive deposit→borrow→redeposit is net-positive *only* when supply-APY-including-incentives exceeds borrow APY; strip the reward subsidy and it loses money (a study of skilled loopers found ~–27 bps/day; loops at HF≈1.02 are >10× leverage). worse for us: Suilend's one-click "looping" products are **LST-vs-SUI (sSUI/SUI) staking loops, not stablecoin loops** — pure-stablecoin looping isn't a subsidized native product on Sui today. so keep it as a *vignette* — "watch the guardian catch a risky leverage loop as HF decays" — not as a yield source.

**CLMM auto-rebalancing (Cetus / Momentum / Kriya) — optional, tail-risk heavy.** range-rebalancing LP is a real optimization (Reset/Target bands) but carries catastrophic smart-contract risk: the **Cetus ~$223M exploit (May 22 2025, a `checked_shlw` overflow)**. only reach for it if the lending core is done, and weight protocol risk, not just APY.

**non-custodial choke-point — go native Move.** an off-the-shelf option exists (Lit **Vincent**: policy-gated pre-signing + MPC PKP so the agent never holds keys), but it's EVM-proven and native Sui signing is unestablished. for a *Sui* entry the **Move capability object + DeepBook `TradeCap` / a Move policy-guard** is the more credible, more native choke-point. keep Vincent only as a non-Sui fallback.

**ranking (for an autonomous, risk-bounded treasury agent):**

| strategy | verdict | wrapper test | demo / bound |
|---|---|---|---|
| incentive-aware cross-protocol lending | **core** | passes — incentive-decay optimization is real reasoning | easy demo, clean caps/allowlist |
| depeg + health circuit-breaker overlay | **headline differentiator** | the attested-risk-bounds wedge | very demoable (force a breach) |
| stablecoin looping | stretch / risk-demo only | real but negative-carry on Sui today | use to *show the guardian*, not for yield |
| CLMM auto-rebalancing | optional | real (range optimization) | bounded but carries Cetus-scale SC risk |
| DeepBook MM / Bluefin delta-neutral | **not core — unevidenced** | n/a | hard to bound, no proven returns |

**lock:** incentive-aware cross-protocol lending (core) + depeg/health circuit-breaker (headline); DeepBook as routing; looping as a guardian-demo vignette.

*sources: [Suilend yield mechanics](https://docs.suilend.fi/faq/how-does-yield-on-suilend-work), [Suilend strategies](https://docs.suilend.fi/faq/what-is-suilend-strategies), [Sui Q2-2025 DeFi roundup](https://blog.sui.io/q2-2025-defi-roundup/), [Sentora recursive-lending analysis](https://medium.com/sentora/recursive-lending-strategy-85fc93b05fcb), [arXiv 2512.11976 on looping leverage](https://arxiv.org/html/2512.11976v1), [Cyfrin Cetus $223M post-mortem](https://www.cyfrin.io/blog/inside-the-223m-cetus-exploit-root-cause-and-impact-analysis), [Lit Vincent](https://github.com/LIT-Protocol/Vincent).*

## optional moat — confidential strategy via Nautilus (TEE)
the stretch layer that turns a solid agent into a standout. **a differentiator, not a requirement** — the MVP above is already valid and novel. reach for this once the MVP works; it leans on TEE/privacy, the unfair advantage on this team.

**what it adds:** run the agent's *decision logic* inside a TEE so the strategy stays secret, and have the enclave return an attestation a Move contract verifies before it acts. the sharper wedge (do this): attest not just *that the committed code ran*, but **that each action stayed within the risk bounds**. attesting code is table stakes among TEE agents (Phala / Kosher / Newton all do it); attesting *risk-bounds* is the open lead.

**don't do raw AWS Nitro — use Marlin Oyster.** Nautilus supports Dockerized deployments through Marlin Oyster: hand it a Docker image, it runs it in a Nitro enclave, and the attestation is still Nitro so Nautilus's Move verifier works unchanged. skips the EC2 / nitro-cli / vsock setup.
- avoid Phala here: easier infra, but it's Intel TDX + EVM-shaped (its on-chain verifier is Solidity, no Move verifier for its attestation on Sui). going Phala means hand-writing a TDX quote verifier in Move — more work than the Nitro setup you're avoiding.

**how it works (two phases):**
- *register once:* the enclave boots, generates a keypair, and gets an AWS-signed attestation binding that key to a measurement (PCR) of the exact image. a Move function verifies AWS's cert chain and checks the PCR matches your committed build, then stores the enclave pubkey on-chain. (expensive — done once.)
- *verify per cycle:* the enclave signs each decision; Move checks the signature against the registered pubkey (cheap). a valid signature means "this came from the unmodified, registered code."

**what makes it safe — the checks before funds move:** (1) is the decision signed by the attested enclave? (2) is it within the capability's budget / allowlist? (3) is it within the risk bounds? no single layer is trusted. a compromised host can't forge a decision (no enclave key); a compromised strategy can't drain the treasury (the on-chain caps are the backstop) or breach the risk limits (attested).

**Walrus + Seal close the loop:** the strategy weights / memory live encrypted on Walrus, gated by Seal; the enclave is the only thing that can decrypt them — it pulls the blob, decrypts *inside* the TEE, computes, and emits only the signed result, so the weights never hit disk in plaintext. this is the canonical Nautilus × Walrus × Seal composition, and it's why the TEE route also reaches into the Walrus track.

**gotcha that separates a real build from a demo:** a TEE attests the *code*, not the *inputs*. a malicious host could feed the enclave fake prices. authenticate inputs inside the enclave — e.g. verify Pyth's signed feed in-enclave — or the compute is honest but garbage-in.

**feasibility:** with Marlin Oyster the infra lift is mostly gone. what's left is the reproducible build (so the PCR is verifiable) and the Move attestation verifier — Nautilus ships a template for both. the strategy itself can be trivial for the demo; you're proving the attested-compute → Move-verify → capped-execute pipeline end to end, not real alpha. latency and cost are fine for a loop that fires every few minutes.

## where you sit vs the field (Sui)
- **NODO** already runs concentrated-LP vault optimization on Momentum (the largest Sui DEX); **Talus (Nexus)** provides on-chain verifiable workflow receipts on Sui. your wedge — **idle-stablecoin deployment + attested risk caps + non-custodial delegation of *others'* funds** — is territory neither directly occupies.
- consider building the receipt / workflow layer **on Talus Nexus** instead of hand-rolling it: "built on Talus" is a clean Sui-native story and saves you time you can spend on the risk + attestation differentiators.

## ship-to-mainnet note
prizes pay 50% on announcement and 50% after a successful mainnet deploy — but **100% upfront if you're already on mainnet by the August announcement**. scope the MVP so a minimal mainnet deploy is realistic; it's effectively a 2× on the payout.
