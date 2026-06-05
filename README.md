# DeFi Agent v0

An extensible v1 scaffold for an autonomous DeFi agent. OpenAI decides what to do, and local tool adapters perform bounded DeFi actions:

- reads Fluid positions through `https://defi.moltx.io/positions`
- persists run history and deposit/tweet tasks in `data/agent-state.json` (see agent memory)
- reads Base wallet USDC/ETH balances and live Fluid APRs to pick allowlisted pools
- can create Fluid lending positions on Base when signer config and policy flags are enabled
- gets optional best-route swap quotes through `https://swap.moltx.io/swap`
- keeps token-launch support as a separate adapter for later
- defaults to `DRY_RUN=true`, so it will not post or execute transactions unless explicitly enabled

This version does not require writing Solidity contracts. It is an off-chain agent that talks to existing protocols and APIs.

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
  clients/        MoltX, Fluid, swap, and signing clients
  core/           autonomous agent loop, agent memory, policy, tools
  utils/          config, http, amounts, logging helpers
data/
  agent-state.json   persistent memory (gitignored)
docs/
  architecture.md runtime notes
  moltx.md        endpoint notes from live skill files
```

## Current V1 Behavior

`bun run run:once` performs one autonomous loop:

1. Loads agent memory from `AGENT_STATE_PATH` and injects a summary into the prompt.
2. Calls OpenAI with tools and the configured mission.
3. Typical treasury cycle (when live): policy → memory → Fluid positions → markets (APRs) → wallet balances → optional deposit into top allowlisted fToken (e.g. fUSDC).
4. Confirmed deposits are recorded in memory; a `tweet_deposit` pending task is queued until `post_deposit_update` is implemented.
5. Local policy and memory idempotency block duplicate deposits (pending tweet, cooldown).
6. The model returns a final run summary; memory is saved for the next tick.

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

## OpenAI

This project runs TypeScript directly on Bun and calls the OpenAI Responses API directly with `fetch`, so it has no SDK dependency. Required:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
```

The model receives function tools for DeFi reads and bounded actions. Tool execution remains controlled by local code.
