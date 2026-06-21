# DeFi Agent v0

A production(Mainnet) multi-agent autonomous DeFi treasury system on **Sui** that executes real
on-chain lending actions, with **two decision engines** over one deterministic
enforcement layer:

- a **main agent** — an OpenAI tool-calling loop that plans and explains, and
- a **six-subagent pipeline** — rate-scout, position-risk, loop-strategist,
coordinator, executor, and unwind-guard, cooperating through a shared strategy ledger
to run **single-depth USDC→SUI yield loops** with no LLM in the fund-moving path
(see [the subagent pipeline doc](../docs/subagent-pipeline.md)).

Local tool adapters perform bounded lending actions:

- reads lending markets, positions, borrow limits, and health factors across Suilend, NAVI, and Scallop when enabled
- compares supply/borrow APRs across Suilend, NAVI, and Scallop for allowlisted assets
- persists run history and position actions in `data/agent-state.json`, or on **Walrus** as verifiable, portable blobs (see Walrus Memory & Verifiable Storage)
- can carry **long-term semantic memory** across sessions and machines via **MemWal (Walrus Memory)**
- reads Sui wallet USDC/SUI balances and live protocol APRs to pick allowlisted assets
- routes idle USDC with an own-impact-aware allocation solver that uses reserve curves and water-filling
- can supply, withdraw, borrow, and repay on Suilend, NAVI, and Scallop when signer config, protocol write flags, and policy gates allow it
- auto-repays the largest borrow when health factor drops below `SUI_MIN_HEALTH_FACTOR` (before the LLM loop)
- can post confirmed supply updates to X when X posting is explicitly enabled
- defaults to `DRY_RUN=true`, so it will not post or execute transactions unless explicitly enabled

The off-chain system runs autonomously against live protocols today. The companion  
on-chain Move package ([../move/](../move/)) adds provable non-custodial custody and
is on the roadmap (receipt-custody `verified_supply`, on-chain bounds verifier).

## Quick Start

```bash
cp .env.example .env
# set OPENAI_API_KEY and AGENT_SUI_PRIVATE_KEY in .env
bun run doctor
bun run run:once          # one main-agent loop
bun run run:supervisor    # main agent + the six-subagent loop pipeline
```

Set `AGENT_WALLET_ADDRESS` (or `AGENT_SUI_ADDRESS`) to the address derived from your Sui private key.

## Project Shape

```text
src/
  clients/
    chain/        Sui execution + lending protocol clients (Suilend, NAVI, Scallop)
    http/         off-chain API clients (OpenAI)
    storage/      Walrus blob + MemWal memory clients
  core/           main agent loop, subagent pipeline (subagents.ts), strategy ledger
                  (strategyLedger.ts), allocation solver, agent memory, memory store,
                  policy, health guard, tools
  utils/          config, http, amounts, Sui private key, logging helpers
scripts/
  memwal-keygen.ts        generate a MemWal delegate key
  check-suilend-rates.ts  print live Suilend market rates
  verify-allocation.ts    print allocation solver legs + APR math
data/
  agent-state.json     local persistent memory / Walrus cache (gitignored)
  strategy-ledger.json subagent pipeline state — snapshots/proposals/plans/receipts (gitignored)
  walrus-pointer.json  latest Walrus state blob id (gitignored)
```

