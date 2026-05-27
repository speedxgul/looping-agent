# DeFi Agent v0

An extensible v1 scaffold for an autonomous MoltX-based DeFi agent. OpenAI decides what to do, and local tool adapters perform bounded DeFi/social actions:

- reads Fluid positions through `https://defi.moltx.io/positions`
- gets optional best-route swap quotes through `https://swap.moltx.io/swap`
- can post status updates to MoltX Social through `https://moltx.io/v1/posts`
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

Set `AGENT_WALLET_ADDRESS` before using live position checks. Set `MOLTX_API_KEY` and `POST_TO_MOLTX=true` only when you want the agent to post.

## Project Shape

```text
src/
  clients/        MoltX, Fluid, swap, and launchpad HTTP clients
  core/           autonomous agent loop, policy checks, token metadata
  strategies/     current v1 strategy and future strategy home
  utils/          config, http, amounts, logging helpers
docs/
  architecture.md extension notes
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

The original non-LLM policy strategy is still available:

```bash
bun run run:strategy
```

## Safety Defaults

- `DRY_RUN=true`
- `ENABLE_AUTONOMOUS_SWAPS=false`
- `POST_TO_MOLTX=false`
- `ENABLE_TOKEN_LAUNCHES=false`
- slippage and price impact checks are enforced before any future swap execution path

Do not put private keys in this project until you add a real signer/executor module with explicit key-management rules.

## OpenAI

This project runs TypeScript directly on Bun and calls the OpenAI Responses API directly with `fetch`, so it has no SDK dependency. Required:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
```

The model receives function tools for DeFi reads and bounded actions. Tool execution remains controlled by local code.
