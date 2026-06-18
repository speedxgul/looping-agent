# Autonomy Model

This agent uses an OpenAI model as the planner and local JavaScript functions as tools.

## Loop

1. Load agent memory and inject a summary (plus MemWal recall when enabled).
2. Run the **health guard** when active borrows exist — auto-repay on Suilend if health factor is critical.
3. Build a prompt from mission, wallet, and current safety flags.
4. Send the prompt and tool definitions to OpenAI.
5. Execute model-requested tool calls locally.
6. Send tool outputs back to the model.
7. Repeat until the model returns a final summary or `MAX_TOOL_ROUNDS` is reached.

## Tools

Current tools (see `src/core/toolRegistry.ts`):

- `inspect_runtime_policy` — runtime safety flags and policy gates
- `get_agent_memory` — prior runs, position actions, pending tasks, snapshots, and recent Walrus artifacts
- `recall_memory` — semantic recall from Walrus Memory (MemWal)
- `remember_insight` — store a durable insight in Walrus Memory (MemWal)
- `get_sui_balances` — Sui USDC/SUI balances and supply hints
- `get_suilend_markets` — Suilend reserves ranked by supply APR
- `get_suilend_obligation` — deposits, borrows, and health factor
- `get_lending_rates_comparison` — Suilend vs NAVI vs Scallop APR rows
- `suilend_supply` / `suilend_withdraw` / `suilend_borrow` / `suilend_repay` — bounded Suilend writes
- `post_action_update` — post a confirmed supply to X (`post_deposit_update` alias retained)
- `get_swap_quote` — best-route swap quote (EVM-only; disabled by default on Sui)
- `get_moltx_global_feed` — MoltX global social feed

The model cannot directly call arbitrary code. It only receives these tool definitions.

## Safety

The model can request actions, but policy is enforced locally:

- dry-run mode returns simulated success for allowed writes and records planned actions
- Suilend writes require `SUI_ENABLED=true`, matching RPC/key config, and allowlisted assets
- supply additionally requires `ENABLE_SUI_POSITION_CREATION=true` and `DRY_RUN=false`
- borrow requires `SUI_ENABLE_BORROW=true` and projected health factor ≥ `SUI_MIN_HEALTH_FACTOR`
- health guard auto-repay runs before the LLM when borrows exist and HF is critical
- X posting is gated by `ENABLE_X_POSTING` and only clears its pending task after X returns a post id
- swaps are quote-only in v1 (and off by default on Sui)
- cross-protocol rebalancing is out of scope — writes stay on Suilend

Add new capabilities by adding a tool handler in `src/core/toolRegistry.ts`, then enforce policy in code before performing any write.
