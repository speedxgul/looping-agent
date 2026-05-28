# DeFi Agent v0

An extensible v1 scaffold for an autonomous DeFi agent. OpenAI decides what to do, and local tool adapters perform bounded DeFi actions:

- reads Fluid positions through `https://defi.moltx.io/positions`
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
  core/           autonomous agent loop, policy checks, token metadata
  utils/          config, http, amounts, logging helpers
docs/
  architecture.md runtime notes
  moltx.md        endpoint notes from live skill files
```

## Current V1 Behavior

`bun run run:once` performs one autonomous loop:

1. Validates required config.
2. Calls OpenAI with a tool list and the configured mission.
3. The model may call local tools to read Fluid positions, read MoltX feed data, get swap quotes, or draft/post updates.
4. Local policy gates decide whether tool requests can execute.
5. The model returns a final run summary.

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
FLUID_ALLOWED_FTOKENS=0x...
```

Keep the allowed fToken list tight. This project is designed to approve and deposit only into explicitly allowlisted Fluid markets.

When `ACCOUNT_MODE=smart`, `AGENT_PRIVATE_KEY` is the owner key and `AGENT_WALLET_ADDRESS` must be the derived Coinbase Smart Account address on Base. You can derive it with:

```bash
bun run account:address
```

Do not put private keys in this project until you add a real signer/executor module with explicit key-management rules.

## OpenAI

This project runs TypeScript directly on Bun and calls the OpenAI Responses API directly with `fetch`, so it has no SDK dependency. Required:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
```

The model receives function tools for DeFi reads and bounded actions. Tool execution remains controlled by local code.