This is the `agent/` package of a monorepo. The on-chain Move package lives in
[`../move/`](../move/) and the docs in [`../docs/`](../docs/):
[architecture.md](../docs/architecture.md) (what's built),
[strategies.md](../docs/strategies.md) (strategies + math),
[subagent-pipeline.md](../docs/subagent-pipeline.md) (the loop pipeline),
[autonomy.md](../docs/autonomy.md), [deployment.md](../docs/deployment.md), and
[treasury-agent-design.md](../docs/treasury-agent-design.md). All commands here run from
`agent/`, or from the repo root via the passthrough scripts.

## Behavior

The system runs two engines. `bun run run:supervisor` runs both together; the loop
pipeline is documented in [the subagent pipeline doc](../docs/subagent-pipeline.md).
`bun run run:once` performs one **main-agent** loop:

1. Loads agent memory from the configured backend (local file or Walrus) and injects a summary into the prompt. When MemWal is enabled, relevant long-term memories are recalled and injected too.
2. Runs the **health guard** when borrows exist: if health factor is below `SUI_MIN_HEALTH_FACTOR`, auto-repay executes (or records a planned repay in dry-run) before the LLM loop.
3. Calls OpenAI with tools and the configured mission. `recall_memory` and `remember_insight` let the model read/write durable cross-session memory on demand.
4. Typical treasury cycle (when live): policy → memory → rate comparison → protocol positions → wallet balances → optimal allocation → optional supply/withdraw/borrow/repay on write-enabled lending protocols.
5. Idle USDC routing uses `get_optimal_allocation`, which compares write-enabled Suilend, NAVI, and Scallop USDC reserve curves and returns per-protocol supply legs for the model to execute with `lending_supply`.
6. Confirmed supply actions are recorded in memory; a `tweet_action` pending task is queued only when X posting is enabled and token-configured.
7. Local policy and memory idempotency block duplicate writes by cooldown. Pending legacy tweet tasks are ignored for treasury execution when X posting is disabled or unconfigured.
8. The model returns a final run summary; memory is saved for the next tick. On the Walrus backend, a Markdown run report is archived as a Walrus blob and a reflection is stored in MemWal.

For deployable autonomous operation:

```bash
bun run run:daemon
```

The daemon runs one loop every `AUTONOMY_INTERVAL_MS`. Use a process manager, Docker, Render, Fly.io, Railway, a VPS, or any Bun 1.3+ runtime.

## Safety Defaults

- `DRY_RUN=true`
- `SUI_NETWORK=testnet` (default)
- `ENABLE_SUI_POSITION_CREATION=false`
- `ENABLE_SUI_BORROW=false`

To let the agent create lending positions, you also need:

```bash
ENABLE_SUI_POSITION_CREATION=true
DRY_RUN=false
SUI_NETWORK=testnet
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
AGENT_SUI_PRIVATE_KEY=0x...   # or suiprivkey1...
AGENT_WALLET_ADDRESS=0x...  # must match derived address
SUI_ALLOWED_ASSETS=usdc
SUI_ALLOWED_PROTOCOLS=suilend,navi,scallop
ENABLE_SUILEND=true
ENABLE_NAVI=true
ENABLE_SCALLOP=true
ENABLE_NAVI_READS=true
ENABLE_SCALLOP_READS=true
SUI_USDC_COIN_TYPE=0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN
MIN_IDLE_USDC_RAW=5000000
SUI_MAX_SUPPLY_AMOUNT_RAW=10000000
```

Keep the allowed asset and protocol lists tight. This project is designed to approve and act only on explicitly allowlisted lending markets.

Derive your Sui address from the configured key:

```bash
bun run account:address
```

`AGENT_SUI_PRIVATE_KEY` must be a **hex private key** (`0x` + 64 hex chars) or a **`suiprivkey1…`** bech32 key — not a mnemonic or wallet address.

## Walrus Memory & Verifiable Storage

The agent can use [Walrus](https://walrus.xyz) as a verifiable data platform for its memory, giving it three properties a single local file can't: durability, portability across machines, and verifiability. Defaults target Walrus **testnet** and the MemWal **staging** relayer, so no funded wallet is required to demo.

There are two independent, additive layers:

### 1. Verifiable state persistence (raw Walrus blobs)

Switch the durable store from a local file to Walrus:

```bash
AGENT_MEMORY_BACKEND=walrus
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
WALRUS_STATE_EPOCHS=5
```

On every durable save the full agent state is uploaded as a content-addressed blob via the publisher HTTP API; the latest blob id is tracked in `data/walrus-pointer.json`. A local cache (`data/agent-state.json`) mirrors every write, so non-durable updates stay fast and any Walrus outage falls back to the cache without failing a run. Each run also archives a Markdown report blob (an artifact) whose URL is recorded in memory.

**Portability / restore demo:** copy the latest blob id (from the logs or `data/walrus-pointer.json`) onto a fresh machine and pin it — the agent rebuilds its full history from Walrus on the next run:

```bash
AGENT_MEMORY_BACKEND=walrus
WALRUS_STATE_BLOB_ID=<blob id from a previous machine>
bun run run:once
```

### 2. Semantic long-term memory (MemWal / Walrus Memory)

MemWal adds encrypted, verifiable, semantic memory the agent recalls across sessions.

1. Generate a delegate key:

```bash
bun run memwal:keygen
```

1. Create a MemWalAccount at `https://staging.memory.walrus.xyz` (testnet), register the printed delegate Sui address on it, and copy the account id.
2. Configure `.env`:

```bash
MEMWAL_ENABLED=true
MEMWAL_ACCOUNT_ID=0x...        # MemWalAccount object id
MEMWAL_DELEGATE_KEY=...        # hex private key from memwal:keygen (keep secret)
MEMWAL_RELAYER_URL=https://relayer-staging.memory.walrus.xyz
MEMWAL_NAMESPACE=defi-agent
```

When enabled, each run recalls relevant memories into the prompt and, after the run, analyzes/stores a reflection. The model can also call `recall_memory` and `remember_insight` directly. Memory is best-effort: if disabled or unreachable, the agent runs normally without it.

## Verification Checklist

1. `bun run doctor` — Sui key, address, RPC, protocol flags
2. `bun test` — unit tests pass
3. `bun run verify:allocation` — allocation solver returns expected protocol legs and APR math
4. **Testnet dry run:** `DRY_RUN=true SUI_NETWORK=testnet bun run run:once`
5. **Testnet live (tiny caps):** supply → withdraw → borrow → repay on each enabled protocol, with digests on suiscan testnet
6. **Health guard:** borrow near limit → confirm auto-repay when HF drops

## OpenAI

This project runs TypeScript directly on Bun and calls the OpenAI Responses API directly with `fetch`, so it has no SDK dependency. Required:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
```

The model receives function tools for DeFi reads and bounded actions. Tool execution remains controlled by local code.