# Autonomy Model

The agent has **two decision engines** that share one enforcement layer:

1. **Main agent** — an OpenAI model plans and calls local JavaScript tools.
2. **Subagent pipeline** — six deterministic roles cooperate through a shared ledger
   to run yield loops with **no LLM in the fund-moving path**. See
   [`subagent-pipeline.md`](subagent-pipeline.md).

This document covers the **main agent** loop and its tools. The two run together under
the supervisor (`bun run run:supervisor`); the main agent alone runs with
`bun run run:once` / `run:daemon`.

## Main-agent loop

1. Load agent memory and inject a summary (plus MemWal recall when enabled).
2. Run the **health guard** when active borrows exist — auto-repay the largest borrow
   on the relevant protocol if health factor is critical.
3. Build a prompt from mission, wallet, and current safety flags.
4. Send the prompt and tool definitions to OpenAI.
5. Execute model-requested tool calls locally (each write passes policy first).
6. Send tool outputs back to the model.
7. Repeat until the model returns a final summary or `MAX_TOOL_ROUNDS` is reached.

## Tools

Current tools (see `src/core/toolRegistry.ts`):

**Read / context**
- `inspect_runtime_policy` — runtime safety flags and policy gates
- `get_agent_memory` — prior runs, position actions, pending tasks, snapshots, artifacts
- `recall_memory` — semantic recall from Walrus Memory (MemWal)
- `remember_insight` — store a durable insight in Walrus Memory (MemWal)
- `get_sui_balances` — Sui USDC/SUI balances and supply hints
- `get_suilend_markets` — Suilend reserves ranked by supply APR
- `get_suilend_obligation` — Suilend deposits, borrows, and health factor
- `get_lending_positions` — normalized positions across Suilend / NAVI / Scallop
- `get_lending_rates_comparison` — Suilend vs NAVI vs Scallop APR rows

**Allocation / strategy**
- `get_best_supply_target` — single best-yield allowlisted supply target
- `get_optimal_allocation` — own-impact-aware allocation across write-enabled protocols
- `get_strategy_ledger` — current state of the subagent pipeline (proposals, plans, receipts)
- `propose_strategy_plan` — submit a loop proposal into the strategy ledger
- `claim_and_execute_strategy_plan` — claim and execute an accepted loop plan (same validator/executor the subagents use)

**Bounded writes** (route by protocol through the shared client interface)
- `lending_supply` / `lending_withdraw` / `lending_borrow` / `lending_repay`

**Posting**
- `post_action_update` — post a confirmed supply to X (`post_deposit_update` alias retained)

The model cannot directly call arbitrary code. It only receives these tool
definitions, and every write is enforced in local code before it runs.

## Safety

The model can request actions, but policy is enforced locally:

- dry-run mode returns simulated success for allowed writes and records planned actions
- lending writes require `SUI_ENABLED=true`, matching RPC/key config, the protocol's
  `write` flag, membership in `SUI_ALLOWED_PROTOCOLS`, and allowlisted assets
- supply additionally requires `ENABLE_SUI_POSITION_CREATION=true` and `DRY_RUN=false`
- borrow requires `SUI_ENABLE_BORROW=true` and projected health factor ≥ `SUI_MIN_HEALTH_FACTOR`
- the health guard auto-repays before the LLM loop when borrows exist and HF is critical
- loop execution additionally requires `LOOP_EXECUTION_ENABLED=true`, and the same
  two-stage deterministic policy gate as the subagent pipeline
- X posting is gated by `ENABLE_X_POSTING` and only clears its pending task after X
  returns a post id
- swaps are quote-only (and off by default on Sui)

Add new capabilities by adding a tool handler in `src/core/toolRegistry.ts`, then
enforce policy in code before performing any write.
