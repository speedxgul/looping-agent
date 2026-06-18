# DeFi Agent v0

An extensible v1 scaffold for an autonomous DeFi agent. OpenAI decides what to do, and local tool adapters perform bounded DeFi actions:

- reads Fluid positions through `https://defi.moltx.io/positions`
- persists run history and deposit/tweet tasks in `data/agent-state.json`, or on **Walrus** as verifiable, portable blobs (see Walrus Memory & Verifiable Storage)
- can carry **long-term semantic memory** across sessions and machines via **MemWal (Walrus Memory)**
- reads Base wallet USDC/ETH balances and live Fluid APRs to pick allowlisted pools
- can create Fluid lending positions on Base when signer config and policy flags are enabled
- can post confirmed Fluid deposit updates to X when X posting is explicitly enabled
- gets optional best-route swap quotes through `https://swap.moltx.io/swap`
- keeps token-launch support as a separate adapter for later
- defaults to `DRY_RUN=true`, so it will not post or execute transactions unless explicitly enabled

This version does not require writing Solidity contracts. It is an off-chain agent that talks to existing protocols and APIs.

## Branches

- **`base/fluid`** — frozen snapshot of this Base/Fluid (EVM) agent. Use it to reference or run the EVM version.
- **`main`** — continues from the same codebase and is being evolved toward a **Sui-native** build. Expect the EVM execution layer to be swapped for the Sui TS SDK over time while the agent loop, memory, and tool-registry architecture stay the same.

## Quick Start

```bash
cp .env.example .env
# set OPENAI_API_KEY and AGENT_WALLET_ADDRESS in .env
bun run doctor
bun run run:once
```

Set `AGENT_WALLET_ADDRESS` before using live position checks.

## Project Shape

```text
src/
  clients/        MoltX, Fluid, swap, X, OpenAI, and Walrus (blob + MemWal) clients
  core/           autonomous agent loop, agent memory, memory store, policy, tools
  utils/          config, http, amounts, private key, logging helpers
scripts/
  memwal-keygen.ts   generate a MemWal delegate key
data/
  agent-state.json   local persistent memory / Walrus cache (gitignored)
  walrus-pointer.json latest Walrus state blob id (gitignored)
docs/
  architecture.md  layers and runtime notes
  autonomy.md      planner loop, tools, and safety model
  deployment.md    daemon and deployment notes
  moltx.md         endpoint notes from live skill files
```

## Current V1 Behavior

`bun run run:once` performs one autonomous loop:

1. Loads agent memory from the configured backend (local file or Walrus) and injects a summary into the prompt. When MemWal is enabled, relevant long-term memories are recalled and injected too.
2. Calls OpenAI with tools and the configured mission. `recall_memory` and `remember_insight` let the model read/write durable cross-session memory on demand.
3. Typical treasury cycle (when live): policy → memory → Fluid positions → markets (APRs) → wallet balances → optional deposit into top allowlisted fToken (e.g. fUSDC).
4. Confirmed deposits are recorded in memory; a `tweet_deposit` pending task is queued until `post_deposit_update` successfully posts to X.
5. Local policy and memory idempotency block duplicate deposits (pending tweet, cooldown).
6. The model returns a final run summary; memory is saved for the next tick. On the Walrus backend, a Markdown run report is archived as a Walrus blob and a reflection is stored in MemWal.

For deployable autonomous operation:

```bash
bun run run:daemon
```

The daemon runs one loop every `AUTONOMY_INTERVAL_MS`. Use a process manager, Docker, Render, Fly.io, Railway, a VPS, or any Bun 1.3+ runtime.

## Safety Defaults

- `DRY_RUN=true`
- `ENABLE_AUTONOMOUS_SWAPS=false`
- `ENABLE_FLUID_POSITION_CREATION=false`
- slippage and price impact checks are enforced before any future swap execution path

To let the agent create Fluid positions, you also need:

```bash
ENABLE_FLUID_POSITION_CREATION=true
DRY_RUN=false
ACCOUNT_MODE=smart
BASE_RPC_URL=https://...
AGENT_PRIVATE_KEY=0x...
SMART_ACCOUNT_BUNDLER_URL=https://...
FLUID_ALLOWED_FTOKENS=0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169
FLUID_USDC_FTOKEN=0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169
MIN_IDLE_USDC_RAW=5000000
FLUID_MAX_SUPPLY_AMOUNT_RAW=10000000
```

Keep the allowed fToken list tight. This project is designed to approve and deposit only into explicitly allowlisted Fluid markets. Set `FLUID_USDC_FTOKEN` so the model can use `market: usdc` on `create_fluid_position`.

When `ACCOUNT_MODE=smart`, `AGENT_PRIVATE_KEY` is the owner key and `AGENT_WALLET_ADDRESS` must be the derived Coinbase Smart Account address on Base. You can derive it with:

```bash
bun run account:address
```

`AGENT_PRIVATE_KEY` must be a **hex private key** (`0x` + 64 hex chars), not a mnemonic or wallet address. If you only have a seed phrase:

```bash
bun derive-key.ts "your twelve or twenty four words here"
```

Use the `privateKey` for the path whose `address` matches `AGENT_WALLET_ADDRESS`.

## X Posting

`post_deposit_update` posts text-only deposit updates to X API v2 and clears the pending `tweet_deposit` task only after X returns a post id. This is gated separately from `DRY_RUN`.

```bash
ENABLE_X_POSTING=true
X_API_BASE=https://api.x.com
X_USER_ACCESS_TOKEN=...
```

`X_USER_ACCESS_TOKEN` must be a preissued user-context access token for the X account that should post, with permission to create posts. This project does not implement OAuth 1.0a or OAuth 2.0 PKCE token issuance in v1.

If `ENABLE_X_POSTING=false`, the token is missing, or the X API call fails, the pending task remains in memory so the agent cannot make another deposit until posting is configured or succeeds.

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

2. Create a MemWalAccount at `https://staging.memory.walrus.xyz` (testnet), register the printed delegate Sui address on it, and copy the account id.
3. Configure `.env`:

```bash
MEMWAL_ENABLED=true
MEMWAL_ACCOUNT_ID=0x...        # MemWalAccount object id
MEMWAL_DELEGATE_KEY=...        # hex private key from memwal:keygen (keep secret)
MEMWAL_RELAYER_URL=https://relayer-staging.memory.walrus.xyz
MEMWAL_NAMESPACE=defi-agent
```

When enabled, each run recalls relevant memories into the prompt and, after the run, analyzes/stores a reflection. The model can also call `recall_memory` and `remember_insight` directly. Memory is best-effort: if disabled or unreachable, the agent runs normally without it.

## OpenAI

This project runs TypeScript directly on Bun and calls the OpenAI Responses API directly with `fetch`, so it has no SDK dependency. Required:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
```

The model receives function tools for DeFi reads and bounded actions. Tool execution remains controlled by local code.
