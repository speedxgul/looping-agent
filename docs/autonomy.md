# Autonomy Model

This agent uses an OpenAI model as the planner and local JavaScript functions as tools.

## Loop

1. Build a prompt from mission, wallet, and current safety flags.
2. Send the prompt and tool definitions to OpenAI.
3. Execute model-requested tool calls locally.
4. Send tool outputs back to the model.
5. Repeat until the model returns a final summary or `MAX_TOOL_ROUNDS` is reached.

## Tools

Current tools (see `src/core/toolRegistry.ts`):

- `inspect_runtime_policy` — runtime safety flags and policy gates
- `get_agent_memory` — prior runs, deposits, pending tasks, snapshots, and recent Walrus artifacts
- `recall_memory` — semantic recall from Walrus Memory (MemWal)
- `remember_insight` — store a durable insight in Walrus Memory (MemWal)
- `get_fluid_positions` — current Fluid fToken positions for the wallet
- `get_fluid_markets` — live Fluid markets and APRs on Base
- `get_wallet_balances` — Base USDC/ETH balances and deposit hints
- `create_fluid_position` — bounded deposit into an allowlisted fToken
- `post_deposit_update` — post a confirmed deposit to X
- `get_swap_quote` — best-route swap quote (quote-only)
- `get_moltx_global_feed` — MoltX global social feed

The model cannot directly call arbitrary code. It only receives these tool definitions.

## Safety

The model can request actions, but policy is enforced locally:

- dry-run mode returns simulated success for allowed writes
- Fluid position creation requires `ENABLE_FLUID_POSITION_CREATION=true`, `DRY_RUN=false`, `BASE_RPC_URL`, `AGENT_PRIVATE_KEY`, and an allowlisted fToken
- Smart account execution uses `ACCOUNT_MODE=smart`, a Coinbase Smart Account on Base, and `SMART_ACCOUNT_BUNDLER_URL`
- X posting is gated by `ENABLE_X_POSTING` and only clears its pending task after X returns a post id
- swaps are quote-only in v1
- token launches are disabled in v1

Add new capabilities by adding a tool handler in `src/core/toolRegistry.ts`, then enforce policy in code before performing any write.
