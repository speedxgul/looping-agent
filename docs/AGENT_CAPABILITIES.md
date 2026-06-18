# Agent Capabilities

A concise reference of everything the autonomous DeFi agent can do today.

## Overview

`defi-agent-v0` is an autonomous DeFi operations agent for the **Base** chain. Each run, an OpenAI model is given the agent's mission, current config, and persistent memory, then drives a tool-calling loop to observe wallet/market state and optionally act (deposit into Fluid lending, post a status update to X). Every action is gated by local safety policy and a dry-run switch.

- **Entry point:** `src/index.ts`
- **Brain / loop:** `src/core/autonomousAgent.ts`
- **Tools:** `src/core/toolRegistry.ts`
- **Safety policy:** `src/core/policy.ts`
- **Persistent memory:** `src/core/agentMemory.ts`

## Run Modes (CLI)

| Command | Behavior |
|---|---|
| `run-once` (default) | Executes a single autonomous cycle and prints the model's summary. |
| `run-daemon` | Runs `run-once` on a loop every `AUTONOMY_INTERVAL_MS` (default 15 min); skips a tick if the prior one is still running. |
| `doctor` | Prints resolved config and warns about missing/misconfigured settings (RPC, keys, flags). |
| `account:address` | Derives and prints the execution account address (EOA or smart account). |

## How a Cycle Works

1. Load persistent state from disk and start a new run record.
2. Build model instructions + a run prompt describing wallet, dry-run, and enabled flags.
3. Run a tool-calling loop (up to `MAX_TOOL_ROUNDS`, default 6). The model calls tools; results are fed back until it returns a final text summary or rounds are exhausted.
4. Record the run summary and persist state.

The model is instructed to operate conservatively: start with `inspect_runtime_policy`, read memory early, never claim an action executed unless a tool result confirms it, and respect all policy gates.

## Agent Tools

The model can only act through these tools:

| Tool | Type | Description |
|---|---|---|
| `inspect_runtime_policy` | read | Returns current safety policy, treasury thresholds, enabled flags, and memory summary. |
| `get_agent_memory` | read | Prior runs, deposits, pending tasks, and snapshots. |
| `get_fluid_positions` | read | Current Fluid lending positions for the configured wallet on Base. |
| `get_wallet_balances` | read | Base ETH + USDC balances, plus deposit hints (`canDeposit`, `depositableRaw`, suggested fUSDC market). |
| `get_fluid_markets` | read | Live Fluid fToken markets with APRs (supply, native rewards, total, optional staking/merkle), ranked by `totalApr`. |
| `get_swap_quote` | read | MoltX best-route swap quote across aggregators. **Quote only — never executes.** |
| `get_moltx_global_feed` | read | MoltX global social feed for context before posting. |
| `create_fluid_position` | **write** | Approve + supply USDC/WETH into a Fluid fToken. Gated by policy, balance checks, allowlist, cooldown, and pending-tweet state. |
| `post_deposit_update` | **write** | Post a status update about a confirmed live deposit to X. |

## Write Actions & Safety Gates

**`create_fluid_position`** is only allowed when ALL of the following hold:
- `DRY_RUN=false`, `ENABLE_FLUID_LENDING=true`, `ENABLE_FLUID_POSITION_CREATION=true`
- `BASE_RPC_URL` and `AGENT_PRIVATE_KEY` are set (plus bundler URL if `ACCOUNT_MODE=smart`)
- fToken is in `FLUID_ALLOWED_FTOKENS` allowlist
- `0 < rawAmount <= FLUID_MAX_SUPPLY_AMOUNT_RAW`
- Wallet USDC balance is at/above `MIN_IDLE_USDC_RAW` and covers the amount
- No `tweet_deposit` task is pending and the fToken isn't within the `DEPOSIT_COOLDOWN_MS` window

In dry-run, the deposit is recorded as `planned` and no transaction is sent. On a confirmed live deposit, memory automatically queues a `tweet_deposit` task.

**`post_deposit_update`** only posts when the target deposit is a confirmed live (non-dry-run) deposit, `ENABLE_X_POSTING=true`, and `X_USER_ACCESS_TOKEN` is set. Default text summarizes the supplied amount, market, APR, and tx link; success/failure is recorded and the pending task is cleared on success.

`get_swap_quote` exists, but there is **no swap execution tool** — the agent cannot perform swaps even though `ENABLE_AUTONOMOUS_SWAPS` exists in config/policy.

## Treasury Mode

When `DRY_RUN=false` + Fluid lending + position creation are all enabled, the agent runs in **treasury mode**: it actively looks to deposit idle USDC into the highest-APR allowlisted market (usually fUSDC), capped by `FLUID_MAX_SUPPLY_AMOUNT_RAW`, then attempts to post the deposit update. Otherwise it stays in read-only **monitoring mode**.

## Persistent Memory

State is stored as JSON (`AGENT_STATE_PATH`, default `data/agent-state.json`) and survives across runs. It tracks runs (last 50), deposits (last 100), tweets (last 50), pending tasks, and snapshots (last positions, USDC balance, top market). State resets if the configured wallet address changes. This memory enforces deduplication, deposit cooldown, and the deposit-then-tweet workflow.

## External Integrations

- **OpenAI Responses API** — model reasoning and tool calling (`OPENAI_MODEL`, default `gpt-5.1`).
- **Fluid (Instadapp)** — lending markets/positions data and on-chain supply execution on Base (EOA or Coinbase smart account).
- **MoltX** — swap quotes (`swap.moltx.io`), DeFi data (`defi.moltx.io`), and social feed.
- **X (Twitter) API** — posting deposit status updates.

## Key Configuration Flags

| Variable | Default | Purpose |
|---|---|---|
| `DRY_RUN` | `true` | Master switch; no write actions execute when true. |
| `ENABLE_FLUID_LENDING` | `true` | Allow Fluid reads/policy. |
| `ENABLE_FLUID_POSITION_CREATION` | `true` | Allow Fluid deposits. |
| `ENABLE_SWAP_QUOTES` | `true` | Allow swap quoting. |
| `ENABLE_AUTONOMOUS_SWAPS` | `true` | Policy flag (no execution path exists yet). |
| `ENABLE_X_POSTING` | `false` | Allow posting to X. |
| `MIN_IDLE_USDC_RAW` | `5000000` | Min USDC (raw) before depositing. |
| `FLUID_MAX_SUPPLY_AMOUNT_RAW` | `10000000` | Max single deposit (raw). |
| `DEPOSIT_COOLDOWN_MS` | `86400000` | Cooldown between deposits to same market. |
| `MAX_TOOL_ROUNDS` | `6` | Max tool-call rounds per cycle. |
| `AUTONOMY_INTERVAL_MS` | `900000` | Daemon loop interval. |
| `ACCOUNT_MODE` | `eoa` | `eoa` or `smart` (Coinbase smart account). |
